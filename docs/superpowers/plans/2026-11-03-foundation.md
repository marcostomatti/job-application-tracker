# Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the database schema, the scoring functions and the provenance derivation for job-application-tracker, with the privacy rule enforced by a test before the first migration exists.

**Architecture:** Pure functions first, tables derived from the shapes they need. Every vocabulary is a registry table shipped empty; every judgement is a row referencing one. A lint test parses `drizzle/` and `seeds/vanilla/` and fails on any constraint, column name, comment or seed that would carry an opinion into the template. Scoring produces a normalised recommendation and a named limiting factor from the same rating rows.

**Tech Stack:** Bun, TypeScript, Postgres 16 in Docker, Drizzle ORM with `drizzle-kit` migrations, Zod, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-11-03-job-application-tracker-design.md`

This plan covers build-order steps 1 to 5 of §16. Steps 6 to 12 (auth and MCP, the internal HTTP layer, backups, the web app, claims and importers, the Stats surface) are three further plans.

## Global Constraints

- Postgres 16. Drizzle with real migrations; no `db push` in any script.
- Zod schemas live in `src/schemas/` and are the single source for validation; nothing validates inline.
- A CHECK constraint may only enumerate a closed structural set: booleans, a date shape, a numeric range, or an internal discriminator defined by the code (`'set_aside' | 'rejected'`, `'gate' | 'soft'`, `'supported' | 'partial' | 'unknown'`, `'up' | 'down' | 'flat'`, `'own_search' | 'inbound' | 'referral' | 'imported_series'`).
- No column named after an industry, company, technology, language or jurisdiction.
- No registry is referenced by a NOT NULL column, because a template installs with every registry empty.
- No migration contains a seed INSERT into a registry table.
- No migration comment cites a row count or a company name.
- A vanilla pack carries structure and anchor text with every `weight` and every `apply_threshold` null.
- Archive (`archived_at`) rather than delete, on every registry.
- Immutable updates: functions return new objects, never mutate arguments.
- Source files under 800 lines; functions under 50 lines; nesting under 4 levels.
- 80% test coverage minimum.
- Nothing committed may identify the machine, the network or the person: no device name, host name, IP address or runner detail, and no credentials.
- Coverage is `numeric` in `0..1`. `overall` is `numeric` in `0..1`. A penalty `amount` is `numeric <= 0`. A detour `discount` is `numeric` in `0..1`.

## Review Focus

Five conditions the spec implies that no task's own happy-path tests would exercise, most likely to bite first. Each has a test added to the task that owns the code.

1. **Every weight null** — a fresh vanilla pack before the seed interview runs. `computeOverall` would divide by a zero weight sum. Expected: `overall` is null, not `NaN` or an error, and `recommendApply` is false. *(Task 4)*
2. **An origin dated in the future** — a user typo in `touched_on`. First touch would silently pick it and rewrite the lead's provenance. Expected: the derivation ignores origins dated after today, and the row stays readable. *(Task 12)*
3. **A detour with `discount = 1`** — a detour that fully discounts makes effective coverage 0, so a route meant to help would block. Expected: a discount of 1 contributes nothing and never lowers direct coverage. *(Task 2)*
4. **An archived registry row still referenced** — a user renames their vocabulary after scoring. Expected: existing rows keep resolving their label, and archived rows are excluded from pick lists but not from reads. *(Task 7)*
5. **A duplicate criteria set name and version** — an agent's bulk insert retried after a timeout. Expected: the unique constraint raises a distinguishable conflict rather than a generic error, so the agent can treat it as a no-op. *(Task 8)*

---

## File Structure

```
drizzle/
  lint/forbidden.ts          denylists and the allowed structural literals
  lint/migration-lint.ts     the parser and the five rules
  0001_registries.sql        the twelve registries, all empty
  0002_criteria.sql          criteria_set, requirement, detour
  0003_positions.sql         company, position, position_summary, artefact
  0004_scores.sql            position_score, position_rating, position_penalty
  0005_dispositions.sql      position_disposition, position_stage_event
  0006_provenance.sql        search_run, origin, the first-touch view
  0007_config_rescore.sql    app_config, rescore_request, the pending view
