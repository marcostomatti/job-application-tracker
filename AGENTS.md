# Instructions for agents

This file is for any agent that drives the tracker: Claude, Codex or another. It says what the
tracker is, the order of work, what you must never write, and how to give a recommendation.

## The tracker is the record

The tracker is an MCP server over a Postgres database of one user's job search. MCP (Model
Context Protocol) is the way an agent calls the server's tools. The database holds postings,
scores, stage history, questions about postings and reusable texts. When the tracker and the
conversation disagree, the tracker is right, so read it before you answer from memory.

The server starts with `bun run mcp`. The README explains the transports and the two shapes of
error a tool can return. With Open Notebook configured, twelve `notebook_*` tools are added for
long text such as full postings and a CV; see [docs/open-notebook.md](docs/open-notebook.md).

## Tool families

Each family is a group of tools that work on one kind of record:

| Family | Tools | What they hold |
|---|---|---|
| Postings | `posting_add`, `posting_add_bulk`, `posting_get`, `posting_search`, `posting_update`, `posting_update_bulk` | One row per role at one employer |
| Companies | `company_update`, `company_merge` | Employer names, cleaned or merged |
| Origins | `origin_record`, `origin_record_bulk`, `origin_attach`, `origin_list`, `origin_first_touch`, `route_counts`, `search_run_record` | How and when a lead reached the user |
| Checks | `check_already_applied`, `check_reposted`, `check_posting_changed` | Yes/no answers before acting |
| Summaries | `summary_write`, `summary_write_bulk`, `summary_get` | The condensed posting |
| Criteria | `criteria_sets`, `criteria_requirements`, `criteria_version_create`, `criteria_requirement_add`, `criteria_requirement_update`, `criteria_set_default`, `criteria_mode_get`, `criteria_mode_set` | The rubrics postings are scored against |
| Scores | `score_posting`, `score_posting_bulk`, `score_verdict_set`, `score_history`, `score_best`, `rescore_request`, `rescore_pending` | Ratings, the overall value and the verdicts |
| Questions | `posting_question_add`, `posting_question_add_bulk`, `posting_question_list`, `posting_question_answer` | Questions to ask the employer about one posting |
| Stages | `stage_current`, `stage_append`, `stage_append_bulk`, `posting_set_aside`, `posting_reject`, `set_aside_list` | Where a posting stands, and why it was dropped |
| Texts | `text_list`, `text_add`, `text_add_bulk`, `text_update`, `text_link`, `text_link_bulk` | Reusable wording, such as a cover letter |
| Registries | `registry_list`, `registry_add`, `registry_add_bulk`, `registry_update`, `registry_archive` | The user's own lists: stages, routes, reasons |
| Stats and settings | `market_stats`, `stats_ask_floor_set`, `settings_get`, `settings_update` | Aggregates, the ask floor and the display choice |

A bulk tool takes up to 500 items and is all or none: if one item fails, nothing is written and
the error names the item by its index. Prefer a bulk tool whenever you have more than one item.

## The normal order of work

A new posting goes through these steps. The prompts in `docs/prompts/` follow the same order.

1. **Check it is new.** `posting_add` refuses a role that already exists at the same employer,
   and the conflict names it. When the role looks familiar, find it first (`posting_search`),
   then ask `check_already_applied` and `check_reposted` with its id. A repost is not a new
   posting: record the new sighting with `origin_record` on the existing one.
2. **Add it.** `posting_add` (or `posting_add_bulk`), then `origin_record` for how it arrived.
3. **Summarise it.** `summary_write`. Before re-summarising a posting the tracker already has,
   `check_posting_changed` tells you whether the text changed.
4. **Score it.** Read the set with `criteria_requirements`, then `score_posting` with your
   ratings and your verdict (see below).
5. **List the questions.** `posting_question_add_bulk` for what the posting leaves unknown and
   the user should ask the employer.
6. **Stages.** Move a posting only when the user tells you to (see the next section).

## Fields you must never write

Some records belong to the user, the operator of the tracker. You read them, and you write them
only when the user tells you to, in this conversation, for that posting.

- **Stage history.** `stage_append` and `stage_append_bulk` add a stage event, and history is
  append-only: an event is never edited or removed. Append one only on the user's explicit
  instruction ("I applied to Example AB today"). The same goes for `posting_set_aside` and
  `posting_reject`, which record the user's decision. One move is automatic: `score_posting`
  moves a posting to the shortlist when its score recommends applying. That move is the
  server's, so do not repeat it by hand.
