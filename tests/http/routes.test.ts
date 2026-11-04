import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { currentStage } from '../../src/data/repositories/dispositions.ts'
import { addPostings } from '../../src/data/repositories/postings.ts'
import { addRegistryRows, archiveRegistryRow } from '../../src/data/repositories/registries.ts'
import { recordOrigin } from '../../src/data/repositories/provenance.ts'
import { scorePosting } from '../../src/data/repositories/scores.ts'
import { writeSummary } from '../../src/data/repositories/summaries.ts'
import { addText } from '../../src/data/repositories/texts.ts'
import { mountRoutes, ROUTES } from '../../src/http/routes/index.ts'
import { ALL_TOOLS } from '../../src/mcp/tools/index.ts'
import { PostingGetQuerySchema, PostingRefSchema } from '../../src/schemas/postings.ts'
import { PostingScoresQuerySchema } from '../../src/schemas/scores.ts'
import { archiveCriteriaSetForTest, arrangeSet } from '../mcp/tools/criteria-arrangement.ts'
import { idOf, untouchableDb, useSharedScratchDatabase } from '../mcp/tools/harness.ts'
import { startTestServer, type HttpOutcome, type TestServer } from './harness.ts'

const database = useSharedScratchDatabase()

let probe: TestServer
let live: TestServer

beforeAll(async () => {
  // The probe's database fails the test if it is touched: a probe the schema refuses never reaches it.
  probe = await startTestServer((app) => mountRoutes(app, untouchableDb()))
  live = await startTestServer((app) => mountRoutes(app, database()))
})

afterAll(async () => {
  await Promise.all([probe.close(), live.close()])
})

/** The route table of the brief (§11.2), copied here so a route added or dropped fails a test. */
const BRIEF_TABLE: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  ['GET', '/api/postings', ['posting_search']],
  ['GET', '/api/postings/:id', ['posting_get']],
  ['PATCH', '/api/postings/:id', ['posting_update']],
  ['GET', '/api/postings/:id/summary', ['summary_get']],
  ['GET', '/api/postings/:id/scores', ['score_history']],
  ['GET', '/api/postings/:id/best-scores', ['score_best']],
  ['POST', '/api/postings/:id/stage', ['stage_append']],
  ['POST', '/api/postings/:id/disposition', ['posting_set_aside', 'posting_reject']],
  ['GET', '/api/postings/:id/origins', ['origin_list']],
  ['GET', '/api/set-aside', ['set_aside_list']],
  ['GET', '/api/criteria-sets', ['criteria_sets']],
  ['POST', '/api/criteria-sets', ['criteria_version_create']],
  ['GET', '/api/criteria-sets/:id/requirements', ['criteria_requirements']],
  ['PATCH', '/api/criteria-sets/:id/requirements/:requirementId', ['criteria_requirement_update']],
  ['PUT', '/api/criteria-sets/:id/default', ['criteria_set_default']],
  ['GET', '/api/config/mode', ['criteria_mode_get']],
  ['PUT', '/api/config/mode', ['criteria_mode_set']],
  ['POST', '/api/rescore-requests', ['rescore_request']],
  ['GET', '/api/rescore-requests/pending', ['rescore_pending']],
  ['GET', '/api/registries/:name', ['registry_list']],
  ['POST', '/api/registries/:name', ['registry_add']],
  ['PATCH', '/api/registries/:name/:id', ['registry_archive']],
  ['GET', '/api/texts', ['text_list']],
]

/** A parameter's name is invisible to a client, so two paths are the same route when their shapes are. */
const shapeOf = (path: string): string => path.replace(/:[A-Za-z]+/g, ':')

const concrete = (path: string): string => path.replace(/:[A-Za-z]+/g, '1')

const toolNamed = (name: string): (typeof ALL_TOOLS)[number] => {
  const found = ALL_TOOLS.find((tool) => tool.name === name)
  if (!found) throw new Error(`no tool is named ${name}`)
  return found
}

const dataOf = (outcome: HttpOutcome): unknown => (outcome.body as { data: unknown }).data
const errorOf = (outcome: HttpOutcome): { name: string; message: string } => (outcome.body as { error: { name: string; message: string } }).error

