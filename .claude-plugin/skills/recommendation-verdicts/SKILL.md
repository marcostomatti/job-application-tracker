---
name: recommendation-verdicts
description: Use when giving, revising or explaining the agent verdict (apply, ask or skip, with a reason) on a job-tracker score, through the verdict field of score_posting or score_posting_bulk, or score_verdict_set. Covers the rule that a recommendation in the user's own data is the verdict, writing the reason, and handling a disagreement with the rules band.
---

# Agent verdicts

Every score in the tracker can show two recommendations. The **rules band** is computed by the
server from the score: `apply` when the score recommends applying, `skip` when a gate blocks it
or the overall is below the ask floor, `ask` for the rest, and `unscored` when there is no
overall. The **agent verdict** is yours: `apply`, `ask` or `skip`, with a reason of one or two
sentences (500 characters at most).

## Giving a verdict

Give it with the score: the optional `verdict` field of `score_posting`, or of each item of
`score_posting_bulk`, as `{ band, reason }`. A verdict belongs to the score it came with, so a
new criteria version, and the new score it brings, starts without one. Give it again then.

## The recommendation-column rule

When the data the user gives you has its own recommendation, that is the verdict. Examples:

- a spreadsheet column "Decision" with "Apply", "Maybe" or "Skip";
- a note on the posting: "apply, the team is great";
- the user saying "skip that one" in the conversation.

Use it as written: map "Maybe" or "Unsure" to `ask`, and ask the user about any value you cannot
map. Do not replace it with a verdict you derive from the overall value or the score range. Put
the source's rationale in the reason, close to its words: "Sheet: 'team uses the stack I
want'". When the source gives no rationale, say where the verdict came from: "Sheet: Apply".

## When there is no such source

Give your own verdict, with one line that names what decided it:

- a gate: "skip: the on-site gate blocks it";
- the limiting requirement: "ask: strong fit, pay not stated";
- an unknown that matters: "ask: the posting does not say the contract type".

## Disagreeing with the rules band

A verdict may differ from the rules band. That is allowed, and it is useful, because it shows
where the criteria do not yet match the user. When they differ:

1. Say why in the reason: "apply, against rules skip: the gate blocks it, but the user's notes
   say the location is negotiable here."
2. Tell the user in your reply, next to the posting.
3. Treat it as a question to ask (see the scoring-questions skill). The answer may change a
   gate, a weight or an anchor, or show that the verdict should change.

The app shows both by default, so a disagreement is visible. `settings_get` reads the display
choice (`recommendationDisplay`: `rules`, `agent` or `both`) and the ask floor;
`settings_update` changes them when the user asks.

## Revising a verdict

Use `score_verdict_set` to change a verdict without scoring again: when the user changes their
mind, when an answer to a posting question arrives, or when the reason was wrong. It acts on the
posting's latest score under one set (the default set when `criteriaSetId` is left out), and
`verdict: null` clears it. Write the new reason in full; it replaces the old one. Score again
instead when the ratings themselves change.

## Explaining a verdict

When the user asks why, give the verdict, the rules band, the overall value, the limiting
requirement, and the source of the verdict (their data or your reading). Read them with
`score_best` or `posting_get`.
