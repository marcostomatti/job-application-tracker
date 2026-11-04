import { readFileSync } from 'node:fs'

import { inArray } from 'drizzle-orm'

import { lintPackFile, type LintFinding } from '../../drizzle/lint/migration-lint.ts'
import { closeDb, getDb, type DrizzleClient } from '../data/client.ts'
import { insertCriteriaSet, requirement } from '../data/schema/criteria.ts'
import { layer } from '../data/schema/registries.ts'
import type { VanillaPack } from '../entities/scoring.ts'
import { VanillaPackSchema } from '../schemas/scoring.ts'

export type LoadResult = { criteriaSetId: number; requirementCount: number }

/** Raised when the lint finds a weight or an apply_threshold in the pack file. */
export class PackCarriesJudgementError extends Error {
  constructor(
    readonly file: string,
    readonly findings: readonly LintFinding[],
  ) {
    super(
      `${file} carries judgement and cannot be installed: ` +
        findings.map((finding) => `line ${finding.line}, ${finding.detail}`).join('; '),
    )
    this.name = 'PackCarriesJudgementError'
  }
}

/** The client, or an open transaction (which then runs the load in a savepoint). */
type PackDb = Pick<DrizzleClient, 'transaction'>

/** Lints the file, then parses it. The lint runs first so its message names the line. */
function readPack(path: string): VanillaPack {
  const findings = lintPackFile(path)
  if (findings.length > 0) throw new PackCarriesJudgementError(path, findings)
  return VanillaPackSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
}

/**
 * Installs a vanilla pack: the layers it names (reusing any that already exist), the
 * criteria set, and its requirements, all in one transaction. A set with this name and
 * version already present raises `CriteriaSetConflictError` and leaves nothing behind,
 * layers included.
 *
 * The set is not made the default. A pack has no weights, so it cannot score anything yet,
 * and marking it default would claim otherwise; it would also take the single default slot
 * that the user's own set, or a second pack, needs. Choosing the default is the user's call.
 */
export async function loadPack(path: string, db: PackDb = getDb()): Promise<LoadResult> {
  const pack = readPack(path)

  return db.transaction(async (tx) => {
    await tx
      .insert(layer)
      .values(pack.layers.map((entry, index) => ({ key: entry.key, label: entry.label, sort: index })))
      .onConflictDoNothing({ target: layer.key })
    const layerRows = await tx
      .select({ id: layer.id, key: layer.key })
      .from(layer)
      .where(inArray(layer.key, pack.layers.map((entry) => entry.key)))
    const layerIdByKey = new Map(layerRows.map((row) => [row.key, row.id]))

    const set = await insertCriteriaSet(tx, {
      name: pack.name,
      version: pack.version,
      applyThreshold: pack.apply_threshold,
    })
    const created = await tx
      .insert(requirement)
      .values(
        pack.requirements.map((entry, index) => ({
          criteriaSetId: set.id,
          layerId: layerIdByKey.get(entry.layer_key) ?? null,
          key: entry.key,
          label: entry.label,
          kind: entry.kind,
          weight: entry.weight,
          anchors: entry.anchors,
          sort: index,
        })),
      )
      .returning({ id: requirement.id })

    return { criteriaSetId: set.id, requirementCount: created.length }
  })
}

if (import.meta.main) {
  const path = process.argv[2]
  if (!path) {
    console.error('Usage: bun run seed:pack <path-to-pack.json>')
    process.exit(2)
  }
  try {
    const { criteriaSetId, requirementCount } = await loadPack(path)
    console.log(`Loaded criteria set ${criteriaSetId} with ${requirementCount} requirements.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  } finally {
    await closeDb()
  }
}
