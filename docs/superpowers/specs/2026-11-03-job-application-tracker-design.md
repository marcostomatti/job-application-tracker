# job-application-tracker — design

Date: 2026-11-03
Status: awaiting approval
Author: design session with Marcos Tomatti

> **Renamed 2026-11-04: `position` is now `posting`.** The thing a user
> applies to is called `posting` in the schema, the code, the MCP tools
> (`posting_add`, `posting_search`, …) and the HTTP routes (`/postings`),
> so the service can later cover things that are not jobs. Every
> `position*` table, column, constraint, index, sequence and view below
> reads `posting*`; migration `0012_rename_position_to_posting.sql` does
> the rename and keeps existing rows. The old private app's
> `position_score` and other historical names are left as they were.

Supporting material, all in `.docs/research/` (gitignored):
`2026-10-28-landscape-summary.md` and `2026-10-28-tool-landscape.csv`
(38 scored tools and data sources), `2026-10-28-fanout-pool.md` (30
ideas, scored, with three deepened sketches),
`2026-10-28-scope-border-and-drivers.md`,
`2026-10-28-driver-inventory.md`, `2026-10-28-job-vocabulary.md`,
`2026-10-28-jsonld-check.md`, `2026-10-29-concept-map.md`.

This revision incorporates a builder check (a fresh engineer who tried
to plan a build from the first draft and reported what they would have
had to guess). Marcos answered three of its questions; §20 lists the
seven settled by the design session.

---

## 1. Intent, and why now

Marcos has run a private job-hunt tracker daily for two months: a Bun,
SQLite and React app holding 105 scored roles, their application chains,
and the texts he reuses. It works. It is not shareable, because its
schema, its seed and its data encode his scoring weights, his hard
gates, his red flags, and his opinions about specific employers and ways
of working.

This project is the shareable version: the template someone else clones
and fills with their own judgement, where his judgement never ships.
It is a fresh repository, not a port. The old app is reference material.

It is also wider in scope than the old one. It adds provenance for where
a lead came from, Stats over both the user's own funnel and the wider
market, criteria that carry versions, an MCP surface so an agent does
the work, and an auth layer so the service is not open by accident.

**The governing rule, which outranks every feature in this document:
the mechanism ships, the judgement never does.**

### Why the rule needs architecture, not discipline

An audit of the old schema found eleven leaks, two of them structural.
`position_score` held the five criteria as five named columns, so the
criterion set lived in the DDL and adding a criterion was a migration.
Three penalty kinds were three columns, one of them named after an
opinion about an industry. `position_gate` had a CHECK constraint
listing eight gate names that together form a portrait of one person.
`company.is_acme_client` was a boolean named after one company
group. A CHECK constraint that enumerates domain vocabulary is a leak by
construction, because a template's user cannot change it without writing
a migration.

So the rule becomes a schema property and a test, not a habit.

---

## 2. Goals

1. A local-first job-application tracker an agent drives, running on one
   person's machine, published as a template.
2. Every vocabulary is data the user owns. The template ships registries
   empty, or with clearly-labelled vanilla packs the user opts into.
3. Scoring that explains itself: a recommendation the user can act on,
   and the named reason behind it.
4. Criteria carry versions, and a score is only meaningful against the
   criteria it was scored under.
5. Provenance: where every lead came from, as a first-class record.
6. An MCP surface complete enough that an agent does the daily work
   without the user editing files.
7. Stats covering both the user's own funnel and the wider market, the
   second honest about how much it actually knows.
8. A React app organised by atomic design, with unit and visual tests.

## 3. Non-goals

- No users, roles or permissions. One API key is the whole auth model.
- No **public** REST API for the agent surface. The agent talks MCP. A
  thin internal HTTP layer exists for the web app (§11.2) and shares the
  same Zod schemas, so a public API can be added later without redesign.
- No hosted or multi-tenant deployment. Multi-tenant *scoring layers*
  are in scope; a multi-tenant *service* is not.
- No published Docker image or one-command install in this build.
  Compose plus documented setup is the path; packaging is a later task.
- Not a component library and not a design system. Atomic structure
  only.
- No importer for the old app's data. Nothing to migrate.

## 4. Anti-goals

Things that would make this a failure even if it worked.

- **Shipping any of Marcos's judgement.** Weights, gates, red flags,
  notes, employer opinions, preferences touching neurodivergency. This
  includes migration comments that cite his data ("93 rows", named
  companies) and enum members drawn from his history.
- **Shipping any of his infrastructure identity.** Device name, host
  name, IP address, self-hosted runner detail, credentials. See §12.3.
- **A single holistic score with no formula.** It cannot be recomputed,
  layered or versioned, which is the failure mode of the nearest prior
  art (`career-ops`).
- **An embedding "match %"** that hides the reason for a number.
- **Requiring a paid API key** to use the template.
- **Scraping any job board**, LinkedIn above all, whose terms forbid it.
- **Presenting a market claim the data cannot support.** At ~100 roles a
  position is present because one of the user's queries found it, so
  counting over those roles measures the queries. §10 makes this a
  mechanism rather than a caveat.
- **Auto-apply.** It opposes a deliberate search.
- **Lecturing the user.** From the rafa tenets: we help and guide, never
  hinder or lecture; the code is yours and we stay on the side.

Three ideas were considered and rejected as traps, recorded here so they
are not re-proposed: a bounty board for closing gaps (turns this into a
two-sided marketplace), a career-change futures curve (the forward
numbers have no source at one-person scale), and detour routing priced
per leg (the per-leg costs do not exist, so the cheapest route is a
guess wearing a price tag).

---

## 5. Constraints

