---
name: scoring-questions
description: Use when job-tracker scores do not match what the user wants and you need to ask questions that fine-tune the criteria. Lists question types (forced choice, threshold, deal-breaker, rejected-posting review, unknown-rating follow-up), when each fits, and where the answer is recorded.
---

# Questions that fine-tune scoring

A question earns its place when its answer changes a weight, a gate, an anchor or a rating.
Ask one at a time, and say what the answer will change. Record the answer where it acts:
a criteria change goes into a new criteria version, and something said about the user's past
or preferences goes into the notebook as a note (`notebook_note_add`) when a notebook is
configured, in the user's words.

The tracker's posting questions (`posting_question_add`) are different: they are questions
about one posting, to ask the employer. The user's answers there are theirs to write; never
fill them in.

## Question types

| Type | Ask it when | Example | The answer changes |
|---|---|---|---|
| Forced choice | Two soft requirements seem equally weighted | "Posting A pays more, posting B has the team you described. Which would you pick?" | Relative weights |
| Deal-breaker | A requirement might be a gate | "If this one thing were missing and everything else were great, would you still apply?" | Gate or soft |
| Threshold | An anchor needs a line | "At what point does the commute stop being acceptable?" | Anchors |
| Rejected-posting review | The user rejected a posting that scored well | "What made you say no to this one?" | A missing requirement, or a weight |
| Surprise review | A low-scoring posting excites the user | "What do you like here that the score missed?" | A missing requirement, or a weight |
| Unknown follow-up | A rating is unknown because the posting does not say | "Is this worth asking them, or can we leave it unknown?" | A posting question, or a lower weight |
| Past-work anchor | An anchor is abstract | "Think of a team you liked. What did this look like there?" | Anchors in the user's terms |

## How to ask

- **Anchor in a real posting.** Abstract questions ("how important is growth?") get abstract
  answers. Point at a posting the user has seen.
- **One variable at a time.** If two things differ between the postings you compare, the answer
  cannot tell you which one mattered.
- **Say the change before you make it.** "That sounds like a gate; I'd make 'remote-friendly' a
  gate in a new criteria version. OK?" Then do it.
- **Stop when the order is right.** When the scores of the postings the user knows come out in
  the order they would choose, more questions add little.

## After the answers

1. Make a new criteria version and apply the changes (see the criteria-weighting skill).
2. Ask for a rescore of the postings that matter (`rescore_request`, `rescore_pending`).
3. Show the user two or three postings whose place changed, and check they agree.
