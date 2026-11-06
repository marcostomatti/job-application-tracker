# Add a posting

Use when: you have the text of one posting and want it recorded, scored and ready to act on.

```text
Here is a job posting. Record it in the tracker.

1. Check it is new. If the employer and role look familiar, find the posting with
   posting_search and run check_already_applied and check_reposted on it. If it is a repost,
   record the new sighting with origin_record on the existing posting and stop there.
2. Add it with posting_add, then origin_record for how it reached me: <for example "job board,
   seen today">.
3. Write the summary with summary_write.
4. Score it against the default criteria set: read criteria_requirements, rate each
   requirement against its anchors, and call score_posting with a verdict (apply, ask or skip)
   and a one-line reason. Rate a requirement the posting does not mention as not rated.
5. Add the questions I should ask the employer, for what the posting leaves unknown, with
   posting_question_add_bulk. Do not answer them.
6. Tell me the overall score, the limiting requirement, your verdict and the rules band. If
   they disagree, say why.

Do not append a stage. Do not set a priority rank.

<paste the posting here>
```

Example of the reply you can expect: "Example AB, Backend Developer: 0.62, limited by 'salary
stated'. Verdict ask: the stack fits, pay is not given. Rules band ask. Two questions added."

Tools: `posting_search`, `check_already_applied`, `check_reposted`, `posting_add`,
`origin_record`, `summary_write`, `criteria_sets`, `criteria_requirements`, `score_posting`,
`posting_question_add_bulk`.