| Constraint | Source |
|---|---|
| Postgres 16 in the Docker container; Drizzle with real migrations | Marcos, 2026-11-03 |
| Built on the published `@open-tomato` service packages, including the Express adapter for §11.2 | handoff brief |
| Zod schemas are the single source for MCP tool definitions and HTTP routes | MVP brief |
| Bun runtime; `package.json` currently carries only `@types/bun` | repo state |
| React organised `atoms` → `molecules` → `organisms` → `templates` → `pages` | the `components-library` project's `src/` |
| Component rules from `component-breakdown/skills/component-from-design/SKILL.md` — CVA variants, never per-instance Tailwind; one Storybook story per variant; visual baselines untracked and per-machine | relayed brief, finding 1 |
| Source files under 800 lines, functions under 50, immutable updates, no deep nesting | `~/.claude/rules/common/coding-style.md` |
| 80% test coverage, TDD | `~/.claude/rules/common/testing.md` |

### Resolved: the package pins

Pin the published packages from npm. Verified against the registry on
2026-11-03:

```json
"@open-tomato/service":         "^1.0.1",
"@open-tomato/service-mcp":     "^1.0.1",
"@open-tomato/service-express": "^1.0.2",
"@open-tomato/service-logger":  "^1.0.0"
```

Caret ranges pick up the pending releases when they land. **Do not
depend on `@open-tomato/service-errors`**, which exists only as an
unpublished 0.0.0 package on a local branch.

The builder check reported these packages as `service-core`, `mcp` and
`express` at 0.1.1. The mechanism, recorded so it does not recur: there
are two codebases. The standalone repo behind `github.com/open-tomato/service`
is the one that publishes to npm, and its workspace packages carry the
names above. A second, older in-monorepo copy under
`open-tomato/packages/service/` names its packages `service-core`,
`mcp`, `express`, `orchestration` and `worker-protocol` at 0.1.1, none
ever published, and three stale worktrees hold copies of that same tree —
which is why the wrong names turn up more than once.

**Read package names from npm or from the standalone repo, never from
the monorepo copy.** Local `package.json` files also run ahead of the
registry (the branch says 1.0.2 where npm serves 1.0.1), so the registry
is the source for versions.

---

## 6. The privacy architecture

Four mechanisms, in order of how hard they are to break.

### 6.1 No vocabulary in the DDL

A CHECK constraint may only enumerate a **closed structural** set:
booleans, a date shape, a numeric range, or an internal discriminator
whose members are defined by the code (for example a disposition kind of
`set_aside` or `rejected`, or an evidence direction of `up`, `down` or
`flat` — structure, not opinion).

It may never enumerate a gate name, a stack tag, an industry, a
criterion, a penalty kind, a stage, a phase, a route, a seniority or a
work format. Those are registry rows.

No column may be named after an industry, company, technology, language
or jurisdiction.

### 6.2 Registry and rows are separate tables

Every vocabulary is a registry table with a surrogate key, a label and an
`archived_at`. Every judgement is a row referencing it. The template
ships registries empty and rows never.

Archive rather than delete, so history stays readable after a user
renames their own vocabulary.

### 6.3 Vanilla packs, opt-in, and the rule that keeps them clean

Published seed packs carry generic defaults: a generic web-search
criteria set, and the engineering vocabulary as one layer on top of the
abstraction core. They install by explicit command, never by migration.
The user's real packs stay untracked.

**Acceptance rule for a shippable pack: structure and anchor text, with
every weight and every threshold null.** A criteria set with weights is
judgement by construction, so a pack may say *what* a requirement is and
*what a rating of 0, 0.5 and 1 would mean*, and may not say how much it
matters or where the apply line sits. The seed interview (§11.4) fills
those in from the user's own answers.

This is the sharpest form of the governing rule: the pack carries the
vocabulary and the rubric, the user carries the judgement.

### 6.4 A test that enforces it

A migration-lint test parses every file in `drizzle/` **and every pack
in `seeds/vanilla/`**, and fails on:

- a CHECK constraint containing a string literal that is not in the
  allowed structural set,
- a column name matching a denylist of industry, technology and
  jurisdiction words,
- a seed INSERT into any registry table inside a migration,
- a migration comment containing a digit-plus-"rows" pattern or a name
  from the repo's own `company` table,
- a vanilla pack carrying a non-null `weight` or `apply_threshold`.

This test is the reason the rule survives contributors. It is written
before the first migration.

---

## 7. The data model

Postgres. Table names singular, snake_case. Every table has `id`
(generated identity) unless it is a pure join. Timestamps are
`timestamptz`. Dates with no time are `date`.

### 7.1 Registries — ship empty

Each has `id`, `label`, `archived_at` unless noted.

| Table | Extra columns | Notes |
|---|---|---|
| `phase` | `key`, `sort`, `is_shortlist` | The board's columns. `is_shortlist` is the user-set flag for "the column a newly-recommended position moves into", so no phase name appears in code. |
| `stage` | `key`, `phase_id`, `sort`, `is_terminal`, `is_repeatable`, `is_traction`, `is_applied` | `is_traction` is what the funnel counts as "went somewhere". `is_applied` marks the stages that mean the user has committed, which is what protects a position from being moved by a re-score (§9.1). |
| `layer` | `key`, `sort` | Market, domain, company, person — as rows. |
| `route` | — | How a lead reached the user. |
| `set_aside_reason` | — | The user's own judgement about a lead. |
| `rejection_reason` | — | What the other side did. Separate; see §7.5. |
| `penalty_kind` | — | Replaces `penalty_cluster`/`penalty_fintech`/`penalty_other`. |
| `text_type` | — | Cover letter, form answer, and so on. |
| `artefact_kind` | — | Showcase subtypes: web page, repository, design file, model, audio. |
| `work_format` | — | Remote, hybrid, on-site, and whatever else a user needs. |
| `seniority` | `sort` | Ordered, because comparisons want it. |
| `apply_route` | — | Email, careers page, agency, form. |

No registry is referenced by a NOT NULL column, because a template
installs with all of them empty.

