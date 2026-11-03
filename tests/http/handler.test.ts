import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { z, ZodError } from 'zod'

import { ArchivedError, BulkItemError, ConflictError, NotFoundError } from '../../src/errors.ts'
import { jsonHandler } from '../../src/http/handler.ts'
import { IdSchema } from '../../src/schemas/common.ts'
import { describeError } from '../../src/mcp/result.ts'
import { untouchableDb } from '../mcp/tools/harness.ts'
import { startTestServer, type TestServer } from './harness.ts'

const db = untouchableDb()

/** The three places a field can arrive from; strict, like every schema the routes share. */
const MergeSchema = z.strictObject({ fromPath: IdSchema, fromQuery: IdSchema, fromBody: IdSchema })
const CountSchema = z.strictObject({ count: z.number().int() })
const SharedNameSchema = z.strictObject({ name: z.string() })
const ScopeSchema = z.strictObject({ itemId: IdSchema })

/** What the next call to `/throws` throws, set by the test that wants it. */
let toThrow: unknown = new Error('unset')
let calls = 0

let server: TestServer

beforeAll(async () => {
  server = await startTestServer((app) => {
    app.post('/count', jsonHandler(CountSchema, async (args) => (calls += 1, args), db))
    app.post('/merge/:fromPath', jsonHandler(MergeSchema, async (args) => args, db))
    app.get('/merge/:fromPath', jsonHandler(MergeSchema, async (args) => args, db))
    app.post('/named/:name', jsonHandler(SharedNameSchema, async (args) => args, db))
    app.get('/named', jsonHandler(SharedNameSchema, async (args) => args, db))
    app.post('/nothing', jsonHandler(z.strictObject({}), async () => undefined, db))
    app.post('/throws', jsonHandler(z.strictObject({}), async () => Promise.reject(toThrow), db))
    app.post(
      '/scoped/:setId/items/:itemId',
      jsonHandler(
        ScopeSchema,
        async (args, _db, scope) => ({ args, setId: scope.setId }),
        db,
        { pathOnly: { setId: IdSchema } },
      ),
    )
  })
})

afterAll(async () => {
  await server.close()
})