src/
  schemas/scoring.ts         Zod for requirements, ratings, detours, penalties
  schemas/provenance.ts      Zod for origins and routes
  entities/scoring.ts        inferred types, no IO
  entities/provenance.ts     inferred types, no IO
  scoring/effective-coverage.ts
  scoring/limiter.ts
  scoring/overall.ts
  scoring/score-against-set.ts
  provenance/first-touch.ts
  data/schema/registries.ts  Drizzle table objects
  data/schema/criteria.ts
  data/schema/positions.ts
  data/schema/scores.ts
  data/schema/dispositions.ts
  data/schema/provenance.ts
  data/schema/config.ts
  data/client.ts             the Drizzle client, connection string from env
  seeds/load-pack.ts         reads a vanilla pack, validates, inserts
seeds/vanilla/web-search.json
tests/                       mirrors src/, plus tests/fixtures/
docker-compose.yaml
drizzle.config.ts
.env.example
```

Scoring is split across four files because each piece has its own test cycle and a reviewer can reject one while approving its neighbour. Drizzle table objects are split per migration so a file maps to one migration.

---

## Task 1: The migration lint test

The rule made mechanical, written before any migration exists.

**Files:**
- Create: `drizzle/lint/forbidden.ts`, `drizzle/lint/migration-lint.ts`
- Create: `tests/drizzle/migration-lint.test.ts`
- Create: `tests/fixtures/lint/` — `good.sql`, `bad-check.sql`, `bad-column.sql`, `bad-seed.sql`, `bad-comment.sql`, `bad-pack.json`, `good-pack.json`
- Modify: `package.json` (add `zod`, `@types/bun` is present; add a `lint:migrations` script)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type LintFinding = { file: string; line: number; rule: LintRule; detail: string }`
  - `type LintRule = 'vocabulary-in-check' | 'named-column' | 'registry-seed' | 'leaky-comment' | 'pack-carries-judgement'`
  - `lintMigrations(dir: string): LintFinding[]`
  - `lintVanillaPacks(dir: string): LintFinding[]`
  - `ALLOWED_STRUCTURAL_LITERALS: readonly string[]` and `DENIED_COLUMN_WORDS: readonly string[]` from `forbidden.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/drizzle/migration-lint.test.ts
test('accepts a migration whose CHECK lists only structural literals', ...)
  // good.sql has CHECK (kind IN ('gate','soft')) and CHECK (is_terminal IN (0,1))
  // expect(lintMigrations(fixtures)).toHaveLength(0)

test('rejects a CHECK that enumerates gate vocabulary', ...)
  // bad-check.sql: CHECK (gate IN ('Icelandic','Onsite','Elixir'))
  // expect one finding with rule 'vocabulary-in-check' and the line number

test('rejects a column named after a technology or industry', ...)
  // bad-column.sql: penalty_fintech, is_acme_client
  // expect two findings with rule 'named-column'

test('rejects a seed INSERT into a registry table inside a migration', ...)
  // bad-seed.sql: INSERT INTO stage (key,label) VALUES ('new','New')
  // expect one finding with rule 'registry-seed'

test('rejects a comment citing a row count or a company name', ...)
  // bad-comment.sql: "-- 93 rows" and a name present in the company fixture
  // expect two findings with rule 'leaky-comment'

test('rejects a vanilla pack carrying a weight or an apply_threshold', ...)
  // bad-pack.json has weight: 0.3; good-pack.json has weight: null
  // expect one finding with rule 'pack-carries-judgement' for bad, none for good

test('reports the file and line of every finding', ...)
  // every finding has a non-empty file and a line >= 1
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/drizzle/migration-lint.test.ts`
Expected: FAIL — `lintMigrations` is not exported.

- [ ] **Step 3: Implement `forbidden.ts`**

`ALLOWED_STRUCTURAL_LITERALS` holds exactly the discriminator members listed in Global Constraints, plus `'0'` and `'1'`. `DENIED_COLUMN_WORDS` holds industry, technology, language and jurisdiction words; seed it with the words the spec's §1 audit names and leave it extensible.

- [ ] **Step 4: Implement `lintMigrations(dir)` and `lintVanillaPacks(dir)` in `drizzle/lint/migration-lint.ts`**