> **Amended 2026-11-04: a stage's flags belong to the stage, never to
> its phase.** `is_applied`, `is_traction`, `is_terminal` and
> `is_repeatable` are set on each stage and are not derived from the
> phase it sits in. A stage meaning "closed by a gate" sits in a
> resolved phase although nothing was ever sent, so a derivation from
> the phase marks it applied. A vanilla pack that ships a stage registry
> sets all four flags explicitly on every stage key. `registry_update`
> (§11.1) changes a row's label, sort, flags and a stage's phase in
> place; a `key` never changes, because other rows and imports refer to
> it, so a new key is an add plus an archive.

### 7.2 Criteria sets, requirements, detours

A **criteria set** is the versioned unit. A version is not a column on a
criterion; it is a whole set of requirements with their anchors and
weights.

```
criteria_set
  id, name, version (int), created_at,
  apply_threshold (numeric, null), is_default (bool), archived_at
  UNIQUE (name, version)

requirement
  id, criteria_set_id, layer_id, key, label,
  kind ('gate' | 'soft'),        -- structural discriminator
  weight (numeric, null; soft only),
  anchors (jsonb),               -- what coverage 0, 0.5 and 1 mean
  sort
  UNIQUE (criteria_set_id, key)

detour
  id, requirement_id, label,
  discount (numeric 0..1),
  cost_amount (numeric, null), cost_unit (text, null)
```

`anchors` is the Greenhouse-scorecard idea: rubric text separate from the
rater. It is what makes a weight meaningful to someone who did not write
it, and what a vanilla pack can usefully carry without carrying an
opinion.

**The criteria mode is application configuration, not a column here.**
It is one setting (`versioned` or `perspective`) in the app's own config
table, because §9 describes two whole-app behaviours rather than a
per-set property. Both modes ship.

### 7.3 Scores and ratings

Scores are not 1:1 with positions. A position has one score row per
criteria set per scoring pass.

```
position_score
  id, position_id, criteria_set_id, scored_at,
  overall (numeric 0..1, null),     -- normalised weighted sum: the recommendation
  limiter_requirement_id (null),    -- the named blocker: the explanation
  limiter_coverage (numeric, null),
  limiter_is_unknown (bool),        -- the limiter is only an unrated requirement
  runner_up_requirement_id (null),  -- what blocks next
  floor (numeric, null), ceiling (numeric, null),
  recommend_apply (bool),
  is_rescore (bool), note (text, null)
  UNIQUE (position_id, criteria_set_id, scored_at)

position_rating
  score_id, requirement_id,
  coverage (numeric 0..1, null),    -- null means not rated, not zero
  confidence ('supported' | 'partial' | 'unknown'),
  evidence (text, null)
  PRIMARY KEY (score_id, requirement_id)

position_penalty
  score_id, penalty_kind_id, amount (numeric <= 0), reason (text, null)
  PRIMARY KEY (score_id, penalty_kind_id)
```

Ratings are rows, not columns. That is the fix for the first structural
leak, and it is what lets a user add a criterion without a migration.

A gate is a `requirement` with `kind = 'gate'`. There is no separate gate
table, and no gate vocabulary in any constraint.

### 7.4 Companies, positions, summaries, artefacts

```
company
  id, name,
  name_norm (text),              -- NFKD-folded, lowercased, runs of
                                 -- non-alphanumerics collapsed to one space
  name_unresolved (bool),        -- a placeholder like "partner undisclosed"
  created_at
  UNIQUE (name_norm)

position
  id, position_key (unique), company_id, role_title, role_norm,
  disambiguator (text, default ''),   -- distinguishes two genuinely
                                      -- different roles with one title
  seen_at (date), deadline (date, null),
  city, country,
  work_format_id (null), seniority_id (null), apply_route_id (null),
  salary_raw, posting_age_raw, applicant_count_raw, apply_contact,
  priority_rank (null),          -- user-owned; no import writes it
  client_hidden (bool),
  first_imported_at, last_imported_at
  UNIQUE (company_id, role_norm, disambiguator)

position_summary
  position_id (PK),
  stack (jsonb),                 -- tags as data, no CHECK
  description (text),
  industry (text),
  condensed (text),              -- the bulk text, noise stripped, meat kept
  extra (jsonb),
  source_hash (text),            -- detects a changed posting
  summarised_at
```

The summary is one row per position rather than a column on `position`,
so a wide text payload does not load on every board query, and so its
schema can evolve on its own migration path.

**A repost does not create a second position.** The position stays one
row; a repost is a new `origin` row (§7.7) plus a changed `source_hash`.
That is what makes "was this reposted?" answerable without duplicating
the role.

```
artefact
  id, artefact_kind_id, label,
  locator (text),                -- URL, repo, drive path
  access_note (text, null),      -- how to get in; never credentials
  created_at
```

The tracker stores a **reference**, never the bytes: a model or an audio
file lives in a bucket or a drive, and the row points at it. One
`artefact` table with a `kind` registry, not one table per kind, because
the mechanics are identical across kinds.

> **Amended 2026-11-04: a company can be renamed and merged.**
> `company_update` changes `name`, recomputing `name_norm`, and
> `name_unresolved`. A new name whose `name_norm` another company holds
> is a conflict, and the fix is a merge. `company_merge` moves every
> posting of the losing company to the winning one and deletes the
> loser, in one transaction, and reports how many postings moved. A role
> both companies hold under one `role_norm` and `disambiguator` stops
> the merge before anything is written. The winner keeps its own `name`
> and `name_unresolved`, because the flag describes the name and the
> name kept is the winner's. Provenance that an import folded into a
> name, such as "via recruiter", belongs on the posting as an `origin`
> through a `route` row (§7.7), not in the company's name.
>
> **Added 2026-11-04: questions to ask about one posting.**
>
> ```
> posting_question
>   id, posting_id, question (text),
>   answer (text, null), answered_at (null), created_at
>   UNIQUE (posting_id, question)
> ```
>
> A question is written by hand, about one role, with the answer that
> came back. It is a different thing from `limiter_is_unknown` (§7.3),
> which is derived from an unrated requirement. Answers are the user's:
> adding a question the posting already has returns the stored row
> unchanged, so an import run twice neither duplicates a question nor
> overwrites its answer, and only `posting_question_answer` changes one.

