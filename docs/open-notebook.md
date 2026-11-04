# Open Notebook alongside the tracker

[Open Notebook](https://github.com/lfnovo/open-notebook) is an optional companion to this
tracker. Nothing in the tracker needs it: the two run side by side, and an agent (or you) moves
text between them. When you configure one, the tracker's MCP server adds ten `notebook_*` tools,
so an agent can drive both through one server. This page says what it is, what each of the two
keeps, what you gain by running both, what it costs you, and how to set it up.

## What Open Notebook is

Open Notebook is a self-hosted, open-source alternative to Google's NotebookLM, under the MIT
licence. You group documents into notebooks, and it lets you search them and ask questions about
them, with answers that cite the passage they came from.

- **Sources** can be pasted text, PDFs, web pages, Office documents, audio and video.
- **Search** is both full-text and by meaning: each source is cut into chunks and turned into
  embeddings, numbers that let it find a passage that says the same thing in other words.
- **Chat** answers from the sources you allow it to see, with citations.
- **Notes, transformations and podcasts** are there too: your own notes, AI summaries of a
  source, and generated audio discussions of a notebook.
- **AI providers** are your choice, local (Ollama, LM Studio) or hosted (Anthropic, OpenAI,
  Google, Mistral and others), and you can pick a different one per job.
- It runs in Docker with a SurrealDB database, serves its UI on port `8502` and a REST API on
  port `5055`, with interactive API docs at `/docs`.

## What each one keeps

The tracker holds the facts you filter, count and decide on. The notebook holds the long text you
read and ask questions of. A useful test: if you would sort or count it, it belongs in the
tracker; if you would read it or ask about it, it belongs in a notebook.

| In the tracker | In a notebook |
|---|---|
| Postings, companies, stages, dispositions | The full text of a posting, as you saw it |
| Scores, criteria sets, the limiting factor | Research on a company: news, reviews, its own pages |
| Origins and search runs: how a posting reached you | Interview notes and preparation |
| `posting_summary`: stack, industry, a condensed text | Long drafts and the material you write cover letters from |
| Texts: cover letters and form answers you reuse | Your own research on a field, a stack or a market |

The tracker's `posting_summary` is deliberately short, because its job is to be counted by the
Stats tab. The notebook is where the long version can live without slowing the board down.

## How this project uses it

The research and design notes behind this repository live in one notebook. A design session
asks it questions such as "what did we decide about capture drivers?" and gets the passage
back with its source, instead of re-reading every note or searching the web again. An agent
uploads the notes through the REST API, one source per file.

For a job search, the same pattern works per employer or per posting:

1. **One notebook per employer you are serious about.** Their careers pages, engineering blog,
   news and your notes go in as sources, so "what do they say about on-call?" has an answer
   with a citation before an interview.
2. **The full posting text as a source**, titled with the tracker's `posting_key`, so you can
   find the notebook entry from the tracker and back.
3. **Interview notes after each round**, so the next round starts from what was said.

## What you gain by running both

- **The tracker stays fast and structured.** Long text does not sit in board queries, and the
  tracker's schema does not grow a column for every kind of document.
- **Questions over everything you collected,** with the passage each answer came from, which is
  how you check an AI answer instead of trusting it.
- **Both stay on your machine,** if you choose local models. Nothing about your search needs a
  hosted service.
- **One agent can drive both** through the tracker's MCP server: it records a posting with the
  tracker tools and files the posting text and company research with the `notebook_*` tools.

## What it does not do

- **It does not track applications.** It knows nothing about stages, scores or deadlines; the
  tracker is the record of those.
- **The two are not linked in the database.** No tracker table points at a notebook or a source.
  The link is a naming convention (the `posting_key` in a source title), which
  `notebook_posting_store` applies for you.
- **Sources are copies.** Editing a file after uploading it does not change the notebook. Upload
  it again, or the notebook answers from the old version.
- **It does not fetch postings for you.** The tracker's recommended way to add a posting is
  still to copy and paste it; Open Notebook only stores what it is given.
- **It is single-user.** There are no accounts or per-user permissions.

## What it costs you, and what to watch

- **Another stack to run.** Docker, the Open Notebook container and SurrealDB, next to the
  tracker's own Postgres. Updates, backups and disk space are yours to manage; the tracker's
  `bun run backup` does not cover it.
- **Compute for embeddings.** Every source is embedded when it is added. A local embedding model
  is light, but it is one more model to keep running.
- **Where your text goes depends on the models you pick.** With a hosted provider, the text you
  embed, and the passages a chat question retrieves, are sent to that provider. With local
  models it stays on your machine. You can mix them: a local embedding model keeps every source
  local, and only questions plus the passages they retrieve reach a hosted chat model. Some
  hosted providers have no embedding models at all (Anthropic is one), so embeddings need a
  second provider or a local model either way.
- **It is open by default.** Upstream's compose file publishes the UI and the API on every
  network interface with no password. Set a password and bind both ports to `127.0.0.1`
  before you store anything personal in it.

## Setting it up

1. **Install it** with the Docker Compose file from the
   [Open Notebook repository](https://github.com/lfnovo/open-notebook). Set
   `OPEN_NOTEBOOK_ENCRYPTION_KEY` (it encrypts the provider keys it stores) and
   `OPEN_NOTEBOOK_PASSWORD`, and change the published ports to `127.0.0.1:8502:8502` and
   `127.0.0.1:5055:5055`.
2. **Add two models** in its UI: one embedding model and one language model. An embedding model
   from Ollama keeps every source on your machine.
3. **Give your agent the password** by adding it to this tracker's `.env`, which git ignores:

   ```bash
   OPEN_NOTEBOOK_URL=http://localhost:5055
   OPEN_NOTEBOOK_API_KEY=the-password-you-set
   ```

   The API takes the password as a bearer token. Without it, every `/api/...` route answers
   401.

## The tracker's notebook tools

With `OPEN_NOTEBOOK_URL` set, the MCP server asks the notebook for one authenticated read when it
starts. If the notebook answers, ten tools are added; if it is not set, unreachable, or refuses the
key, none is added and the server writes one line to stderr saying why, such as
`notebook tools off: OPEN_NOTEBOOK_URL is not set`. The line never holds the URL or the key.

| Tool | What it does |
|---|---|
| `notebook_list`, `notebook_create` | List notebooks, or create one |
| `notebook_source_list` | List stored documents, without their text, 100 a page |
| `notebook_source_get` | Read one document's text, in windows of up to 200,000 characters |
| `notebook_source_add_text` | Store pasted text, embedded for meaning search by default |
| `notebook_source_delete` | Delete one document; the only tool marked destructive |
| `notebook_posting_store` | Store a tracked posting's text, titled with its `posting_key` |
| `notebook_posting_sources` | Find the stored copies of one posting by its `posting_key` |
| `notebook_search` | Search documents and notes, by words or by meaning |
| `notebook_note_add` | Add a note in the user's words |

These tools are enough to run Open Notebook as a container with no UI: the MCP server is then
its only door. None of them writes to the tracker; the one tracker read is a posting's key.
`notebook_posting_store` deletes nothing: it lists the older copies with the same title, and the
agent deletes them with `notebook_source_delete` once the new copy reads back.

If the notebook stops answering after startup, its tools stay listed and each call fails with
`NotebookUnavailableError`; the next call tries again, so a notebook that comes back is used
again without a restart. A call waits at most 15 seconds. A refused key is a
`NotebookRequestError` naming `OPEN_NOTEBOOK_API_KEY`, and an unknown id is a `NotFoundError`.

The plugin's skills say how to use these tools well: `notebook-store-postings` for storing
postings and documents, and three for tuning criteria (see the README).

## Talking to it directly over REST

These calls were checked against Open Notebook's API version 0.1.0. They load the variables
from step 3 first.

```bash
set -a; . ./.env; set +a
AUTH="Authorization: Bearer $OPEN_NOTEBOOK_API_KEY"
```

Create a notebook; the response carries its `id`:

```bash
curl -s -X POST "$OPEN_NOTEBOOK_URL/api/notebooks" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name": "Acme", "description": "Research for postings at Acme"}'
```

Add pasted text as a source, embedded so it can be searched:

```bash
curl -s -X POST "$OPEN_NOTEBOOK_URL/api/sources/json" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"type": "text", "title": "acme/staff engineer", "content": "…the posting text…",
       "notebooks": ["notebook:…"], "embed": true, "async_processing": true}'
```

Processing runs in the background. `GET /api/sources/{id}/status` says `completed` when the text
is stored, and embedding finishes a little later: `GET /api/sources/{id}` reports
`"embedded": true` and a non-zero `embedded_chunks` once the source can be searched.

## Keeping the two in step

- **Title a posting's source with its `posting_key`**, and a company's notebook with the
  company's name as the tracker stores it.
- **Upload again after an edit**, and delete the old source, so a question cannot be answered
  from a version you replaced.
- **Treat the tracker as the record.** If the two disagree about a stage, a date or a decision,
  the tracker is right; the notebook holds reading material.