Read each file, track line numbers, and apply the five rules by regex over SQL text — a full SQL parser is not needed and would be a dependency the template does not want. For `leaky-comment`, match a digit-run followed by optional whitespace and `rows`, and match any name read from the `company` fixture.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/drizzle/migration-lint.test.ts`
Expected: PASS, all seven.

- [ ] **Step 6: Commit**

```bash
git add drizzle/lint tests/drizzle tests/fixtures/lint package.json
git commit -m "test: add the migration lint that keeps vocabulary out of the DDL"
```

---

## Task 2: Effective coverage, with detours

**Files:**
- Create: `src/schemas/scoring.ts`, `src/entities/scoring.ts`, `src/scoring/effective-coverage.ts`
- Create: `tests/scoring/effective-coverage.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `RequirementSchema` with `{ key: string; layerKey: string; kind: 'gate' | 'soft'; weight: number | null; label: string }`
  - `RatingSchema` with `{ requirementKey: string; coverage: number | null; confidence: 'supported' | 'partial' | 'unknown' }`
  - `DetourSchema` with `{ requirementKey: string; label: string; discount: number; coverage: number | null }`
  - Types `Requirement`, `Rating`, `Detour` inferred from those schemas
  - `effectiveCoverage(rating: Rating | undefined, detours: readonly Detour[]): number | null`

- [ ] **Step 1: Write the failing tests**

```ts
test('returns the direct coverage when there is no detour', ...)
  // rating coverage 0.4, no detours -> 0.4

test('returns null when the requirement is unrated and has no detour', ...)
  // rating undefined -> null

test('lifts a blocked requirement through its best detour', ...)
  // coverage 0, detour { coverage: 1, discount: 0.4 } -> 0.6

test('never lifts a requirement above its direct coverage when the detour is worse', ...)
  // coverage 0.8, detour { coverage: 1, discount: 0.5 } -> 0.8

test('picks the best of several detours', ...)
  // detours with discounts 0.7 and 0.2 at coverage 1 -> 0.8

test('a detour with discount 1 contributes nothing', ...)   // Review Focus 3
  // coverage 0.3, detour { coverage: 1, discount: 1 } -> 0.3
  // coverage 0 (or null), detour { coverage: 1, discount: 1 } -> 0 (or null)

test('an unrated detour does not rescue an unrated requirement', ...)
  // rating undefined, detour coverage null -> null
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/scoring/effective-coverage.test.ts`
Expected: FAIL — `effectiveCoverage` is not exported.

- [ ] **Step 3: Implement `effectiveCoverage` in `src/scoring/effective-coverage.ts`**

The larger of the direct coverage and the best `detour.coverage * (1 - detour.discount)`. A null direct coverage with no usable detour stays null, because null means not rated and is not zero.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/scoring/effective-coverage.test.ts`
Expected: PASS, all seven.

- [ ] **Step 5: Commit**

```bash
git add src/schemas/scoring.ts src/entities/scoring.ts src/scoring/effective-coverage.ts tests/scoring/effective-coverage.test.ts
git commit -m "feat: add effective coverage with detour discounts"
```

---

## Task 3: The limiting factor

**Files:**
- Create: `src/scoring/limiter.ts`
- Create: `tests/scoring/limiter.test.ts`

**Interfaces:**
- Consumes: `effectiveCoverage`, `Requirement`, `Rating`, `Detour` from Task 2.
- Produces: `findLimiter(requirements, ratings, detours): LimiterResult` where
  `type LimiterResult = { requirementKey: string | null; coverage: number | null; isUnknown: boolean; runnerUpKey: string | null }`

- [ ] **Step 1: Write the failing tests**

```ts
test('names the requirement with the lowest effective coverage', ...)
test('keeps the second-lowest as the runner up', ...)
test('resolves a tie by requirement key, deterministically', ...)
  // two requirements both at 0.2 -> the lexicographically first key wins,
  // and the other is the runner up
test('flags a limiter that is only an unrated requirement', ...)
  // one requirement unrated, all others at 0.9 -> isUnknown true
test('prefers a rated zero over an unrated requirement as the limiter', ...)
  // a gate at coverage 0 and another unrated -> the rated zero is the limiter,
  // isUnknown false
test('returns nulls for an empty requirement list', ...)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/scoring/limiter.test.ts`
Expected: FAIL — `findLimiter` is not exported.

- [ ] **Step 3: Implement `findLimiter` in `src/scoring/limiter.ts`**

Sort by effective coverage ascending, treating null as ranking after a rated zero, then by requirement key for determinism. The layer does not enter the arithmetic (spec §8): the flat minimum is the limit, and layers only group the report.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/scoring/limiter.test.ts`
Expected: PASS, all six.

- [ ] **Step 5: Commit**

```bash
git add src/scoring/limiter.ts tests/scoring/limiter.test.ts
git commit -m "feat: add the limiting-factor derivation"
```

---

## Task 4: The normalised overall, with floor and ceiling

**Files:**
- Create: `src/scoring/overall.ts`
- Create: `tests/scoring/overall.test.ts`