### 7.5 The second axis: disposition

A lead passed on after a second look is neither resolved nor rejected —
nobody rejected the user. It is **set aside**, and the reason is the data
that refines a gate or a weight.

```
position_disposition
  id, position_id,
  kind ('set_aside' | 'rejected'),          -- structural discriminator
  set_aside_reason_id (null), rejection_reason_id (null),
  noted_at, note (text, null)
  CHECK (kind = 'set_aside' AND set_aside_reason_id IS NOT NULL
         AND rejection_reason_id IS NULL
      OR kind = 'rejected'  AND rejection_reason_id IS NOT NULL
         AND set_aside_reason_id IS NULL)
```

Two reason registries, not one, **because they do not share an author**:
a set-aside reason is the user's judgement about a lead, a rejection
reason describes what the other side did. Only the first kind is worth
mining to refine scoring, so one shared column would mix the user's
criteria with the market's behaviour.

The disposition is independent of the stage, so a set-aside card still
renders in the resolved column for continuity while the MCP can pull
"everything set aside, grouped by why".

### 7.6 Stage history

```
position_stage_event
  id, position_id, stage_id, occurred_at, note (text, null)
```

Append-only. The current stage is the latest event. Repeatable stages
(`is_repeatable`) are what make "this process had four steps" countable.

### 7.7 Provenance: origins and routes

Provenance is keyed on **routes**, not searches, because a designer or a
data scientist may hear about a role from a person.

```
search_run
  id, query (text), source (text), ran_at

origin
  id, position_id (null), route_id,
  touched_on (date),             -- when the person was reached; backdatable
  recorded_at (timestamptz),
  note (text, null),             -- the query string, or "Dana, staff room poster"
  search_run_id (null)           -- set for machine-run queries
```

A machine query and a corridor conversation are the same shape: a dated
touch through a named route. A position reached through several doors has
several rows, none merged. **First touch is derived, never stored as a
flag**: the origin with the smallest `(touched_on, recorded_at, id)`, so
ties resolve deterministically and a conversation remembered later and
backdated can correctly take over.

`position_id` is nullable so an origin may exist before its position
does and attach later, because human leads often start as a conversation
with no posting behind it.

The known risk is recorded with the design: logging a query is free and
logging a conversation is not, so the counts drift toward the
easy-to-log routes. The mitigation is a capture-time prompt (§11.3),
not a schema change.

### 7.8 Texts, re-score requests, app config

```
text_asset
  id, text_type_id, label, body (text), version (int), created_at
  -- bodies are personal by default and never ship

text_asset_posting                 -- added 2026-11-04
  text_asset_id, posting_id, linked_at
  PRIMARY KEY (text_asset_id, posting_id)

rescore_request
  id, criteria_set_id, since_date (date), created_at, completed_at (null)

app_config
  key (PK), value (jsonb)
  -- holds the criteria mode, and the backup retention setting
```

A position is **pending re-score** for a request when its `seen_at` is on
or after `since_date` and it has no `position_score` for that
`criteria_set_id`. Derived by view, not stored, so the pending set cannot
drift out of sync.

> **Added 2026-11-04: which text was used for which posting.**
> `text_asset_posting` links one version of a text to one posting: the
> link names the version row, because that is the wording that was sent.
> Linking twice is a no-op. `text_list` takes a `posting_id` and then
> lists exactly the versions linked to that posting.

### 7.9 Market claims and evidence (§10's schema)

```
channel
  id, key (unique), label,
  kind ('own_search' | 'inbound' | 'referral' | 'imported_series'),
  derived_from (null -> channel.id),   -- declared upstream
  source (text, null), licence (text, null), period (text, null),
  added_at

market_claim
  id, subject (text), predicate (text), claim_kind (text),
  created_at, archived_at

claim_evidence
  id, claim_id, channel_id, observed_at (date),
  window_days (int),                   -- when this observation goes stale
  direction ('up' | 'down' | 'flat'),  -- agreement is on direction
  magnitude (numeric, null), note (text, null)

claim_threshold
  claim_kind (PK),
  min_channels (int, null),
  min_observations_per_channel (int, null),
  requires_non_self_channel (bool, null)
  -- ships with the field names and NO numbers

series_import
  id, channel_id, source_key (text), imported_at,
  period_start (date), period_end (date), row_count (int), licence (text)

series_observation
  id, series_import_id, subject (text), period (date),
  value (numeric), unit (text)
```

`claim_threshold` shipping with null numbers means every claim computes
as below threshold until the user sets their own bar. That is the
governing rule applied to statistics: the mechanism ships, the bar is
the user's.

---

## 8. Scoring: how a number and a reason are produced

One pure function per criteria set, with no database access, tested
against fixtures before any table exists.

```
scoreAgainstSet(requirements, ratings, detours, penalties, threshold)
  -> { overall, limiter, limiterIsUnknown, runnerUp,
       floor, ceiling, recommendApply }
```

**Effective coverage** of a requirement is the larger of its direct
coverage and its best detour's coverage times `(1 - discount)`. So a
detour can lift a gate, but never to full strength.

**The limiter** is Liebig's law of the minimum: the requirement with the
lowest effective coverage. The runner-up is kept so the user can see what
blocks next.

**Layers group for reporting, and change no arithmetic.** The minimum
over layers of the minimum within a layer equals the flat minimum over
all requirements, so the layer is what produces the per-layer coverage
bar in the UI and the "which layer failed" answer on a debrief — not a
separate aggregation. Stated explicitly because the first draft left it
ambiguous.