describe('jsonHandler', () => {
  test('answers 400 with the field name for a body failing its schema, and never calls run', async () => {
    const before = calls

    const outcome = await server.request('POST', '/count', { count: 'many' })

    expect(outcome.status).toBe(400)
    expect(outcome.body).toMatchObject({ success: false, error: { name: 'ValidationError' } })
    const message = (outcome.body as { error: { message: string } }).error.message
    expect(message).toContain('count')
    expect(calls).toBe(before)
  })

  test('a ZodError for caller input is a 400 that names the field, not an opaque 500', async () => {
    const outcome = await server.request('POST', '/count', {})

    expect(outcome.status).toBe(400)
    expect(JSON.stringify(outcome.body)).toContain('count')
    expect(JSON.stringify(outcome.body)).not.toContain('internal error')
  })

  test('names an unrecognised field, because every shared schema is strict', async () => {
    const outcome = await server.request('POST', '/count', { count: 1, limit: 5 })

    expect(outcome.status).toBe(400)
    expect(JSON.stringify(outcome.body)).toContain('limit')
  })

  test('answers 400 when the body is a JSON array rather than an object', async () => {
    const outcome = await server.request('POST', '/count', [{ count: 1 }])

    expect(outcome.status).toBe(400)
    expect(JSON.stringify(outcome.body)).toContain('object')
  })

  test('answers the success envelope, with null when run returns nothing', async () => {
    const answered = await server.request('POST', '/count', { count: 3 })
    const empty = await server.request('POST', '/nothing', {})

    expect(answered).toEqual({ status: 200, body: { success: true, data: { count: 3 } } })
    expect(empty).toEqual({ status: 200, body: { success: true, data: null } })
  })

  test('merges params, query and body before parsing, coercing the text ones', async () => {
    const outcome = await server.request('POST', '/merge/7?fromQuery=8', { fromBody: 9 })

    expect(outcome).toEqual({ status: 200, body: { success: true, data: { fromPath: 7, fromQuery: 8, fromBody: 9 } } })
  })

  test('a field named by both the path and the body is a 400, so a body cannot retarget the path', async () => {
    const outcome = await server.request('POST', '/named/from-path', { name: 'from-body' })

    expect(outcome.status).toBe(400)
    expect(JSON.stringify(outcome.body)).toContain('name')
  })

  test('a field named by both the path and the query is a 400 too', async () => {
    const outcome = await server.request('POST', '/merge/7?fromPath=9&fromQuery=8', { fromBody: 9 })

    expect(outcome.status).toBe(400)
    expect(JSON.stringify(outcome.body)).toContain('fromPath')
  })

  test('a field named by both the query and the body takes the body, which is the stated merge order', async () => {
    const outcome = await server.request('POST', '/merge/7?fromQuery=1', { fromQuery: 2, fromBody: 3 })

    expect(outcome.body).toEqual({ success: true, data: { fromPath: 7, fromQuery: 2, fromBody: 3 } })
  })

  test('reads a GET from the query alone, with no body', async () => {
    const outcome = await server.request('GET', '/named?name=found')

    expect(outcome.body).toEqual({ success: true, data: { name: 'found' } })
  })

  test('a path-only parameter is parsed on its own schema, kept out of the tool schema and handed to run', async () => {
    const outcome = await server.request('POST', '/scoped/4/items/9')

    expect(outcome.body).toEqual({ success: true, data: { args: { itemId: 9 }, setId: 4 } })
  })

  test('a path-only parameter that fails its schema is a 400 naming it', async () => {
    const outcome = await server.request('POST', '/scoped/four/items/9')

    expect(outcome.status).toBe(400)
    expect(JSON.stringify(outcome.body)).toContain('setId')
  })

  test('answers 404 for a NotFoundError, with the same wording describeError gives', async () => {
    toThrow = new NotFoundError('position', 12)

    const outcome = await server.request('POST', '/throws', {})

    expect(outcome).toEqual({
      status: 404,
      body: { success: false, error: { name: 'NotFoundError', message: 'position 12 does not exist' } },
    })
  })

  test('every known class is worded by describeError and mapped by statusFor', async () => {
    const cases: Array<[unknown, number]> = [
      [new ConflictError('route', 'x'), 409],
      [new ArchivedError('stage', 3), 409],
      [new BulkItemError(2, new NotFoundError('position', 5)), 400],
    ]

    for (const [error, status] of cases) {
      toThrow = error
      const outcome = await server.request('POST', '/throws', {})
      expect(outcome.status).toBe(status)
      expect(outcome.body).toEqual({ success: false, error: describeError(error) })
    }
  })

  test('answers 500 and leaks no connection detail for an unknown error', async () => {
    const secret = 'LEAK-SENTINEL-4f1c'
    toThrow = new Error(`connect failed: ${secret}`, { cause: new Error(`select * from key where k = '${secret}'`) })

    const outcome = await server.request('POST', '/throws', {})

    expect(outcome.status).toBe(500)
    expect(outcome.body).toEqual({ success: false, error: { name: 'InternalError', message: 'internal error' } })
    expect(JSON.stringify(outcome.body)).not.toContain('LEAK-SENTINEL')
  })

  test('a ZodError thrown by run is the server failing, so it is a flat 500 and not a 400', async () => {
    const stored = CountSchema.safeParse({ count: 'a value read back from storage' })
    toThrow = stored.error ?? new ZodError([])

    const outcome = await server.request('POST', '/throws', {})

    expect(outcome.status).toBe(500)
    expect(outcome.body).toEqual({ success: false, error: { name: 'InternalError', message: 'internal error' } })
  })
})