**Interfaces:**
- Consumes: `effectiveCoverage`, `Requirement`, `Rating`, `Detour` from Task 2.
- Produces:
  - `PenaltySchema` with `{ kindKey: string; amount: number }` added to `src/schemas/scoring.ts`
  - `computeOverall(requirements, ratings, detours, penalties): OverallResult` where
    `type OverallResult = { overall: number | null; floor: number | null; ceiling: number | null }`

- [ ] **Step 1: Write the failing tests**

```ts
test('normalises by the sum of the rated soft weights', ...)
  // weights 0.3 and 0.1 at coverages 1 and 0 -> 0.75, not 0.3
test('ignores gate requirements in the sum', ...)
test('subtracts penalties from the normalised score', ...)
  // overall 0.75 with a penalty of -0.25 -> 0.5
test('clamps the result into 0..1', ...)
  // a penalty larger than the score -> 0, never negative
test('returns null when every weight is null', ...)        // Review Focus 1
  // a fresh vanilla pack: overall, floor and ceiling are all null,
  // and nothing throws or returns NaN
test('counts unrated requirements as 0 for the floor and 1 for the ceiling', ...)
  // one rated at 1 and one unrated, equal weights -> floor 0.5, ceiling 1
test('floor equals ceiling when everything is rated', ...)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/scoring/overall.test.ts`
Expected: FAIL — `computeOverall` is not exported.

- [ ] **Step 3: Implement `computeOverall` in `src/scoring/overall.ts`**

Weighted sum of effective coverages over rated `soft` requirements, divided by the sum of those requirements' weights, minus the penalty total, clamped to `0..1`. A zero or null weight sum yields null for all three values, because a set with no weights has no scale to normalise against.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/scoring/overall.test.ts`
Expected: PASS, all seven.

- [ ] **Step 5: Commit**

```bash
git add src/schemas/scoring.ts src/scoring/overall.ts tests/scoring/overall.test.ts
git commit -m "feat: add the normalised overall score with floor and ceiling"
```

---

## Task 5: `scoreAgainstSet` and the apply rule

**Files:**
- Create: `src/scoring/score-against-set.ts`
- Create: `tests/scoring/score-against-set.test.ts`, `tests/fixtures/scoring/positions.ts`

**Interfaces:**
- Consumes: `effectiveCoverage` (Task 2), `findLimiter` (Task 3), `computeOverall` (Task 4).
- Produces:
  - `ScoreInputSchema` in `src/schemas/scoring.ts`, covering requirements, ratings, detours, penalties and `applyThreshold: number | null`
  - `scoreAgainstSet(input: ScoreInput): ScoreResult` where
    `type ScoreResult = { overall: number | null; floor: number | null; ceiling: number | null; limiterKey: string | null; limiterCoverage: number | null; limiterIsUnknown: boolean; runnerUpKey: string | null; recommendApply: boolean }`

**Fixture:** `tests/fixtures/scoring/positions.ts` exports six invented positions — one clear apply, one clear skip, one tie between two limiters, one lifted by a detour, one blocked by an unrated gate, one with every weight null. The data is invented; none of it comes from the old app.

- [ ] **Step 1: Write the failing tests**

```ts
test('recommends apply when the overall clears the threshold and no gate blocks', ...)
test('withholds apply when the overall is below the threshold', ...)
test('withholds apply when any gate is at effective coverage 0', ...)
test('withholds apply when any gate is unrated', ...)
  // a hard gate nobody checked is not a gate that passed (spec §8)
test('withholds apply when the threshold is null', ...)
  // a vanilla pack before the interview sets a bar
test('reports the limiter alongside the recommendation', ...)
  // the same call returns both the number and the named blocker
test.each(FIXTURE_POSITIONS)('scores fixture position $name as expected', ...)
  // each fixture row carries its own expected ScoreResult
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/scoring/score-against-set.test.ts`
Expected: FAIL — `scoreAgainstSet` is not exported.

- [ ] **Step 3: Implement `scoreAgainstSet` in `src/scoring/score-against-set.ts`**