**The overall is normalised** to 0..1: the weighted sum of effective
coverages over rated `soft` requirements, divided by the sum of those
requirements' weights, minus penalties. Normalisation is required because
§9.2 compares `overall` across criteria sets with different weight
totals, and because `apply_threshold` has to mean the same thing in every
set.

These two are not rivals. The sum is the **recommendation**; the limiter
is the **explanation** of that recommendation. Both read the same
`position_rating` rows, so nothing is duplicated.

**Unknowns are not zeros.** A `coverage` of null means not rated.
`floor` counts nulls as 0 and `ceiling` counts them as 1. When the
limiter is a null-coverage requirement, `limiter_is_unknown` is set,
which turns the gap into a question to ask rather than a silent penalty.

**An unrated gate blocks.** `recommend_apply` requires
`overall >= apply_threshold` **and** every `gate` requirement at
effective coverage above 0 **and none of them unrated**, because a hard
gate nobody has checked is not a gate that passed.

**Across sets:** a position is recommended for apply if at least one
**non-superseded** criteria set puts it over that set's own threshold.
Non-superseded means the highest `version` for a given set `name`, so an
obsolete v1 score cannot keep recommending a position after v2 says
otherwise.

**The risk this stands on**, stated so it is not discovered later: the
minimum is honest only if the requirement list is complete and the
anchors are comparable across layers. A missing requirement hides the
true blocker, and loose anchor text makes one layer look scarcer than it
is. A career decision resting on that would be resting on a calibration
artefact. The mitigation is anchor text as a required field on every
requirement, plus the per-layer coverage bar so a suspiciously scarce
layer is visible.

> **Added 2026-11-04: reading a final score on another scale.** Every
> tool that returns a final score takes an optional `scale`: `ratio`
> (the default and the stored unit, 0..1, unrounded), `stars` (0..5, one
> decimal), `percent` (0..100, whole numbers) or `basic` (0.00..10.00,
> two decimals). It scales `overall`, `floor`, `ceiling` and any
> `apply_threshold` the response carries. A rating's `coverage`,
> `limiter_coverage` and penalty amounts stay 0..1, because they are
> individual ratings and adjustments, not the final score. A score and
> a threshold go through the same rounding, which never reverses their
> order but can show two close values as equal; `recommend_apply` is
> always computed from the stored values, and no tool accepts a scaled
> value as input, so no round trip can change a recommendation. The
> conversion lives in one module, and the web app's scale selector
> offers the same four values.
>
> A letter grade is left out. The usual letter scale passes at 0.60,
> while an apply decision sits wherever the user's threshold is, often
> well above that, so a score just short of the threshold would read as
> a failing letter. Letters for job fit need boundaries anchored to the
> threshold, which is a separate design question nobody needs yet.

### 8.1 Pipeline-level reads

- How many positions each requirement limits.
- What-if: mark a requirement closed, see which positions flip and what
  the next limiter becomes.
- Bottlenecks ranked by unlock-per-cost using `detour.cost_amount`, so a
  gate blocking twelve positions that needs four years ranks below one
  blocking six that needs a three-month course.

---

## 9. The two criteria modes

The mode is one app-level setting in `app_config`.

### 9.1 `versioned` — the default

Newest score wins. A position shows its most recent score row, with a
dropdown for older ones and a visible "re-scored" label. The criteria
dropdown lists version plus date, newest marked "latest". Old versions
are preserved, because a score only means something against the criteria
it was scored under.

The settings screen for the newest criteria carries a
**"re-score since &lt;date&gt;"** button, which creates a
`rescore_request`, putting matching positions into the derived pending
state for the agent to pick up on request.

If a re-score lifts a previously skipped position to apply, it moves to
the phase flagged `is_shortlist` — **unless** its current stage is
flagged `is_applied`, resolved or not, in which case it stays where it
is. Both conditions read user-set booleans, so no phase or stage name
appears in the code.

### 9.2 `perspective` — several sets live at once

A criteria set is a lens the same positions are seen through.

- A criteria set becomes a filter in the main sort and search area. One
  set is still the default (`is_default`).
- Selecting a set returns only positions that have a score row for it.
- **"All criteria"** shows everything, each row labelled with the set it
  matched.
- A position matched under several sets shows the label of its
  best-scoring set plus a **"+n" chip**. The chip opens a popup listing
  each set with that set's `overall`, and a link through to the card
  with that set selected.
- Criteria sets may define different requirements and gates, so the
  table gets a **second visualisation mode**: one row per position with
  pills showing each set and its score in alternating contrast tones,
  with that set's gates and flags listed the same way.
- The same perspective handling applies to the other report and
  visualisation modes.
- **Column membership is unaffected.** Only the apply-or-skip
  recommendation changes.

---

## 10. Stats — both halves, experimental

Marcos chose both halves for this build, with the cost stated: the
market half is four importers plus the six tables in §7.9, roughly
doubling the work. They stay visibly apart in the UI.

### 10.1 The own-funnel half is exact

Positions grouped by route and by first touch per month, with how many
of each group reached a stage flagged `is_traction`, **always printing
the group size**. A rate below a minimum n renders as "too few to say".
A second column counts positions with *any* touch through a route in the
month, so a door that opens a lead late is not erased by an earlier
door. What this reports is which doors lead anywhere — not how often the
user searched.

### 10.2 The market half needs outside data

A position is in the database only because one of the user's queries
found it, so the market half reads imported series instead.

Four importers, each writing `series_import` plus `series_observation`
and registering one `channel`:

1. **Indeed Hiring Lab** — CC BY 4.0, periodic index data.
2. **Hacker News "Who is hiring?"** — a decade of monthly posts, so a
   real time series; software and startups only, and reuse terms are
   unchecked, so this importer carries that note in its own docs.
3. **Adzuna** — free key the user registers themselves.
4. **O\*NET / ESCO** — occupation and skill vocabulary, CC BY 4.0 and
   free respectively. This one seeds claim subjects rather than supplying
   demand data.

