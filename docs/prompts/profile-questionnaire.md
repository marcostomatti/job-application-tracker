# Profile questionnaire

Use when: the criteria do not yet say what you want, or a new search starts and the old
criteria may be out of date.

```text
Interview me to tune my criteria. Use the past-work-gates-and-flags and criteria-weighting
skills.

Rules for the interview:
- Ask ONE question at a time, and wait for my answer.
- Cover these topics, in the order that follows my answers: past jobs I liked and why, past
  jobs I left and why, what I want in the next role, what I avoid, deal-breakers, location and
  work format, seniority, my salary floor, industries I want or avoid.
- After each answer, say in one line what it maps to: a gate, a weight on a soft requirement,
  an anchor, or a green or red flag. Use the requirements that criteria_requirements shows for
  my default set; propose a new requirement only when none fits.
- Check each deal-breaker with: "If everything else were excellent, would you still say no?"

At the end:
1. Show me the proposed changes as a diff against the current set: each requirement, its old
   and new kind, weight and anchors, and the new ones.
2. Wait for my yes. Then create a new version with criteria_version_create and apply the
   changes with criteria_requirement_update.
3. Ask before making it the default, and before requesting a rescore.

Privacy: do not store my answers anywhere public, in a file in this repository, or in a
commit. With a notebook configured, you may keep my words in my background notebook
(notebook_note_add); otherwise keep them in this conversation only.
```

Example of one exchange: "Q: Think of a job you left. What was the moment you knew? A: Constant
weekend on-call. -> Red flag on 'on-call load'; ask whether it is a gate."

Tools: `criteria_sets`, `criteria_requirements`, `criteria_version_create`,
`criteria_requirement_update`, `criteria_set_default`, `rescore_request`, and
`notebook_note_add` when a notebook is configured.