Validate the input with `ScoreInputSchema`, then compose the three functions. `recommendApply` is true when `overall` is non-null, `applyThreshold` is non-null, `overall >= applyThreshold`, and every `gate` requirement has an effective coverage strictly above 0 and is rated.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/scoring/`
Expected: PASS, every scoring test.

- [ ] **Step 5: Commit**

```bash
git add src/schemas/scoring.ts src/scoring/score-against-set.ts tests/scoring tests/fixtures/scoring
git commit -m "feat: compose scoreAgainstSet with the apply rule"
```

---

## Task 6: Postgres in Docker, and the Drizzle client

**Files:**
- Create: `docker-compose.yaml`, `drizzle.config.ts`, `.env.example`, `src/data/client.ts`
- Create: `tests/data/client.test.ts`
- Modify: `package.json` (add `drizzle-orm`, `drizzle-kit`, `postgres`; add `db:migrate`, `db:up`, `db:down` scripts)
- Modify: `.gitignore` (add `.env`)

**Interfaces:**
- Consumes: nothing.
- Produces: `getDb(): DrizzleClient` reading `DATABASE_URL` from the environment, and `closeDb(): Promise<void>`.

`.env.example` carries `DATABASE_URL=postgres://tracker:tracker@localhost:5432/tracker` and no real credential. `docker-compose.yaml` pins `postgres:16` and names no host, device or network of the author's.

- [ ] **Step 1: Write the failing test**

```ts
test('connects to the database named by DATABASE_URL', ...)
  // getDb() then a `select 1` round-trip returns 1
test('throws a named error when DATABASE_URL is absent', ...)
  // not a generic undefined-property error
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/data/client.test.ts`
Expected: FAIL — `getDb` is not exported.

- [ ] **Step 3: Write `docker-compose.yaml`, `drizzle.config.ts` and `.env.example`, then implement `getDb` and `closeDb` in `src/data/client.ts`**

Read `DATABASE_URL` once, fail fast with a named error when it is missing, and reuse one connection pool.

- [ ] **Step 4: Bring the database up and run the tests**

Run: `bun run db:up && bun test tests/data/client.test.ts`
Expected: PASS, both.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yaml drizzle.config.ts .env.example .gitignore src/data/client.ts tests/data package.json
git commit -m "feat: add Postgres in compose and the Drizzle client"
```

---

## Task 7: The registries

**Files:**
- Create: `src/data/schema/registries.ts`, `drizzle/0001_registries.sql`
- Create: `tests/data/registries.test.ts`

**Interfaces:**
- Consumes: `getDb` (Task 6), `lintMigrations` (Task 1).
- Produces: Drizzle table objects `phase`, `stage`, `layer`, `route`, `setAsideReason`, `rejectionReason`, `penaltyKind`, `textType`, `artefactKind`, `workFormat`, `seniority`, `applyRoute` — every one with `id`, `label`, `archivedAt`, plus the extra columns in spec §7.1.

- [ ] **Step 1: Write the failing tests**

```ts
test('every registry is empty after migrating', ...)
  // twelve counts, all zero: a template installs with no vocabulary
test('the migration passes the lint', ...)
  // lintMigrations('drizzle') returns no finding for 0001
test('a phase carries is_shortlist and a stage carries is_applied', ...)
  // the user-set booleans that keep phase names out of the code
test('an archived row still resolves its label from a referencing row', ...)  // Review Focus 4
  // insert a route, insert an origin-like reference, archive the route,
  // and the join still returns the label while a pick-list query excludes it
test('a registry column is nullable wherever another table references it', ...)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/data/registries.test.ts`
Expected: FAIL — the tables do not exist.

- [ ] **Step 3: Define the twelve tables in `src/data/schema/registries.ts` and generate the migration**

Run `bunx drizzle-kit generate` and rename the output to `0001_registries.sql`. Review the generated SQL against the Global Constraints before committing: no seed INSERT, no vocabulary in a CHECK.

- [ ] **Step 4: Migrate and run the tests**

Run: `bun run db:migrate && bun test tests/data/registries.test.ts && bun run lint:migrations`
Expected: PASS, and the lint reports nothing.

- [ ] **Step 5: Commit**

```bash
git add src/data/schema/registries.ts drizzle/0001_registries.sql tests/data/registries.test.ts
git commit -m "feat: add the twelve registries, shipped empty"
```

---

## Task 8: Criteria sets, requirements and detours

**Files:**
- Create: `src/data/schema/criteria.ts`, `drizzle/0002_criteria.sql`
- Create: `tests/data/criteria.test.ts`

**Interfaces:**
- Consumes: `layer` (Task 7), `getDb` (Task 6).
- Produces: tables `criteriaSet`, `requirement`, `detour` per spec §7.2, and `CriteriaSetConflictError` from `src/data/schema/criteria.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
test('a criteria set accepts a null apply_threshold', ...)
  // a vanilla pack ships without a bar