Lightcast and TheirStack are paid and therefore optional adapters only,
never a dependency.

### 10.3 The mechanism that keeps a claim honest

A market claim is a row with a subject, a predicate and evidence items,
each carrying a channel. An **independent channel** is the pair of *who
chose what to look at* and *which corpus it was read from* — so every
query the user ran counts as **one** channel (`kind = 'own_search'`),
however many queries or sites it spans, because the same person chose
all of them. A recruiter message, a referral, and each imported series
add one more.

Thresholds live in `claim_threshold` with the field names and no
numbers, so a claim is below threshold until the user sets their bar.
Below threshold the claim stays fully readable but muted, with one quiet
line — "from your searches, 1 of 3 channels" — that expands to list the
channels still missing. No warning icon and no modal: the line says
where the data came from and does not tell the user what to think of it.

Channels declare `derived_from`, and channels sharing an upstream
collapse before counting, because two sources carrying the same postings
would otherwise fake a quorum. Evidence carries `window_days` and goes
stale, so a claim can fall back below threshold. Agreement between
channels is on `direction`, not on magnitude.

---

## 11. The agent and app surfaces

### 11.1 MCP

The MCP server is a `createMCP({ setup })` call on the `@open-tomato`
MCP package, which already provides Zod-validated config, transport
selection, a health endpoint and graceful shutdown.

Every tool's input is a Zod schema in a shared `schemas/` layer, used by
the MCP tool definition and by the HTTP layer below. Validation runs
before any CRUD reaches the data layer. Every collection tool has a
**bulk and a single** form, so an agent inserts or updates many rows in
one call.

Grouped by what they touch:

1. **Positions** — add, get, search, update; bulk and single.
2. **Summaries** — write and read `position_summary`, including
   `source_hash` so a changed posting is detectable.
3. **Scores** — score against a set, re-score, read history, read the
   pending re-score set.
4. **Criteria** — read sets and requirements, create a new version,
   update a requirement, set the default set, read and set the mode.
5. **Registries** — read, add and archive rows in every registry from
   §7.1. This is the headless-CMS part.
6. **Texts** — read, add, update `text_asset`.
7. **Stages and dispositions** — read and update a position's stage; set
   a position aside with a reason; read the set-aside bucket grouped by
   reason, so an agent can refine scoring, ask the user, or ignore it.
8. **Origins** — `record_origin`, read routes.
9. **Search runs and checks** — record a run; ask whether a role was
   already applied to, whether a posting changed, whether it was
   reposted.
10. **Claims and series** — add a claim, attach evidence, run an
    importer, read a claim with its channel count and threshold state.

> **Amended 2026-11-04: tools found missing once an agent drove the
> service.** Registries gain `registry_update` (§7.1). A **companies**
> group holds `company_update` and `company_merge` (§7.4). Positions
> gain `posting_question_add`, `posting_question_add_bulk`,
> `posting_question_answer` and `posting_question_list`, and
> `posting_get` returns a posting's questions. Texts gain `text_link`
> and `text_link_bulk`, and `text_list` filters by posting (§7.8). The
> score reads, `posting_get`, `posting_search` and `criteria_sets` take
> `scale` (§8). These are MCP tools only: §11.2's route table is
> unchanged, and the web plan adds a route when a screen needs one.

### 11.2 The internal HTTP layer

A browser cannot speak MCP over stdio, and the board writes: a stage
change, and the "re-score since" button. So a thin HTTP layer on the
`@open-tomato` Express adapter serves the web app, reading the **same
Zod schemas** as the MCP tools and calling the **same** repository
functions. It is internal, not a published API (§3), and it is roughly
one route per MCP tool the UI needs — about twenty.

The app is served by the same Bun process as the API, so there is one
origin, one port and no CORS configuration in the template.

**Express rather than Next.js with server-side rendering**, decided
2026-11-03 and recorded because it is the kind of question that gets
reopened.

The measurement first: in the existing PoC the whole list view
serialises to 141,406 bytes of JSON for 106 positions — about 1.3 KB per
row, roughly 25 KB gzipped, over loopback. At that size there is no
payload worth withholding.

The decisive argument is the interaction shape rather than the size. The
cards are static in content but not in placement: sorting and filtering
run client-side across the full row set, so a card cannot be an
independently cached server fragment when its row position depends on
client state, and the client needs every row regardless. The table's
sorting, the board's drag-and-drop and the filter bar are all
interactive, so under Next.js they would be client components anyway and
would opt out of the feature being considered. The other wins are
absent: no SEO value on a loopback binding, no network latency to hide,
no shared cache with one user. Re-scoring argues the same way — it
touches a handful of rows, and refetching the whole list costs 25 KB.

**The threshold where this flips, as a number rather than a feeling:**
at 1.3 KB per row, around 5,000 positions the list payload reaches about
6.5 MB and shipping it all becomes the bottleneck. The fix then is
server-side sorting, filtering and pagination in SQL behind the same
Express API, which is framework-independent. SSR would only become right
if the app also went hosted and multi-user, which §3 rules out.

Against that, Next.js would have cost three concrete things: Storybook
and visual-regression baselines are more awkward across server-component
boundaries, which fights the one-story-per-variant rule in §5; two build
systems where one process serves the API, the MCP transport and the
static bundle; and its adapter does not exist in published form.

### 11.3 Capture: agent paste

**The shipped default is agent paste.** The user opens a posting and
hands the URL or the text to the agent, which summarises it, scores it
and records its origin. No DOM capture and no bookmarklet ships, so
nothing in the template can cost a user their account.

A driver contract still exists for sources that allow programmatic
reads, and its shape is small: yield postings, each carrying the
provenance (query, source, date) of the search that found it. Candidate
drivers already scored in the research: the Greenhouse, Lever and Ashby
public board APIs, which need no auth for reads, and
bring-your-own-key aggregators.

