# Import a spreadsheet

Use when: you have postings in a sheet or a CSV (comma-separated values) file and want them in
the tracker.

```text
Below is a sheet of job postings. Import the rows into the tracker.

1. Map the columns first, and show me the mapping before writing anything: which column is the
   employer, the role, the city, the salary, the link, the date seen, and so on. Ask me about
   any column you cannot place.
2. If the sheet has a recommendation or decision column (for example "Apply", "Skip",
   "Maybe", "Decision", "Verdict"), that column IS the verdict for the row. Use it as written:
   Apply -> apply, Maybe -> ask, Skip -> skip. Do not replace it with a verdict from the score
   range or the overall value. Put the sheet's own rationale (a notes or "why" column) in the
   verdict's reason, kept close to its wording.
3. Rows without such a value get your own verdict with a one-line reason.
4. Use the bulk tools: posting_add_bulk, origin_record_bulk, summary_write_bulk,
   score_posting_bulk. A bulk call is all or none, so fix the item it names and repeat it.
5. A row that already exists in the tracker is not added again: report it, and tell me whether
   check_already_applied says I applied.
6. Do not import the sheet's status or stage column as stage events, and never write a
   priority rank. List those values for me instead.
7. At the end, report: rows added, rows skipped as duplicates, rows that could not be mapped
   (with the row number and why), and every row where the sheet's verdict disagrees with the
   rules band.

<paste the sheet or CSV here>
```

A small made-up sheet to test with:

```csv
Company,Role,City,Decision,Why
Example AB,Backend Developer,Example City,Apply,team uses the stack I want
Sample Corp,Data Analyst,,Skip,on-site five days
```

Tools: `posting_search`, `check_already_applied`, `posting_add_bulk`, `origin_record_bulk`,
`summary_write_bulk`, `criteria_requirements`, `score_posting_bulk`, `score_verdict_set`.