test('a requirement accepts a null weight', ...)
test('a requirement requires anchors', ...)
  // anchors is what makes a weight meaningful to someone else
test('requirement keys are unique within a set but not across sets', ...)
test('inserting a duplicate name and version raises a distinguishable conflict', ...)  // Review Focus 5
  // expect CriteriaSetConflictError, not a generic driver error, so a
  // retried bulk insert can treat it as a no-op
test('the kind column accepts only gate or soft', ...)
test('the migration passes the lint', ...)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/data/criteria.test.ts`
Expected: FAIL — the tables do not exist.

- [ ] **Step 3: Define the three tables, generate `0002_criteria.sql`, and add `CriteriaSetConflictError`**

Map the unique-violation error code from the `postgres` driver onto `CriteriaSetConflictError` in the repository boundary, so callers never pattern-match a driver string.

- [ ] **Step 4: Migrate and run the tests**

Run: `bun run db:migrate && bun test tests/data/criteria.test.ts && bun run lint:migrations`
Expected: PASS, all seven, lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/data/schema/criteria.ts drizzle/0002_criteria.sql tests/data/criteria.test.ts
git commit -m "feat: add versioned criteria sets with requirements and detours"
```

---

## Task 9: Companies, positions, summaries and artefacts

**Files:**
- Create: `src/data/schema/positions.ts`, `drizzle/0003_positions.sql`
- Create: `tests/data/positions.test.ts`

**Interfaces:**
- Consumes: `workFormat`, `seniority`, `applyRoute`, `artefactKind` (Task 7).
- Produces: tables `company`, `position`, `positionSummary`, `artefact` per spec §7.4, and `normaliseName(value: string): string`.

- [ ] **Step 1: Write the failing tests**

```ts
test('normaliseName folds, lowercases and collapses punctuation', ...)
  // 'Acme  Inc.' and 'ACME-INC' both normalise to 'acme inc'
test('company name_norm is unique', ...)
test('two different roles with one title coexist via the disambiguator', ...)
  // same company_id and role_norm, different disambiguator -> both insert
test('the same company, role and disambiguator cannot be inserted twice', ...)
test('a position summary is one row per position', ...)
test('an artefact stores a locator and an access note but no credential column', ...)
  // the table has no column named password, token, key or secret
test('the migration passes the lint', ...)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/data/positions.test.ts`
Expected: FAIL — the tables do not exist.

- [ ] **Step 3: Define the four tables, implement `normaliseName`, and generate `0003_positions.sql`**

`normaliseName` is NFKD, lowercase, then runs of non-alphanumerics collapsed to a single space and trimmed.

- [ ] **Step 4: Migrate and run the tests**

Run: `bun run db:migrate && bun test tests/data/positions.test.ts && bun run lint:migrations`
Expected: PASS, all seven, lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/data/schema/positions.ts drizzle/0003_positions.sql tests/data/positions.test.ts
git commit -m "feat: add companies, positions, summaries and artefacts"
```

---

## Task 10: Scores, ratings and penalties

**Files:**
- Create: `src/data/schema/scores.ts`, `drizzle/0004_scores.sql`
- Create: `tests/data/scores.test.ts`

**Interfaces:**
- Consumes: `position` (Task 9), `criteriaSet` and `requirement` (Task 8), `penaltyKind` (Task 7).
- Produces: tables `positionScore`, `positionRating`, `positionPenalty` per spec §7.3.

- [ ] **Step 1: Write the failing tests**

```ts
test('a rating is one row per requirement, not a column', ...)
  // adding a requirement needs no migration: insert a new requirement and
  // a rating for it against an existing score
test('a rating accepts a null coverage', ...)
  // null means not rated and is distinct from 0
test('coverage outside 0..1 is rejected', ...)
test('a penalty amount above zero is rejected', ...)
test('one position holds scores against several criteria sets', ...)
test('re-scoring the same position and set on the same day is a no-op', ...)
  // UNIQUE (position_id, criteria_set_id, scored_at)
test('limiter_is_unknown defaults to false', ...)
test('the migration passes the lint', ...)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/data/scores.test.ts`
Expected: FAIL — the tables do not exist.

- [ ] **Step 3: Define the three tables and generate `0004_scores.sql`**

- [ ] **Step 4: Migrate and run the tests**

Run: `bun run db:migrate && bun test tests/data/scores.test.ts && bun run lint:migrations`
Expected: PASS, all eight, lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/data/schema/scores.ts drizzle/0004_scores.sql tests/data/scores.test.ts
git commit -m "feat: add scores with ratings as rows"
```

