# Weekly review

Use when: once a week, to see what moved and what needs a decision.

```text
Give me a weekly review of my search. Read only; change nothing unless I ask.

1. What moved: postings whose stage changed in the last 7 days (posting_search, stage_current),
   and new postings added.
2. Stale leads: postings in an open stage with no stage event in the last <14> days. Name the
   stage and how long it has sat there.
3. Unanswered questions: posting questions with no answer yet (posting_question_list), grouped
   by posting, for the postings I am still pursuing.
4. Disagreements to resolve: postings where the agent verdict and the rules band differ. For
   each, give both, the reason, and one question that would settle it.
5. Patterns: what set_aside_list and market_stats say about why I pass on leads, in two or
   three lines.

End with the one action that would help most this week.
```

Tools: `posting_search`, `posting_get`, `stage_current`, `posting_question_list`,
`score_best`, `set_aside_list`, `market_stats`, `settings_get`.