describe('the route table', () => {
  test('mounts exactly the 23 routes of the table, at the same methods and paths', () => {
    const mounted = ROUTES.map((spec) => `${spec.method.toUpperCase()} /api${shapeOf(spec.path)}`).sort()
    const table = BRIEF_TABLE.map(([method, path]) => `${method} ${shapeOf(path)}`).sort()

    expect(ROUTES).toHaveLength(23)
    expect(mounted).toEqual(table)
  })

  test('each route names the tool or tools the table says it mirrors', () => {
    for (const [method, path, tools] of BRIEF_TABLE) {
      const spec = ROUTES.find((candidate) => `${candidate.method.toUpperCase()} /api${shapeOf(candidate.path)}` === `${method} ${shapeOf(path)}`)
      expect(spec?.tools).toEqual(tools)
    }
  })

  test('every route is reachable: none answers 404 for its own path, and a refused request never reaches the database', async () => {
    for (const [method, path] of BRIEF_TABLE) {
      const asked = method === 'GET' ? `${concrete(path)}?__probe=1` : concrete(path)

      const outcome = await probe.request(method, asked, method === 'GET' ? undefined : { __probe: 1 })

      // A route Express does not know answers an HTML 404; one that is mounted answers the JSON envelope.
      expect({ route: `${method} ${path}`, status: outcome.status }).toEqual({ route: `${method} ${path}`, status: 400 })
      expect(outcome.body).toMatchObject({ success: false, error: { name: 'ValidationError' } })
    }
  })

  test('every route shares its tool schema by identity, not by equality', () => {
    let checked = 0
    for (const spec of ROUTES) {
      expect(spec.schemas).toHaveLength(spec.tools.length)
      for (const [index, toolName] of spec.tools.entries()) {
        expect(spec.schemas[index]).toBe(toolNamed(toolName).input)
        checked += 1
      }
    }

    // 23 routes, and the disposition route mirrors two tools.
    expect(checked).toBe(24)
  })

  test('two routes may share one schema because two tools do: the summary and origin reads, and the score reads', () => {
    const schemaOf = (tool: string): unknown => ROUTES.find((spec) => spec.tools.includes(tool))?.schemas[0]

    expect(schemaOf('summary_get')).toBe(PostingRefSchema)
    expect(schemaOf('origin_list')).toBe(PostingRefSchema)
    // posting_get takes a scale, which a read with no score in it must not.
    expect(schemaOf('posting_get')).toBe(PostingGetQuerySchema)
    expect(schemaOf('score_history')).toBe(PostingScoresQuerySchema)
    expect(schemaOf('score_best')).toBe(PostingScoresQuerySchema)
  })

  test('answers without any credential, because the key check is mounted by the server entry and not here', async () => {
    const outcome = await live.request('GET', '/api/set-aside')

    expect(outcome.status).toBe(200)
  })
})

async function newPostingId(title: string, seenAt?: string): Promise<number> {
  return idOf(await addPostings(database(), [{ company: { name: `${title} Co` }, roleTitle: title, ...(seenAt ? { seenAt } : {}) }]))
}