---

## Task 11: Dispositions and stage history

**Files:**
- Create: `src/data/schema/dispositions.ts`, `drizzle/0005_dispositions.sql`
- Create: `tests/data/dispositions.test.ts`

**Interfaces:**
- Consumes: `position` (Task 9), `setAsideReason`, `rejectionReason`, `stage` (Task 7).
- Produces: tables `positionDisposition`, `positionStageEvent` per spec §7.5 and §7.6.

- [ ] **Step 1: Write the failing tests**

```ts
test('a set-aside disposition requires a set-aside reason', ...)
test('a set-aside disposition rejects a rejection reason', ...)
  // the CHECK in spec §7.5 keeps the two authors apart
test('a rejected disposition requires a rejection reason', ...)
test('a position carries a disposition independently of its stage', ...)
  // set aside while sitting in a non-terminal stage
test('stage events are append-only and the latest one is the current stage', ...)
test('a repeatable stage can occur more than once for one position', ...)
  // which is what makes "this process had four steps" countable
test('the migration passes the lint', ...)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/data/dispositions.test.ts`
Expected: FAIL — the tables do not exist.

- [ ] **Step 3: Define the two tables and generate `0005_dispositions.sql`**

The disposition CHECK is the exact expression in spec §7.5. Its literals are a structural discriminator, so the lint permits them.

- [ ] **Step 4: Migrate and run the tests**

Run: `bun run db:migrate && bun test tests/data/dispositions.test.ts && bun run lint:migrations`
Expected: PASS, all seven, lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/data/schema/dispositions.ts drizzle/0005_dispositions.sql tests/data/dispositions.test.ts
git commit -m "feat: add the set-aside axis and stage history"
```

---

## Task 12: Origins, routes and first touch

**Files:**
- Create: `src/data/schema/provenance.ts`, `src/schemas/provenance.ts`, `src/entities/provenance.ts`, `src/provenance/first-touch.ts`, `drizzle/0006_provenance.sql`
- Create: `tests/data/provenance.test.ts`, `tests/provenance/first-touch.test.ts`

**Interfaces:**
- Consumes: `position` (Task 9), `route` (Task 7).
- Produces:
  - tables `searchRun`, `origin` per spec §7.7, with `position_id` nullable
  - `firstTouch(origins: readonly Origin[], today: Date): Origin | null`
  - a SQL view `position_first_touch` exposing `(position_id, origin_id, route_id, touched_on)`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/provenance/first-touch.test.ts
test('picks the earliest touched_on', ...)
test('a backdated conversation entered later takes over first touch', ...)
  // three origins: a query on the 10th recorded on the 10th, a recruiter
  // message on the 12th, and a friend conversation on the 3rd recorded on
  // the 14th -> the friend conversation wins
test('falls back to the query once the backdated origin is removed', ...)
test('breaks a touched_on tie by recorded_at then id', ...)
test('ignores an origin dated after today', ...)            // Review Focus 2
  // a typo of next year does not become first touch, and the row is
  // still returned by a plain read
test('returns null for a position with no origins', ...)

// tests/data/provenance.test.ts
test('an origin may exist before its position', ...)
  // position_id is nullable, then updated when the position is created
test('one position carries several origins through the same route on different dates', ...)
test('the position_first_touch view agrees with firstTouch for the fixture', ...)
test('the migration passes the lint', ...)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/provenance tests/data/provenance.test.ts`
Expected: FAIL — `firstTouch` is not exported and the tables do not exist.

- [ ] **Step 3: Implement `firstTouch`, define the two tables and the view, and generate `0006_provenance.sql`**

`firstTouch` filters out origins with `touched_on` after `today`, then takes the minimum of `(touched_on, recorded_at, id)`. The view applies the same ordering in SQL so the two cannot disagree; the test in step 1 pins that.

- [ ] **Step 4: Migrate and run the tests**