- **Answers to posting questions** (`posting_question.answer`). Answers are the user's.
  `posting_question_answer` is the only tool that changes one; call it only with the answer the
  user gave you, in their words. Never answer a question yourself, and never pass an answer to
  `posting_question_add`.
- **Priority rank** (`posting.priority_rank`). It is the user's own hand-ranking of postings.
  Only `posting_update` can set it, and no add or import path accepts it. Leave it alone unless
  the user asks you to set a rank.

## Scoring and the two recommendations

A criteria set is a versioned rubric. It has requirements in layers, and each requirement has a
kind, a weight and anchors:

- A **gate** is pass or block. A posting whose gate is rated 0, or not rated, cannot pass.
- A **soft requirement** is rated from 0 to 1 against its anchors and counts in proportion to
  its weight.
- **Anchors** say in words what a rating of 0, 0.5 and 1 means.

A score therefore carries an overall value, the requirement that limits it most, and
`recommendApply`. Every score can then show two recommendations side by side:

- The **rules recommendation** is computed by the server from the score. It is `apply` when the
  score recommends applying, `skip` when a gate blocks it or the overall is below the ask floor,
  `ask` for the rest, and `unscored` when there is no overall. The ask floor is the ratio where
  `ask` starts; `settings_get` reads it and `settings_update` changes it.
- The **agent verdict** is yours: `apply`, `ask` or `skip`, with a short reason of at most 500
  characters. You give it with the optional `verdict` field of `score_posting` or
  `score_posting_bulk`, and change it later with `score_verdict_set` without scoring again.

A verdict belongs to the score it was given with. A new criteria version means a new score, so
the verdict has to be given again. `settings_update` also picks what the app shows through
`recommendationDisplay`: `rules`, `agent` or `both` (the default, so a disagreement is visible).

`settings_update` also holds `postingLinkPatterns`, the user's rules for turning a posting key
into a link in the posting panel: a key `<prefix>:<id>` opens that prefix's template with
`{id}` filled in. The list is replaced whole, so read it with `settings_get` first and send it
back with your change. Change it only when the user asks. A posting key in that form lets the
panel link to a posting that has no URL stored.

## The rule for verdicts

**When the data the user gives you carries its own recommendation, that recommendation is the
verdict.** A spreadsheet column with "Apply" or "Skip", a status column with "maybe", or a note
that says "apply to this one" is the user's decision, already made. Use it as the agent verdict
as written. Do not replace it with a verdict you derive from the score range or the overall
value. Put the source's own rationale in the reason, quoted or closely kept ("Sheet: 'great
team, pay unclear'").

**Otherwise, give your own verdict** with a one-line reason that names what decided it: a gate,
the limiting requirement, or something the posting leaves unknown.

**Say when your verdict and the rules band disagree, and why.** For example: a gate blocks the
posting, so the rules say `skip`, but the user's notes say apply because the gate is negotiable
here. Write the disagreement in the reason, and mention it to the user. A disagreement is often
the best question to ask next: it shows a weight, a gate or an anchor that does not yet match
what the user wants. The `recommendation-verdicts` skill covers this in more detail.

## Privacy

- Never put the user's personal details into shared or public text: a commit, an issue, a pull
  request, a skill or a prompt in this repository. Names, places, employers, pay figures and
  their own criteria all count.
- The criteria in this repository are a vanilla pack: structure and anchor text, with every
  weight and the apply threshold left blank. The user's own live criteria stay in their
  database. Personal variants of a skill go in a `personal-*` directory, which git ignores (see
  the README).
- Use made-up examples in anything you commit: "Example AB", "a backend role".

## Where to read more

- **Skills** in [.claude-plugin/skills/](.claude-plugin/skills/):
  `criteria-weighting` (gates, weights, anchors), `scoring-questions` (questions that tune the
  criteria), `past-work-gates-and-flags` (past work turned into gates and flags),
  `notebook-store-postings` (Open Notebook) and `recommendation-verdicts` (giving and revising
  verdicts).
- **Prompts** in [docs/prompts/](docs/prompts/README.md): copy-pasteable starting points for
  adding a posting, importing a spreadsheet, scoring, the profile questionnaire and a weekly
  review.
- **The README** for running the database, the server and the backups.