describe('the posting routes', () => {
  test('GET /api/postings lists postings and takes filters beside pagination', async () => {
    const first = await newPostingId('Listed one')
    const second = await newPostingId('Listed two')

    const listed = await live.request('GET', '/api/postings')
    const paged = await live.request('GET', '/api/postings?limit=1&setAside=include')

    const ids = (dataOf(listed) as Array<{ posting: { id: number } }>).map((row) => row.posting.id)
    expect(ids).toEqual(expect.arrayContaining([first, second]))
    expect(dataOf(paged)).toHaveLength(1)
  })

  test('GET /api/postings refuses an unknown filter and an out-of-range page, naming each', async () => {
    const unknown = await live.request('GET', '/api/postings?limit=1&bogus=1')
    const range = await live.request('GET', '/api/postings?limit=0')

    expect([unknown.status, range.status]).toEqual([400, 400])
    expect(errorOf(unknown).message).toContain('bogus')
    expect(errorOf(range).message).toContain('limit')
  })

  test('GET and PATCH /api/postings/:id read and change one posting', async () => {
    const id = await newPostingId('Patched')

    const patched = await live.request('PATCH', `/api/postings/${id}`, { patch: { city: 'Lisbon' } })
    const read = await live.request('GET', `/api/postings/${id}`)

    expect(patched.status).toBe(200)
    expect(dataOf(patched)).toMatchObject({ id, city: 'Lisbon' })
    expect(dataOf(read)).toMatchObject({ posting: { id, city: 'Lisbon', roleTitle: 'Patched' } })
  })

  test('an unknown posting is a 404 and a malformed id is a 400 naming postingId', async () => {
    const missing = await live.request('GET', '/api/postings/999999')
    const malformed = await live.request('GET', '/api/postings/abc')

    expect(missing.status).toBe(404)
    expect(errorOf(missing)).toEqual({ name: 'NotFoundError', message: 'posting 999999 does not exist' })
    expect(malformed.status).toBe(400)
    expect(errorOf(malformed).message).toContain('postingId')
  })

  test('a patch that names the posting again in its body is refused instead of retargeting the path', async () => {
    const target = await newPostingId('Path target')
    const other = await newPostingId('Body target')

    const outcome = await live.request('PATCH', `/api/postings/${target}`, { postingId: other, patch: { city: 'Porto' } })
    const untouched = await live.request('GET', `/api/postings/${other}`)

    expect(outcome.status).toBe(400)
    expect(errorOf(outcome).message).toContain('postingId')
    expect(dataOf(untouched)).toMatchObject({ posting: { city: null } })
  })

  test('GET /api/postings/:id/summary returns the summary, and null before one is written', async () => {
    const id = await newPostingId('Summarised')
    const before = await live.request('GET', `/api/postings/${id}/summary`)
    await writeSummary(database(), { postingId: id, condensed: 'A condensed posting', sourceHash: 'hash-1' })

    const after = await live.request('GET', `/api/postings/${id}/summary`)

    expect(dataOf(before)).toBeNull()
    expect(dataOf(after)).toMatchObject({ postingId: id, condensed: 'A condensed posting' })
  })

  test('GET /api/postings/:id/origins lists the touches of one posting', async () => {
    const id = await newPostingId('Touched')
    await recordOrigin(database(), { postingId: id, touchedOn: '2026-05-01', note: 'a referral' })

    const outcome = await live.request('GET', `/api/postings/${id}/origins`)

    expect(dataOf(outcome)).toEqual([expect.objectContaining({ postingId: id, note: 'a referral' })])
  })
})

