# Score and recommend

Use when: postings are waiting for a score (after a new criteria version, for example) or have a
score with no verdict.

```text
Score the postings that are waiting, and give each one a verdict.

1. List what is waiting with rescore_pending. If nothing is pending and you see postings with
   no score under the default set (posting_search), score those instead.
2. For each posting, read its summary (summary_get) and the requirements of the set
   (criteria_requirements). Rate each requirement against its anchors.
3. Score them with score_posting_bulk. Give each item a verdict (apply, ask or skip) with a
   one-line reason that names what decided it. If my notes or an earlier source already say
   apply or skip for a posting, use that as the verdict and quote it in the reason.
4. Report a short table: posting, overall, limiting requirement, your verdict, rules band.
5. Then list every posting where your verdict and the rules band disagree, with the reason. For
   each disagreement, suggest the one question that would settle it.
```

Tools: `rescore_pending`, `posting_search`, `summary_get`, `criteria_requirements`,
`score_posting_bulk`, `score_verdict_set`, `score_best`, `settings_get`.