**Adding a position must record an origin**, asking how the lead reached
the user, offering existing route labels, and proposing a new registry
row rather than writing free text. That is the mitigation for §7.7's
logging-effort risk: tagging happens when memory is freshest.

**The project ships tested drivers and tools for writing your own**, and
states that it takes no responsibility for third-party drivers: an
unknown driver risks the user's accounts if it breaks a source's terms,
and risks the agent's context if it carries malicious content.

**A disclaimer ships with the source list**, as a later sub-task once
that list settles: the shipped sources are not intended for automation
or scraping, and the recommended use is manual copy-paste where the
source allows it.

**Enrichment is a pluggable search driver.** A second pass over saved
jobs backfills company information and jobs saved without full data or a
score. The template ships the interface and the provenance recording;
the user points it at their own SearXNG or anything else answering the
contract. Marcos's own instance stays configured locally and nothing
about his homelab ships. The pass records what it searched, so
enrichment has provenance too.

### 11.4 The seed interview

The template ships registries empty, and an agent session fills them by
asking the user what they want, what they like, what they have struggled
with, and what their hard limits are. It must feel like questions and
answers, not hand-editing files. It is a documented prompt plus the
registry tools, not new machinery.

It also accepts a starting pack: the user names their field, a vanilla
pack pre-fills structure and anchors (with null weights, per §6.3), and
the interview fills in the weights and thresholds.

---

## 12. Auth, backups, and infrastructure privacy

### 12.1 Auth, born with the service

One API key in an environment variable, matched by an authentication
layer in front of the HTTP surface. No users, roles or permissions.

**What the key actually guards, stated plainly.** On an HTTP transport
the key is checked per request. On a stdio transport there is no request
to carry a header, so process-level access is the control there and the
key is inert. The local web client reaches the API on loopback without a
key, which is Marcos's explicit choice ("the client stays open for
now"). So the key protects a non-loopback deployment, and the honest
summary is: it makes exposing the service deliberate rather than
accidental.

A bootstrap script, `bun run setApiKey --burn-after-reading`:

1. generates a key,
2. writes it into `.env`,
3. prints it to the terminal,
4. clears it from stdout after a timeout.

The output text must make an agent understand it has to read the value
immediately. A human recovers it any time with `cat .env`.

### 12.2 Backups

`pg_dump` on a schedule inside the container, with a retention policy
that replaces rather than accumulates: keep the last N, default to a
fortnightly replace. Configurable through `app_config`, and off by a
single setting.

### 12.3 Infrastructure privacy — a hard constraint

Same standing as the data rule. Device name, host name, IP address and
any self-hosted runner detail must never reach GitHub or be tracked.
Visual-regression baselines are untracked and per-machine.

**Visual tests run locally only** unless the public IP can be shown
untraceable *and* the runner can be shown unusable by a third party. CI
therefore runs unit tests and the migration lint; visual tests are a
local command.

The self-hosted runner is one example to generalise from. The test to
apply to anything new: would this value identify the machine, the
network or the person? If so it does not get committed, and a vanilla
default ships in its place.

---

## 13. The web app

React, organised `atoms` → `molecules` → `organisms` → `templates` →
`pages`, following the `components-library` project's `src/`
without building a component library.

Component rules come from
`component-breakdown/skills/component-from-design/SKILL.md`: styling by
CVA variants and never per-instance Tailwind tweaks, one Storybook story
per variant, side-by-side design comparison, visual baselines untracked.
`design-to-code` is an optional CLI, not a prerequisite.

Screens: a board by phase, a grid with expandable rows, a position card,
a criteria settings screen, and a Stats surface marked experimental with
its two halves kept apart.

### 13.1 Board and modal requirements

1. A card open in the modal, or selected for a stage change, carries a
   thick white border.
2. The open modal has a chevron-up and chevron-down pair beside the
   close button, separated by a wide margin so neither is misclicked
   when aiming for the other. They move through the column the card
   currently sits in. At either end of the column, the button pointing
   that way is disabled.
3. The position summary (§7.4) surfaces as a tab or side panel inside
   the existing modal and expanded row — conceptually side by side with
   the job-details card, never a new screen, and without overloading the
   existing components.
4. A set-aside card still renders in the resolved column alongside
   rejected ones, for continuity and quick recollection of status.

### 13.2 Tests

Unit tests for the scoring functions, the first-touch derivation, the
channel counting and the threshold evaluation. Visual tests per
component variant, local-only per §12.3. 80% coverage minimum.

---

## 14. Scope border for other domains

A field is **inside** the template's reach when it overlaps heavily with
the engineering flow and adds either no new artefact type, or a small set
that fits as a subtype of one the schema already has.

The graphic designer is the representative example of that test, not a
build list. Candidates for the same test: data analysis, devops, data
science, music.

**The one new thing nearby fields share** is things to show: a portfolio,
repositories, models, audio. Same mechanics as the links and text answers
already present, so a subtype rather than a new system — which is why
§7.4 has one `artefact` table with an `artefact_kind` registry.

**The nurse is the contrast case and stays outside for now.** Legally
valid certifications and verified employment references have a different
shape: an issuing body, a jurisdiction, an expiry, and a verification
step. The border stays open: the schema neither builds for it nor blocks
it.

Stage differences — committee waits, fixed hiring cycles, sales
cadence — do not decide the border, because per-user stage registries
cover them.

**Engineering is a layer, not the core.** The abstraction core is jobs
and postings, provenance, a rubric with layers, a profile with weights
and gates, typed artefacts, per-user stages. Engineering vocabulary is a
seed pack on top. Other packs should be small differences from it rather
than rewrites.

---

## 15. Repository shape