Run: `bun run db:migrate && bun test tests/provenance tests/data/provenance.test.ts && bun run lint:migrations`
Expected: PASS, all ten, lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/schemas/provenance.ts src/entities/provenance.ts src/provenance src/data/schema/provenance.ts drizzle/0006_provenance.sql tests/provenance tests/data/provenance.test.ts
git commit -m "feat: add route-keyed provenance with derived first touch"
```

---

## Task 13: App config and the pending re-score view

**Files:**
- Create: `src/data/schema/config.ts`, `drizzle/0007_config_rescore.sql`
- Create: `tests/data/rescore.test.ts`

**Interfaces:**
- Consumes: `criteriaSet` (Task 8), `position` and `positionScore` (Tasks 9, 10).
- Produces: tables `appConfig`, `rescoreRequest`, and a view `pending_rescore` exposing `(rescore_request_id, position_id)`.

- [ ] **Step 1: Write the failing tests**

```ts
test('app_config stores the criteria mode', ...)
  // 'versioned' or 'perspective', read back unchanged
test('pending_rescore lists positions seen on or after since_date with no score for the set', ...)
test('pending_rescore excludes a position already scored against that set', ...)
test('pending_rescore excludes a position seen before since_date', ...)
test('scoring a pending position removes it from the view without an update', ...)
  // the pending set is derived, so it cannot drift
test('the migration passes the lint', ...)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/data/rescore.test.ts`
Expected: FAIL — the tables do not exist.

- [ ] **Step 3: Define the two tables and the view, and generate `0007_config_rescore.sql`**

- [ ] **Step 4: Migrate and run the tests**

Run: `bun run db:migrate && bun test tests/data/rescore.test.ts && bun run lint:migrations`
Expected: PASS, all six, lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/data/schema/config.ts drizzle/0007_config_rescore.sql tests/data/rescore.test.ts
git commit -m "feat: add app config and the derived pending re-score view"
```

---

## Task 14: The first vanilla pack and its loader

**Files:**
- Create: `seeds/vanilla/web-search.json`, `src/seeds/load-pack.ts`
- Create: `tests/seeds/load-pack.test.ts`
- Modify: `package.json` (add a `seed:pack` script)
- Modify: `README.md` (create it: what the project is, how to run it, and that packs are opt-in)

**Interfaces:**
- Consumes: `criteriaSet`, `requirement` (Task 8), `layer` and the other registries (Task 7), `lintVanillaPacks` (Task 1).
- Produces: `VanillaPackSchema` in `src/schemas/scoring.ts`, and `loadPack(path: string): Promise<LoadResult>` where `type LoadResult = { criteriaSetId: number; requirementCount: number }`.

`seeds/vanilla/web-search.json` is a generic web-search criteria set: requirement keys, labels, layer keys and anchor text for coverage 0, 0.5 and 1, with every `weight` and the set's `applyThreshold` null. It carries no opinion about any employer, technology or working arrangement.

- [ ] **Step 1: Write the failing tests**

```ts
test('the shipped pack passes lintVanillaPacks', ...)
test('the shipped pack has a null weight on every requirement', ...)
test('the shipped pack has a null apply_threshold', ...)
test('loadPack inserts the set, its requirements and the layers it names', ...)
test('loadPack rejects a pack carrying a weight', ...)
  // a contributor's pack with judgement in it cannot be installed
test('loadPack is idempotent for the same pack', ...)
  // re-running raises CriteriaSetConflictError and changes nothing
test('a loaded pack scores a fixture position to a null overall', ...)
  // weights are null until the seed interview runs, so scoreAgainstSet
  // returns overall null and recommendApply false
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/seeds/load-pack.test.ts`
Expected: FAIL — `loadPack` is not exported.

- [ ] **Step 3: Write the pack, implement `loadPack`, and write the README**

`loadPack` validates with `VanillaPackSchema`, runs `lintVanillaPacks` on the file, creates the layers it names if they are absent, then inserts the set and its requirements in one transaction.

- [ ] **Step 4: Run the whole suite and the lint**

Run: `bun test && bun run lint:migrations`
Expected: PASS, every test, lint clean.

- [ ] **Step 5: Commit**

```bash
git add seeds/vanilla src/seeds src/schemas/scoring.ts tests/seeds package.json README.md
git commit -m "feat: add the first vanilla pack and its opt-in loader"
```

---

## Done, for this plan

`bun test` is green, `bun run lint:migrations` reports nothing, and
`docker compose up` plus `bun run db:migrate` leaves a database whose
twelve registries are empty, whose scoring functions are proved against
an invented fixture, and whose first-touch derivation agrees with its own
SQL view. That is the scaffold that runs.

The three plans that follow: **service** (auth, the MCP surface, the
internal HTTP layer, backups — unblocked as of 2026-11-03, on the
package pins in spec §5), **web app** (board, grid, modal, criteria
settings), and **market stats** (claims, thresholds, four importers, the
Stats surface).