describe('the score routes', () => {
  test('GET scores and best-scores read the history and the latest score per set', async () => {
    const id = await newPostingId('Scored')
    const { setId, requirementId } = await arrangeSet(database(), 'Score set')
    await scorePosting(database(), {
      postingId: id,
      criteriaSetId: setId,
      ratings: [{ requirementId, coverage: 1, confidence: 'supported' }],
      penalties: [],
    })

    const history = await live.request('GET', `/api/postings/${id}/scores`)
    const best = await live.request('GET', `/api/postings/${id}/best-scores`)

    expect(dataOf(history)).toEqual([expect.objectContaining({ postingId: id, criteriaSetId: setId })])
    expect(dataOf(best)).toEqual([expect.objectContaining({ postingId: id, criteriaSetId: setId })])
  })

  test('the score reads, the posting reads and the set list take scale from the query string', async () => {
    const id = await newPostingId('Scaled route')
    const { setId, requirementId } = await arrangeSet(database(), 'Scaled route set')
    await scorePosting(database(), {
      postingId: id,
      criteriaSetId: setId,
      ratings: [{ requirementId, coverage: 1, confidence: 'supported' }],
      penalties: [],
    })
    const companyId = (dataOf(await live.request('GET', `/api/postings/${id}`)) as { company: { id: number } }).company.id

    const history = await live.request('GET', `/api/postings/${id}/scores?scale=percent`)
    const best = await live.request('GET', `/api/postings/${id}/best-scores?scale=percent`)
    const detail = await live.request('GET', `/api/postings/${id}?scale=percent`)
    const search = await live.request('GET', `/api/postings?companyId=${companyId}&criteriaSetId=${setId}&scale=percent`)
    const sets = await live.request('GET', '/api/criteria-sets?scale=percent')

    const shown = { overall: 100, recommendApply: true }
    expect(dataOf(history)).toEqual([expect.objectContaining(shown)])
    expect(dataOf(best)).toEqual([expect.objectContaining(shown)])
    expect((dataOf(detail) as { scores: Array<{ score: unknown }> }).scores[0]?.score).toMatchObject(shown)
    expect((dataOf(search) as Array<{ score: unknown }>)[0]?.score).toMatchObject(shown)
    expect((dataOf(sets) as Array<{ id: number; applyThreshold: number }>).find((set) => set.id === setId)?.applyThreshold).toBe(50)
  })

  test('POST /api/rescore-requests records a request and GET /pending lists the posting waiting under it', async () => {
    const id = await newPostingId('Waiting', '2026-06-01')
    const { setId } = await arrangeSet(database(), 'Rescore set')

    const requested = await live.request('POST', '/api/rescore-requests', { criteriaSetId: setId, sinceDate: '2026-01-01' })
    const requestId = (dataOf(requested) as { id: number }).id
    const pending = await live.request('GET', `/api/rescore-requests/pending?rescoreRequestId=${requestId}`)

    expect(requested.status).toBe(200)
    expect(dataOf(pending)).toEqual(expect.arrayContaining([{ rescoreRequestId: requestId, postingId: id, criteriaSetId: setId }]))
  })

  test('a rescore request for a set that does not exist is a 404, and a bad date is a 400 naming sinceDate', async () => {
    const missing = await live.request('POST', '/api/rescore-requests', { criteriaSetId: 999_999, sinceDate: '2026-01-01' })
    const badDate = await live.request('POST', '/api/rescore-requests', { criteriaSetId: 1, sinceDate: 'yesterday' })

    expect(missing.status).toBe(404)
    expect(badDate.status).toBe(400)
    expect(errorOf(badDate).message).toContain('sinceDate')
  })
})