```
drizzle/              migrations, and the lint test that guards them
src/
  schemas/            Zod: one source for MCP tools and HTTP routes
  entities/           domain types, no IO
  scoring/            pure functions: limiter, overall, floor/ceiling
  provenance/         first-touch derivation, route counting
  claims/             channel counting, threshold evaluation, staleness
  importers/          one module per outside series
  data/               Drizzle repositories
  mcp/                createMCP setup, tools grouped as in §11.1
  http/               internal routes for the web app (§11.2)
  auth/               API key layer, setApiKey script
  backup/             pg_dump schedule and retention
  web/
    atoms/ molecules/ organisms/ templates/ pages/
seeds/
  vanilla/            opt-in generic packs, lint-checked per §6.4
examples/             routes.engineer.json, routes.designer.json
docs/superpowers/specs/
.rafa/                rafa port: config, plans, specs, instincts, effort, runs
```

Clean architecture: schemas, entities and types are separate layers, and
the data layer is reached only after validation.

---

## 16. Build order

Each step is testable before the next begins.

1. **The migration lint test** (§6.4), before any migration exists. It is
   the rule made mechanical.
2. **The scoring functions** (§8) as pure code with Zod schemas, tested
   on a fixture of about six positions including one tie, one detour, one
   unrated gate and one unknown-only limiter. The tables are derived
   from the shapes these need.
3. **Registries and migrations** (§7.1–7.2), shipped empty, plus the
   first vanilla pack as an opt-in seed.
4. **Positions, companies, scores, ratings, dispositions** (§7.3–7.6).
5. **Origins and routes** (§7.7), with the first-touch test: one position
   with three origins where a backdated conversation must win, then the
   same after deleting it.
6. **Auth and the MCP surface** (§11.1, §12.1), on the pinned packages
   in §5.
7. **The internal HTTP layer** (§11.2), one route per tool the UI needs.
8. **Backups** (§12.2).
9. **The web app** (§13), board and grid first.
10. **Claims and thresholds** (§7.9, §10.3) with no importers yet, so the
    muted "from your searches" label works from own-search alone.
11. **The importers** (§10.2), one at a time, cheapest first: Hacker News,
    then Adzuna, then Indeed Hiring Lab, then O\*NET/ESCO.
12. **The Stats surface** (§10), both halves, marked experimental.

Steps 10 to 12 are parallelisable with 9 once step 5 lands.

---

## 17. Left to the builder

- Index choices, beyond the natural keys and foreign keys named here.
- The exact `jsonb` shape of `position_summary.stack` and `extra`.
- Error-type taxonomy and how it maps to MCP error responses.
- Transport choice for the MCP server, from what the package offers.
- Whether `rescore_request` pending sets are a view or a function.
- CVA variant names and the Tailwind token set, following the
  component-from-design skill.
- The retention default for backups beyond "replace, do not accumulate".
- Each importer's polling cadence and its own on-disk cache shape.
- Test fixture data, which must be invented rather than taken from the
  old app.

## 18. Marcos's decisions, dated

| Date | Decision |
|---|---|
| 2026-10-29 | Two reason vocabularies, set-aside and rejection, not one |
| 2026-10-29 | The four board and modal requirements in §13.1 |
| 2026-11-03 | Postgres in Docker, not SQLite |
| 2026-11-03 | Provenance keyed on routes, not searches |
| 2026-11-03 | Enrichment as a pluggable search driver, not a required SearXNG |
| 2026-11-03 | `perspective` mode ships in this build, alongside `versioned` |
| 2026-11-03 | Capture ships as agent paste only |
| 2026-11-03 | Both Stats halves in this build, cost acknowledged |
| 2026-11-03 | Compose plus documented setup; no published image in this build |
| 2026-11-03 | Pin the published `@open-tomato` packages from npm, per §5 |
| 2026-11-03 | Express serving a bundled React UI, not Next.js with SSR, per §11.2 |
| 2026-11-04 | `position` renamed to `posting` throughout, so the service can reach beyond jobs |
| 2026-11-04 | Final scores readable as ratio, stars, percent or basic; letter grades left out (§8) |

## 19. Settled by the design session, flagged for checking

These were the builder check's questions that the conversation or the
project already answered, or that a sensible builder could settle. Each
is called out so Marcos can disagree while reading.

1. **The web app talks to an internal HTTP layer** (§11.2). The brief's
   "a REST surface can come later" was about the agent surface, not the
   web client; a browser cannot speak MCP over stdio, so the alternative
   does not exist.
2. **Board column semantics are user-set booleans** —
   `phase.is_shortlist` and `stage.is_applied` (§7.1) — because keying
   off a phase name in code would put vocabulary back into the code and
   break the governing rule.
3. **`overall` is normalised to 0..1** (§8), because §9.2 compares it
   across sets with different weight totals.
4. **Layers group for reporting and change no arithmetic** (§8), stated
   explicitly because min-of-min equals a flat min.
5. **An unrated gate blocks apply** (§8), with `limiter_is_unknown` on
   the score row, because a hard gate nobody checked is not a gate that
   passed.
6. **The criteria mode is one app-level setting**, not a column on
   `criteria_set` (§7.2), because §9 describes whole-app behaviours.
   The apply rule counts only non-superseded sets.
7. **A vanilla pack ships structure and anchors with null weights and
   null thresholds** (§6.3), and the lint enforces it, because a
   weighted criteria set is judgement by construction.
8. **A repost is not a second position** (§7.4): a new origin row plus a
   changed `source_hash`. `position` gains a `disambiguator` so two
   genuinely different roles with one title can coexist, and `company`
   is defined.
9. **One `artefact` table with a kind registry**, not one table per
   kind, because the mechanics are identical.
10. **`position_summary` as its own table**, so wide text does not load
    on board queries.
11. **`phase` as a registry**, which the old app had as a CHECK.
12. **Archive rather than delete** on every registry, so renames keep
    history readable.
13. **Dispositions as one table** with a structural `kind` discriminator
    and two reason foreign keys, rather than two tables.
