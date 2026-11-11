---
name: criteria-weighting
description: Use when helping a user set or change the weights, gates and anchors of a job-tracker criteria set (criteria_requirements, criteria_requirement_update, criteria_version_create), or when a score looks wrong to them. Covers how scoring reads weights, how to elicit weights, and when to make a new version.
---

# Weighting criteria

A criteria set is a list of requirements in layers (the vanilla pack has Market, Role, Company,
Person). Each requirement has a kind, a weight and anchors:

- **Gate**: pass or block. A posting whose gate is rated 0, or not rated at all, cannot pass,
  whatever its other ratings. Gates take no part in the weighted score.
- **Soft**: rated from 0 to 1 against its anchors, and counted in the overall score in
  proportion to its weight. A weight of 0 records the requirement without scoring it; `null`
  means nobody has set one yet.
- **Anchors** say what 0, 0.5 and 1 mean for this requirement, in words a rater can check
  against a posting.

The score also names a limiting factor: the requirement that holds the posting back most.

## Before changing anything

1. Read the set: `criteria_sets`, then `criteria_requirements` for the one in use.
2. Score a few postings the user already has an opinion about, and compare. A weight is right
   when the order of scores matches the order the user would put those postings in.
3. Make a new version (`criteria_version_create`) before editing a set that has scores under
   it, so earlier scores stay readable under the set they were made with. Then edit the copy
   with `criteria_requirement_update`, add a new requirement to it with
   `criteria_requirement_add`, and make it the default with `criteria_set_default` when the
   user agrees.

## Eliciting weights

Ask about trade-offs, not about numbers. People are better at "which would you give up" than
at "how much does this matter from 1 to 10".

1. **Find the gates first.** "Is there anything that, if missing, means you would not apply
   whatever else is true?" Each yes is a gate candidate. Check each one: "If everything else
   were excellent, would you still say no?" A gate that survives that question stays a gate.
2. **Rank the soft requirements.** Ask the user to order them, or to pick the top three and the
   bottom three. Ties are fine.
3. **Turn the order into weights.** Start simple: weight 3 for the top group, 2 for the middle,
   1 for the bottom, 0 for "record it but do not count it". Adjust only when a scored posting
   lands in a place the user disagrees with.
4. **Check with a pair.** Pick two postings where one is strong on a heavy requirement and the
   other on a light one. If the user prefers the second, the weights are off.

## Anchors

Write anchors as observable facts about a posting, not feelings: "the stated pay meets or
exceeds your expectation" is checkable; "the pay feels good" is not. Keep the user's own
thresholds (amounts, places, sizes) out of committed files; they belong in the user's own
criteria set in the tracker, or in a personal skill (see the README).

## Signs the weights need another look

- The limiting factor is the same requirement on almost every posting: it may be a gate in
  disguise, or its anchors may be too strict.
- Postings the user rejected score near the top: a reason they gave is missing as a
  requirement, or weighted too low. Record it with the scoring-questions skill.
- Many ratings are "unknown": the requirement asks for something postings rarely say. Lower its
  weight, or move it to a question to ask later in the hiring process.