describe('the stage and disposition routes', () => {
  test('POST /api/postings/:id/stage appends an event and returns the new current stage', async () => {
    const id = await newPostingId('Staged')
    const stageId = idOf(await addRegistryRows(database(), 'stage', [{ key: 'staged-1', label: 'Staged 1' }]))

    const outcome = await live.request('POST', `/api/postings/${id}/stage`, { stageId, note: 'Sent the form' })
    const current = await currentStage(database(), id)

    expect(outcome.status).toBe(200)
    expect(dataOf(outcome)).toMatchObject({ postingId: id, stageId, note: 'Sent the form' })
    expect(current?.event.id).toBe((dataOf(outcome) as { id: number }).id)
    expect(current?.stage.id).toBe(stageId)
  })

  test('a stage event needs a stageId, which may be null, and a posting that exists', async () => {
    const id = await newPostingId('Stage rules')
    const archived = idOf(await addRegistryRows(database(), 'stage', [{ key: 'retired-stage', label: 'Retired stage' }]))
    await archiveRegistryRow(database(), 'stage', archived)

    const nullStage = await live.request('POST', `/api/postings/${id}/stage`, { stageId: null })
    const missingField = await live.request('POST', `/api/postings/${id}/stage`, {})
    const unknownPosting = await live.request('POST', '/api/postings/999999/stage', { stageId: null })
    const archivedStage = await live.request('POST', `/api/postings/${id}/stage`, { stageId: archived })

    expect(dataOf(nullStage)).toMatchObject({ postingId: id, stageId: null })
    expect([missingField.status, unknownPosting.status, archivedStage.status]).toEqual([400, 404, 409])
    expect(errorOf(missingField).message).toContain('stageId')
    expect(errorOf(archivedStage).message).toBe(`stage ${archived} is archived`)
  })

  test('POST /disposition with a setAsideReasonId serves posting_set_aside', async () => {
    const id = await newPostingId('Set aside by route')
    const reasonId = idOf(await addRegistryRows(database(), 'set_aside_reason', [{ label: 'Too far' }]))

    const outcome = await live.request('POST', `/api/postings/${id}/disposition`, { setAsideReasonId: reasonId, note: 'Two hours away' })
    const listed = await live.request('GET', '/api/set-aside')

    expect(dataOf(outcome)).toMatchObject({ postingId: id, setAsideReasonId: reasonId, note: 'Two hours away' })
    const groups = dataOf(listed) as Array<{ reasonId: number; postings: Array<{ posting: { id: number } }> }>
    expect(groups.find((group) => group.reasonId === reasonId)?.postings.map((row) => row.posting.id)).toEqual([id])
  })

  test('POST /disposition with a rejectionReasonId serves posting_reject', async () => {
    const id = await newPostingId('Rejected by route')
    const reasonId = idOf(await addRegistryRows(database(), 'rejection_reason', [{ label: 'No fit' }]))

    const outcome = await live.request('POST', `/api/postings/${id}/disposition`, { rejectionReasonId: reasonId })

    expect(dataOf(outcome)).toMatchObject({ postingId: id, rejectionReasonId: reasonId, setAsideReasonId: null })
  })

  test('POST /disposition refuses a body with both reasons or with neither, naming the two fields', async () => {
    const id = await newPostingId('Ambiguous')

    const both = await live.request('POST', `/api/postings/${id}/disposition`, { setAsideReasonId: 1, rejectionReasonId: 1 })
    const neither = await live.request('POST', `/api/postings/${id}/disposition`, { note: 'why' })

    for (const outcome of [both, neither]) {
      expect(outcome.status).toBe(400)
      expect(errorOf(outcome).message).toContain('setAsideReasonId')
      expect(errorOf(outcome).message).toContain('rejectionReasonId')
    }
  })

  test('POST /disposition parses with the chosen tool schema, which is strict, so a stray field is refused by name', async () => {
    const id = await newPostingId('Stray field')

    const rejection = await live.request('POST', `/api/postings/${id}/disposition`, { rejectionReasonId: 1, extra: true })
    const setAside = await live.request('POST', `/api/postings/${id}/disposition`, { setAsideReasonId: 1, extra: true })

    expect([rejection.status, setAside.status]).toEqual([400, 400])
    expect(errorOf(rejection).message).toContain('extra')
    expect(errorOf(setAside).message).toContain('extra')
  })

  test('POST /disposition with both reasons, one of them null, is the both-reasons refusal and not a silent pick', async () => {
    const id = await newPostingId('Null beside a reason')

    const outcome = await live.request('POST', `/api/postings/${id}/disposition`, { rejectionReasonId: 1, setAsideReasonId: null })

    expect(outcome.status).toBe(400)
    expect(errorOf(outcome).message).toContain('setAsideReasonId')
    expect(errorOf(outcome).message).toContain('rejectionReasonId')
  })

  test('POST /disposition refuses an archived reason with 409', async () => {
    const id = await newPostingId('Archived reason')
    const reasonId = idOf(await addRegistryRows(database(), 'set_aside_reason', [{ label: 'Retired reason' }]))
    await archiveRegistryRow(database(), 'set_aside_reason', reasonId)

    const outcome = await live.request('POST', `/api/postings/${id}/disposition`, { setAsideReasonId: reasonId })

    expect(outcome.status).toBe(409)
    expect(errorOf(outcome).message).toBe(`set_aside_reason ${reasonId} is archived`)
  })
})

