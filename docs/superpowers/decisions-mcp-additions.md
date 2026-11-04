# Decisions taken on the author's behalf — MCP surface additions

Five additions to the MCP surface, asked for on 2026-11-04 after an agent drove the service
against an imported tracker: `registry_update`, a `scale` parameter on the final-score reads,
`company_update`, `company_merge`, per-posting questions, and links from a text to the
postings it was used for. The request fixed most of the design; this file records what it
left open and how it was settled. Each entry says what was decided, why, and what it costs
if the decision was wrong.

The spec amendments are dated blockquotes in §7.1, §7.4, §7.8, §8 and §11.1, and one row in §18.

## `registry_update`

1. **It changes `label`, `sort`, the flags, and a stage's `phaseId`.** The request named
   label, sort and the flags. `phaseId` is added because a stage filed under the wrong phase
   needs the same add, move and archive cycle the request set out to remove, and the new
   phase passes the same archived-reference guard an add does. Cost if wrong: one field to drop.
2. **`key` is refused with a message that names the fix**, an add plus an archive, because
   other rows and imports refer to a row by its key. A field the registry does not have is
   refused as on `registry_add`.
3. **An empty patch returns the row unchanged**, as `posting_update` does, rather than being
   an error.
4. **An archived row may be updated.** The edit is not a new reference to it, and fixing the
   label of a retired row is how its historical renders get fixed.

## `scale`

5. **Which tools take it:** `score_posting`, `score_posting_bulk`, `score_history`,
   `score_best`, `posting_get`, `posting_search` and `criteria_sets`. The tools that write a
   threshold (`criteria_version_create`, `criteria_set_default`) stay in the stored unit,
   because their input carries the threshold as 0..1 and an answer on another scale beside a
   0..1 input would read as a different number. Cost if wrong: one more schema to extend.
6. **Rounding:** `ratio` is returned unrounded; `stars` to one decimal, `percent` to whole
   numbers, `basic` to two decimals. One function rounds half up for the score and the
   threshold alike. That function is monotone, so a score at or above a threshold never shows
   below it, though two close values can show as equal. `recommendApply` is read from the
   stored row and never recomputed, and no tool accepts a scaled value as input.
7. **Penalty amounts stay 0..1**, with ratings' `coverage` and `limiterCoverage`. A penalty is
   an adjustment to the score, but it is stored and entered in the stored unit, and the
   request scoped the scale to the final score and its bounds.
8. **The score responses do not gain an `applyThreshold`.** None carries one today, and the
   request asked to scale the threshold where a response carries it, not to add it. Reading
   both on one scale is `criteria_sets` with the same `scale`. Cost if wrong: a reader makes
   two calls; adding the field later is additive.
9. **No letter grade**, for the reason the request gave and §8 now records.
10. **`posting_get` gets its own query schema.** `PostingRefSchema` is shared by
    `posting_get`, `summary_get` and `origin_list`, and a `scale` on it would reach two tools
    with no score in them. The two score reads still share one schema, as they did.

## Companies

11. **`company_update` changes `name` and `nameUnresolved`.** A name whose normalised form
    another company holds is a conflict whose message names `company_merge`.
12. **`company_merge` deletes the loser.** A company has no archive column, and only postings
    refer to one, so once its postings have moved nothing is left that a reference needs to
    render. Kept as an empty row, it would hold its normalised name, and the next import under
    that spelling would attach new postings to the empty shell. The response names the
    winner, the number of postings moved and the id removed.
13. **A role both companies hold stops the merge before anything is written**, as a conflict
    naming the postings at each side. Resolving it (a disambiguator, a rejection) is a choice
    about the roles, so it is left to the caller.
14. **The winner keeps its own `name` and `nameUnresolved`.** The flag describes the name, and
    the name kept is the winner's. To keep a real name from the losing side, merge into the
    resolved company, or rename the winner afterwards.
15. **No alias is kept for the losing spelling.** A later import under that spelling creates
    the company again. An alias table is the fix, and it is left until an import needs it.
15a. **A posting keeps its `posting_key` through a rename or a merge.** The key is the posting's
    identity, built once from the company's spelling at capture, and exports and imports refer to
    a posting by it. So after a merge, a re-import of a role under the removed spelling is refused
    as a duplicate of the posting that moved, rather than stored twice; the refusal names the old
    key. Cost if wrong: a recompute in both tools, and a rewrite of every exported key.
15b. **A merge locks both companies first**, in id order, so a posting added under either one
    waits for the merge instead of landing on a deleted company, and two merges of one pair
    queue. A posting that still reaches the removed company is a conflict that says to merge again.
16. **"Via recruiter" needs no schema change.** It is a `route` row and an `origin` through it.
    Whether the operator's route registry already has such a row is in their data, which this
    change does not read; `registry_add` adds one if not.

## Posting questions

17. **One table, `posting_question`, unique on `(posting_id, question)`**, and a question is at
    most 1000 characters, because the unique key's btree entries are capped at about 2.7 KB. An add whose
    question the posting already has returns the stored row unchanged, so a repeated import
    neither duplicates a question nor touches its answer. An answer may arrive with the
    question, which is how an import carries questions already answered.
18. **Only `posting_question_answer` changes an answer.** It sets `answered_at` to the time of
    the write, and an empty answer is refused rather than read as clearing one.
19. **Questions appear in `posting_get`**, beside the scores and origins the detail already
    carries.
20. **No tool edits or removes a question's wording.** Left until one is needed.

## Text links

21. **A link names one version of a text**, the wording that was sent, and linking twice is a
    no-op.
22. **`text_list` with `postingId` lists exactly the linked versions.** `textTypeId` still
    selects by the type a label has now, and `includeHistory` has no effect there, because a
    link already names a version.
23. **No unlink tool.** Left until one is needed.

## Surfaces

24. **The new tools are MCP only.** §11.2's route table stays at 23 routes; the web plan adds
    a route when a screen needs one. The `scale` parameter does reach the routes that already
    mirror the score reads, `posting_get`, `posting_search` and `criteria_sets`, because they
    parse with the same schema objects.
25. **The stage-flag correction is a rule, not a data change.** The spec held no rule deriving
    `is_applied` from the phase, and no vanilla pack ships a stage registry, so §7.1 now says
    the flags are set per stage and that a pack shipping stages sets all four on every key.
