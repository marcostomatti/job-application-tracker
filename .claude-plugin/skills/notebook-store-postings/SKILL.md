---
name: notebook-store-postings
description: Use when a job posting's full text, company research or a user's document (CV, past-work notes) should go into Open Notebook through the job-tracker's notebook_* tools. Covers the tracker-first order, titles, re-storing, waiting for processing and reading documents back.
---

# Storing postings and documents in Open Notebook

The tracker is the record: postings, stages, scores and decisions live there. Open Notebook
holds the long text you read and ask questions of. The notebook tools exist only when the
tracker's MCP server found a notebook at startup; if no `notebook_*` tool is listed, the
notebook is not configured, so keep the text in the tracker's summary and say so.

## Getting the text

The recommended way to get a posting's text is for the user to copy and paste it. Store what the
user gave you, as given. Do not rewrite, condense or "clean" the posting text you store: the
condensed version belongs in the tracker's `summary_write`, and the notebook copy is the
reference you check a summary against.

## Storing a posting

1. **Tracker first.** Find or add the posting (`posting_search`, `posting_add`). The notebook
   copy needs the posting's id, because its title is the posting's `postingKey`.
2. **Pick the notebook.** `notebook_list`; if there is none for this employer, `notebook_create`
   with the company name as the tracker stores it.
3. **Store it.** `notebook_posting_store` with the posting id, the notebook id and the text.
4. **Check `earlierSources`.** A non-empty list means an older copy is there. When the new copy
   is the same posting re-pasted or updated, delete the older ones with `notebook_source_delete`
   once the new one reads back. Ask first when you are not sure they are the same posting.
5. **Wait before searching.** Processing runs in the background. `notebook_source_get` shows
   `embedded` and `embeddedChunks`; meaning search finds the text only once it is embedded.

## Storing the user's own documents

Keep a notebook for the user's background (for example "Background"): CV versions, past-work
notes, what they want and avoid. Use `notebook_source_add_text` for a document they paste and
`notebook_note_add` for something they tell you in conversation, written in their words.
Title a document so it can be found by eye: "CV 2026-11", "Past work: payments team".

## Reading documents back

- `notebook_search` finds a passage; `type: "vector"` matches meaning when an embedding model is
  set up, `type: "text"` matches words and always works.
- `notebook_source_get` reads one source in windows. When `truncated` is true, read the next
  window from `textOffset` plus the length you got before quoting or scoring from it.
- `notebook_posting_sources` lists the notebook copies of one posting.

## What not to store

- Credentials, keys, or anything from the tracker's `.env`.
- Notes about other people beyond what the posting itself says.
- Your own reading of what the user meant, stored as if they said it. Quote them, or say it is
  your summary.

## When a call fails

- `NotebookUnavailableError`: the notebook stopped answering. Tell the user, keep the text in
  the conversation, and try again later; the tracker tools still work.
- `NotebookRequestError` with 401: the key in `OPEN_NOTEBOOK_API_KEY` is wrong.
- `NotFoundError`: the posting or source id does not exist; look it up again.