describe('the criteria and configuration routes', () => {
  test('GET /api/criteria-sets lists live sets, and archived ones only when asked', async () => {
    const live1 = await arrangeSet(database(), 'Route live')
    const retired = await arrangeSet(database(), 'Route retired')
    await archiveCriteriaSetForTest(database(), retired.setId)

    const byDefault = await live.request('GET', '/api/criteria-sets')
    const everything = await live.request('GET', '/api/criteria-sets?includeArchived=true')

    const ids = (outcome: HttpOutcome): number[] => (dataOf(outcome) as Array<{ id: number }>).map((row) => row.id)
    expect(ids(byDefault)).toContain(live1.setId)
    expect(ids(byDefault)).not.toContain(retired.setId)
    expect(ids(everything)).toContain(retired.setId)
  })

  test('POST /api/criteria-sets creates the next version of a set', async () => {
    const { setId } = await arrangeSet(database(), 'Versioned by route')

    const outcome = await live.request('POST', '/api/criteria-sets', { fromSetId: setId })

    expect(outcome.status).toBe(200)
    expect(dataOf(outcome)).toMatchObject({ name: 'Versioned by route', version: 2 })
  })

  test('GET /api/criteria-sets/:id/requirements returns the rubric, and a missing set is a 404', async () => {
    const { setId, requirementId } = await arrangeSet(database(), 'Rubric by route')

    const found = await live.request('GET', `/api/criteria-sets/${setId}/requirements`)
    const missing = await live.request('GET', '/api/criteria-sets/999999/requirements')

    expect(dataOf(found)).toEqual([expect.objectContaining({ id: requirementId, key: 'skill' })])
    expect(missing.status).toBe(404)
  })

  test('PATCH a requirement changes it when it belongs to the set in the path', async () => {
    const { setId, requirementId } = await arrangeSet(database(), 'Edited by route')

    const outcome = await live.request('PATCH', `/api/criteria-sets/${setId}/requirements/${requirementId}`, { patch: { weight: 3 } })

    expect(outcome.status).toBe(200)
    expect(dataOf(outcome)).toMatchObject({ id: requirementId, weight: 3 })
  })

  test('PATCH a requirement under a set it does not belong to is a 404 and changes nothing', async () => {
    const owner = await arrangeSet(database(), 'Owner set')
    const stranger = await arrangeSet(database(), 'Stranger set')

    const outcome = await live.request('PATCH', `/api/criteria-sets/${stranger.setId}/requirements/${owner.requirementId}`, { patch: { weight: 9 } })
    const unchanged = await live.request('GET', `/api/criteria-sets/${owner.setId}/requirements`)

    expect(outcome.status).toBe(404)
    expect(errorOf(outcome).message).toBe(`criteria set ${stranger.setId} requirement ${owner.requirementId} does not exist`)
    expect(dataOf(unchanged)).toEqual([expect.objectContaining({ weight: 1 })])
  })

  test('PATCH a requirement runs its ownership check and its write on the transaction, never on the outer handle', async () => {
    const { setId, requirementId } = await arrangeSet(database(), 'Transactional edit')
    // `execute` is raw SQL (the server's own probe uses it) and `query` is the relational API, so
    // either one would bypass the schema-typed verbs. `query` is an object and not a function, so
    // reading anything off it is what must fail.
    const QUERY_VERBS = new Set<string | symbol>(['select', 'insert', 'update', 'delete', 'execute'])
    const refuse = (property: string | symbol): never => {
      throw new Error(`a query was issued on the outer handle: ${String(property)}`)
    }
    let transactions = 0
    // The outer handle refuses every query, so a read or a write moved off the transaction fails
    // the request (a 500) instead of passing unnoticed. Only `transaction` is let through.
    const outer = new Proxy(database(), {
      get(target, property, receiver) {
        if (QUERY_VERBS.has(property)) return (): never => refuse(property)
        if (property === 'query') return new Proxy({}, { get: (_target, table) => refuse(`query.${String(table)}`) })
        const value: unknown = Reflect.get(target, property, receiver)
        if (property !== 'transaction' || typeof value !== 'function') return value
        return (...args: unknown[]): unknown => {
          transactions += 1
          return Reflect.apply(value, target, args)
        }
      },
    })
    const guarded = await startTestServer((app) => mountRoutes(app, outer))

    try {
      const outcome = await guarded.request('PATCH', `/api/criteria-sets/${setId}/requirements/${requirementId}`, { patch: { weight: 4 } })
      const stored = await live.request('GET', `/api/criteria-sets/${setId}/requirements`)

      expect(outcome.status).toBe(200)
      expect(transactions).toBe(1)
      expect(dataOf(stored)).toEqual([expect.objectContaining({ id: requirementId, weight: 4 })])
    } finally {
      await guarded.close()
    }
  })

  test('PATCH a requirement refuses a body that is the patch itself, naming the stray field', async () => {
    const { setId, requirementId } = await arrangeSet(database(), 'Bare patch')

    const outcome = await live.request('PATCH', `/api/criteria-sets/${setId}/requirements/${requirementId}`, { weight: 3 })

    expect(outcome.status).toBe(400)
    expect(errorOf(outcome).message).toContain('weight')
  })

  test('PUT /api/criteria-sets/:id/default moves the default, and an archived set is a 409', async () => {
    const chosen = await arrangeSet(database(), 'Chosen default')
    const retired = await arrangeSet(database(), 'Retired default')
    await archiveCriteriaSetForTest(database(), retired.setId)

    const outcome = await live.request('PUT', `/api/criteria-sets/${chosen.setId}/default`)
    const refused = await live.request('PUT', `/api/criteria-sets/${retired.setId}/default`)

    expect(dataOf(outcome)).toMatchObject({ id: chosen.setId, isDefault: true })
    expect(refused.status).toBe(409)
  })

  test('GET and PUT /api/config/mode read and set the mode, and an unrecognised mode is a 400', async () => {
    const initial = await live.request('GET', '/api/config/mode')
    const set = await live.request('PUT', '/api/config/mode', { mode: 'perspective' })
    const read = await live.request('GET', '/api/config/mode')
    const refused = await live.request('PUT', '/api/config/mode', { mode: 'freestyle' })
    await live.request('PUT', '/api/config/mode', { mode: 'versioned' })

    expect(dataOf(initial)).toEqual({ mode: 'versioned' })
    expect(dataOf(set)).toEqual({ mode: 'perspective' })
    expect(dataOf(read)).toEqual({ mode: 'perspective' })
    expect(refused.status).toBe(400)
    expect(errorOf(refused).message).toContain('mode')
  })
})

describe('the registry and text routes', () => {
  test('POST adds a row, GET lists it, and PATCH archives it out of the default list', async () => {
    const added = await live.request('POST', '/api/registries/route', { row: { label: 'Referral' } })
    const id = (dataOf(added) as { id: number }).id
    const listed = await live.request('GET', '/api/registries/route')
    const archived = await live.request('PATCH', `/api/registries/route/${id}`)
    const afterDefault = await live.request('GET', '/api/registries/route')
    const afterAll = await live.request('GET', '/api/registries/route?includeArchived=true')

    const ids = (outcome: HttpOutcome): number[] => (dataOf(outcome) as Array<{ id: number }>).map((row) => row.id)
    expect(dataOf(added)).toMatchObject({ label: 'Referral' })
    expect(ids(listed)).toContain(id)
    expect((dataOf(archived) as { archivedAt: string | null }).archivedAt).not.toBeNull()
    expect(ids(afterDefault)).not.toContain(id)
    expect(ids(afterAll)).toContain(id)
  })

  test('a registry that does not exist, and a row that does not fit its registry, are 400s naming the field', async () => {
    const unknownList = await live.request('GET', '/api/registries/nonsense')
    const unknownAdd = await live.request('POST', '/api/registries/nonsense', { row: { label: 'x' } })
    const misfit = await live.request('POST', '/api/registries/route', { row: { label: 'x', sort: 1 } })

    expect([unknownList.status, unknownAdd.status, misfit.status]).toEqual([400, 400, 400])
    expect(errorOf(unknownList).message).toContain('registry')
    expect(errorOf(misfit).message).toContain('sort')
  })

  test('archiving a row that is not there is a 404', async () => {
    const outcome = await live.request('PATCH', '/api/registries/route/999999')

    expect(outcome.status).toBe(404)
  })

  test('GET /api/texts lists the latest version of each label and takes the history flag as text', async () => {
    await addText(database(), { label: 'Cover letter route', body: 'first' })
    const latest = await live.request('GET', '/api/texts')
    const withHistory = await live.request('GET', '/api/texts?includeHistory=true')

    const labelled = (outcome: HttpOutcome): unknown[] => (dataOf(outcome) as Array<{ label: string }>).filter((row) => row.label === 'Cover letter route')
    expect(labelled(latest)).toHaveLength(1)
    expect(labelled(withHistory).length).toBeGreaterThanOrEqual(1)
  })
})
