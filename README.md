# job-application-tracker

A local-first tracker for a job search, published as a template. You clone it and fill it with
your own judgement. The repository ships the mechanism (the tables, the scoring functions, the
checks) and does not ship anyone's weights, hard gates or opinions about employers. A fresh
database has empty registries and no criteria.

## Run it

You need [Bun](https://bun.sh) and Docker.

```sh
bun install
cp .env.example .env     # placeholders for the local database, not real credentials
bun run db:up            # starts Postgres 16 in Docker and waits until it is ready
bun run db:migrate       # applies the migrations; every registry is still empty afterwards
bun test                 # needs the database from the steps above
bun run lint:migrations  # checks the migrations and any pack in seeds/vanilla/
```

### If port 5432 is taken

The database listens on `127.0.0.1:5432` by default. If something else holds that port, set
`DB_PORT` before `db:up` and use the same port in `DATABASE_URL` in `.env`:

```sh
DB_PORT=5439 bun run db:up
```

### Starting again from nothing

`bun run db:down` is `docker compose down`, which stops the container and **keeps the named
volume**, so the data survives. A database that is empty from scratch also needs the volume
removed. `docker-compose.yaml` pins the project name, so the volume is called
`job-application-tracker_tracker-data` whatever directory you cloned into:

```sh
bun run db:down
docker volume rm job-application-tracker_tracker-data
bun run db:up && bun run db:migrate
```

## Packs are opt-in

A pack is a starting point: a criteria set with its requirement keys, labels, layers and
anchor text (what a rating of 0, 0.5 and 1 means for each requirement). Nothing installs a pack
for you, and no migration contains an insert. You install one with an explicit command:

```sh
bun run seed:pack seeds/vanilla/web-search.json
```

A shipped pack carries **structure and anchor text only. Every weight and the apply threshold
are null.** How much a requirement matters, and where the apply line sits, is your judgement,
so the pack leaves it blank for you to fill in. Until you do, a posting scored against the set
has no overall score and is never recommended for apply. That is the template arriving empty,
not a fault.

Installing is safe to repeat: a second run for the same pack name and version reports that the
set exists and changes nothing. The loaded set is not made the default; you choose that.

`bun run lint:migrations` rejects any pack in `seeds/vanilla/` with a weight or an apply
threshold set, and `seed:pack` refuses such a file too.

## New criteria versions and the recommended list

A posting is recommended for apply when at least one **current** criteria set puts it over
that set's own threshold. Current means the highest `version` of a set `name`, so each name
counts once, however many versions it has.

**Publishing a new version of a criteria set empties the recommended list of everything only
the older version recommended, until those postings are scored again.** This is expected, not
a fault: the new criteria have not been applied to them yet, so the honest answer is "unknown"
and not a stale yes from the old criteria. The older scores stay in the history. To refill the
list, ask for a re-score of the new set (the `rescore_request` tool), then score each pending
posting against it.

Two reads follow from the same rule. The board shows a posting that another current set
recommends even when the default set does not, and the row then displays the recommending
set's score (the best-scoring one if several recommend). Scoring moves a posting to the
shortlist only when the score just written recommends it, so such a posting can be in the
recommended list without having been shortlisted.

Archiving a set does not change this: an archived set that is the newest version of its name
still counts, because nothing can be scored against it any more and only a newer version of the
same name withdraws its recommendation.

## Backups

`bun run backup` writes one `pg_dump` of the database into `backups/` and removes older dumps,
so the directory holds `keep` files and never grows. **A dump is all of your job-search data in
one file**, which is what this repository is built to keep out of git, so `backups/` and `*.dump`
are in `.gitignore`. The directory is created readable by you alone, and so is each dump.

```sh
bun run backup
ls backups/        # tracker-20261103T090507Z.dump: a sortable UTC time, nothing else
```

The settings live in `app_config` under `backup`, and the defaults apply until you store one:
`{ "enabled": true, "keep": 1, "intervalDays": 14 }`. One dump kept, replaced a fortnight later;
`{ "enabled": false }` turns the schedule off. `bun run backup` is a request, so it dumps even
when the schedule is off, and it still prunes to `keep`.

No tool changes these settings, so you change them in SQL. The row does not exist until you
store one, which is why this inserts it and replaces it if it is there. Name all three
settings, because the stored value is replaced as a whole and anything left out reads as its
default. This example keeps three dumps, a week apart:

```sh
docker compose exec db psql -U tracker -d tracker -c "
  INSERT INTO app_config (key, value)
  VALUES ('backup', '{\"enabled\": true, \"keep\": 3, \"intervalDays\": 7}')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();"
```

A value outside the limits (`keep` and `intervalDays` are whole numbers from 1 to 1000,
`enabled` is `true` or `false`) is not refused here, because the database does not check it:
the field that does not fit reads as its default and a line in the log names it.

`bun run serve` runs the schedule too: once the server is listening it starts a check, and then
checks hourly, whether the newest dump is `intervalDays` old, and dumps if so. The first check
runs on its own, so a dump that is due at start never delays a request. Nothing is scheduled
under `NODE_ENV=test`. Changing `keep`, `intervalDays` or `enabled` applies at the next hourly
check, with no restart. A dump that fails is logged (the reason from `pg_dump`, with the URL,
password and host name removed) and the service carries on. A dump half-written when a process dies is a
`*.dump.partial` file (also ignored by git); the next start removes those that have sat untouched for an hour.

### If `pg_dump` says "aborting because of server version mismatch"

The binary is `pg_dump`, or the path in `PG_DUMP_BIN`, and its major version must be **at least
the server's**. The Docker database is Postgres 16, so a `pg_dump` 14 (a common Homebrew or
distro default) refuses it. The fix that needs nothing installed is the database container's own
`pg_dump` 16, which `scripts/pg_dump-docker.sh` runs for you:

```sh
bun run db:up
PG_DUMP_BIN=scripts/pg_dump-docker.sh bun run backup
```

**Use it only when `DATABASE_URL` is the Docker database.** The script ignores the host and port in
`DATABASE_URL` and connects inside the container, so with a different database named there it would
silently dump the container's database instead: a backup of the wrong data, which no error reveals.

For `bun run serve` put `PG_DUMP_BIN=scripts/pg_dump-docker.sh` in `.env` and start it from the
clone's root, where that relative path resolves. The script needs the container from `db:up`
running, and takes the user, password and database from `DATABASE_URL` as usual.

The connection is given to `pg_dump` through its `PG*` environment variables, so the password
is in no command line, and an error from `pg_dump` is shown with the URL, the password and the host name removed.

### Restoring

A dump is a custom-format archive, so it is restored with `pg_restore`, **and only when you name a
database to restore into**: `pg_restore` connects only when it is given `--dbname`, and without it
it restores nothing. `PGDATABASE` does not stand in for it. Restore into an empty database, and
read the connection from `PG*` variables with the password at a prompt, not in a command line:

```sh
export PGHOST=<host> PGPORT=<port> PGUSER=<user> PGDATABASE=<database>
export PGSSLMODE=<the sslmode in your URL>      # leave this line out if the URL has none
printf 'Password: '; read -rs PGPASSWORD; echo; export PGPASSWORD
pg_restore --dbname="$PGDATABASE" backups/<file>
```

`pg_restore` has the same version rule as `pg_dump`: it must be at least as new as the one that
wrote the archive, and a 14 stops at `unsupported version (1.15) in file header` on a dump made
by 16. With the Docker database, use the container's own `pg_restore`, which needs only the user,
password and database name, passed by name:

```sh
export PGUSER=<user> PGDATABASE=<database>
printf 'Password: '; read -rs PGPASSWORD; echo; export PGPASSWORD
docker compose exec -T -e PGUSER -e PGPASSWORD db pg_restore --dbname="$PGDATABASE" < backups/<file>
```

Do not write `--dbname <url>` here, or anywhere: a URL on a command line is readable by every
other user on the machine through `ps`, which is why the dump splits the URL into variables. A
database name is not a credential, so `--dbname="$PGDATABASE"` is safe. A `~/.pgpass` file is an
equally good place for the password.

## Open Notebook, an optional companion

[Open Notebook](https://github.com/lfnovo/open-notebook) is a self-hosted notebook you can run
next to the tracker for the long text the tracker does not keep: full postings, company
research, interview notes. The tracker does not depend on it. What it is, what you gain, what it
costs and how to set it up are in [docs/open-notebook.md](docs/open-notebook.md).

When `OPEN_NOTEBOOK_URL` (and `OPEN_NOTEBOOK_API_KEY`, if the notebook has a password) is set in
`.env` and the notebook answers at startup, the MCP server adds ten `notebook_*` tools: store a
posting's text under its `posting_key`, store and read documents such as a CV, search, and add
notes. Otherwise no notebook tool is registered, and the server says why in one log line.

## Plugin skills

The Claude Code plugin ships five skills in [.claude-plugin/skills/](.claude-plugin/skills/):

- `notebook-store-postings`: how to store postings and documents in Open Notebook.
- `criteria-weighting`: gates, weights and anchors, and how to elicit them.
- `scoring-questions`: question types that fine-tune the criteria, and where answers go.
- `past-work-gates-and-flags`: what a user can tell about past work, turned into gates and flags.
- `recommendation-verdicts`: giving, revising and explaining the agent's apply, ask or skip verdict.

They are generic on purpose. Your own criteria, thresholds and preferences belong in a personal
variant that git never tracks. To make one, copy a skill into a directory whose name starts
with `personal-`, give it a new `name:` in its frontmatter, and write your specifics into it:

```sh
mkdir -p .claude-plugin/skills/personal-criteria
cp .claude-plugin/skills/criteria-weighting/SKILL.md .claude-plugin/skills/personal-criteria/SKILL.md
```

`.claude-plugin/skills/personal-*/` and `.claude/skills/personal-*/` are both in `.gitignore`,
and a test checks that git ignores them. A variant in `.claude-plugin/skills/` loads with the
plugin when Claude Code runs it from this clone; one in `~/.claude/skills/` loads in every
project and is outside any repository.

## For agents

The tracker is built to be driven by an agent through the MCP server. [AGENTS.md](AGENTS.md)
holds the instructions for any agent: the order of work, the fields only the user writes, and
how to give a verdict next to the rules recommendation. [docs/prompts/](docs/prompts/README.md)
holds short prompts to paste into a session, such as adding a posting or importing a sheet.

## The HTTP service

`bun run serve` starts the internal HTTP service: 29 routes under `/api` for the web app, and
`GET /health`. It reads `DATABASE_URL` from `.env`, so run `bun run db:up` and
`bun run db:migrate` first. It listens on port 3000; `PORT` changes it.

```sh
bun run setApiKey --burn-after-reading   # once: writes API_KEY into .env, shows it once, then clears the screen
bun run serve
curl -s localhost:3000/health
curl -s -H "Authorization: Bearer <the key setApiKey showed you>" localhost:3000/api/postings
```

Paste the key the script showed you into that last command; that is why it shows the key once
and then clears the screen. The script writes the key into `.env`, which the service reads. A
shell does not read `.env`, so a shell variable named `API_KEY` is empty unless you set it yourself.

**It will not start with neither an `API_KEY` nor an `AUTH_MODE`.** The package that runs the
service listens on **every network interface** and has no setting for a host, so a service with
nothing checked would hand every route, writes included, to any machine on the network. `/api`
answers 401 to a request with no good credential: the `API_KEY`, an API token, or a signed-in
browser (see "Signing in" below). `/health` is not behind any of them and says only `ok` or `error`.

The rate limit is 1,000 requests a minute, ten times the package default, so a board that loads
several routes at once does not trip it. When a built web app exists in `src/web/dist`, the same
process serves it, so the app and the API share one origin and no CORS setting is needed.

### What a response looks like

Every response this repository's code sends under `/api` is JSON in one envelope, whichever
route answered and whatever the status. A success is `{ "success": true, "data": ... }`
(`data` is `null` when there is nothing to return). A failure is `{ "success": false, "error": { "name": "...", "message": "..." } }`,
so a client reads `body.error.message` on every failure and never has to test whether `error`
is a string.

| Status | `error.name` | When |
|---|---|---|
| 400 | `ValidationError` | the input did not fit the route's schema; `message` names each field |
| 400 | `BulkItemError` | one item of a bulk write failed; `message` says which, and why when it can |
| 401 | `Unauthorized` | no credential, or a bearer token that is malformed, wrong or revoked |
| 403 | `Forbidden` | a signed-in browser sent a write without the `x-jat-csrf: 1` header |
| 404 | `NotFoundError` | the thing the path or body names does not exist |
| 409 | `ConflictError` or `ArchivedError` | it already exists, or it is archived and may not be used |
| 500 | `InternalError` | anything else; `message` is always `internal error` |

The 401 is one body for all three causes, so it never tells a caller which check failed. The
MCP server words the same failures the same way, with `{ "error": { "name", "message" } }`
inside the tool result (see "Two shapes of error" below). `/health` is outside this envelope.

Two responses come from the package that runs the service and not from this code, so they are
not in the envelope: a request body that is not valid JSON, or is over 1 MB, is answered with
a 400 or 413 carrying `{ "code": "...", "message": "<text>" }` (no `success` field), and a
request over the rate limit gets a 429 with a plain-text body. A client should treat a body
without `success`, or a body that is not JSON, as one of these.

## Signing in

The web app is behind a sign-in, and it is deliberately small: one user, no sign-up, no
"forgot password" mail. Think of it as the combination lock on a box that already sits in a
drawer of your own desk. `AUTH_MODE` in `.env` picks one of two modes; with it unset there is no
sign-in, and only the `API_KEY` opens `/api`.

```sh
bun run build:web        # once, and after pulling changes to src/web: builds the app into src/web/dist
```

**Password.** Run the script, type the password twice (it is not echoed), and restart the service.

```sh
bun run set-password     # writes AUTH_PASSWORD_HASH (an scrypt hash, never the password) and AUTH_MODE=password
bun run serve
```

Then open `http://localhost:3000/login`. Five wrong passwords in a row pause the login for a minute.

**OpenID Connect.** One account at a standard provider, with the authorization code flow and
PKCE. Register a client at the provider with the redirect URI below, then set these in `.env`:

```sh
AUTH_MODE=oidc
OIDC_ISSUER=https://issuer.example.com            # the provider's issuer; discovery is read from it
OIDC_CLIENT_ID=...
OIDC_CLIENT_SECRET=...                            # leave out for a public client
OIDC_REDIRECT_URI=http://localhost:3000/auth/oidc/callback
OIDC_ALLOWED_EMAIL=you@example.com                # and/or OIDC_ALLOWED_SUBJECT=<the provider's sub>
```

The ID token is checked against the issuer's published keys, its audience, its expiry and the
sign-in's nonce. Only the one allowed subject or email gets in, and an email counts only when the
provider marks it verified. Anyone else is sent back to the login page.

**A signed-in browser** holds one httpOnly, SameSite=Lax cookie, signed, that lasts 30 days. Set
`AUTH_COOKIE_SECURE=true` when you reach the app over HTTPS through a proxy, so the cookie is
marked Secure; on plain-HTTP localhost it cannot be. Browser writes carry an `x-jat-csrf: 1`
header, which a page on another site cannot add.

### API tokens

Signed in, open **Tokens** to mint a named token for an agent or an HTTP client. It is shown
once; only its SHA-256 is stored. The list shows each token's first characters, when it was
made and last used, and a Revoke button. A token is sent like the key:

```sh
curl -s -H "Authorization: Bearer <the token>" localhost:3000/api/postings
```

A token opens `/api` and nothing else: it cannot list or mint tokens, which needs a signed-in
browser. The `API_KEY` from `setApiKey` keeps working beside the tokens.

### Locked out

If you lost the password and have the code, run:

```sh
bun run reset-credentials
```

It signs out every browser, deletes every API token, and removes `AUTH_PASSWORD_HASH` from
`.env`, then prints what to do next (usually `bun run set-password`). It leaves `API_KEY` and
the OIDC settings alone. There is no other recovery path.

## The MCP server

`bun run mcp` starts the MCP server, which offers 60 tools for recording, scoring and reading
your search, writes included. It reads `DATABASE_URL` from `.env` like the rest of the
repository, so run `bun run db:up` and `bun run db:migrate` first. Once it is up it logs
`registered MCP tools` with `tools: 60`, which is how you see that every tool module loaded. On
stdio its log lines go to stderr, because stdout carries the protocol; on HTTP they go to stdout.

It has two transports, chosen by the `MCP_TRANSPORT` environment variable. **stdio is the
default and the supported path. HTTP is opt-in**, because nothing authenticates it (see below).
Unset or blank means stdio, and only the exact value `http` opts in to HTTP. Any other value,
a wrong case such as `HTTP` or a typo such as `std` included, is rejected at startup: the
server prints the value it got and exits with code 1 instead of guessing.

**stdio, the default, for Claude Desktop.** The server talks over its own standard input and
output, so a client that starts it as a child process (Claude Desktop does) needs no port and
opens no network socket.

```sh
bun run mcp
```

In Claude Desktop's MCP configuration, set the command to `bun`, the arguments to
`run mcp` (as `["run", "mcp"]`), and the working directory to your clone. There is no health
endpoint in this mode.

**The MCP server over stdio is unauthenticated, on purpose.** The API key from
`bun run setApiKey`, the API tokens and the sign-in all do nothing on stdio: there is no request
to carry a header, and the server is a local process with your shell's trust. The control is
process-level access: whoever can start the process, or reach the client that starts it, can call
every tool. Rely on who can run commands as you.

**HTTP, opt-in.** Set `MCP_TRANSPORT=http` and the server listens on port 8080 (`PORT`
changes it), with a health endpoint on port 3001 at `/health` (`HEALTH_PORT` changes it).
Those are the defaults of the `@open-tomato/service-mcp` package that runs the server. A port
that is taken stops the start with an error naming the setting, instead of moving to the next
free port, because a client configured for one URL would not find the server on another.

```sh
MCP_TRANSPORT=http bun run mcp
```

**No key is checked on this port.** The package has no place to check a header and this
repository does not add one, so the key from `setApiKey` is not consulted. Anyone who can
reach the port can call every tool, including the ones that write and the ones that set a
posting aside. The package binds **every network interface**, not only loopback (a socket
listing shows `*:8080` and `*:3001`), so on a machine joined to a network the port is
reachable from other machines. Use HTTP only behind a firewall that allows loopback alone, or
where you put your own authenticating proxy in front of it. For HTTP that checks a key, use the
web app's MCP listener below.

**HTTP with a key, from the web app.** Set `MCP_PORT` and `bun run serve` starts the MCP server
over HTTP too, on that port, beside the web app. Unset, it starts no listener and nothing
changes. Every request must carry `Authorization: Bearer <key>`, where the key is the `API_KEY`
or an API token minted on the Tokens page, the same credentials `/api` accepts. A request
without one, or with a wrong or revoked one, gets a 401 before it reaches a session, with the
same body whatever the reason. Each client gets a session of its own, as above. The port allows
1,000 requests a minute in all, the web app's own budget, and answers 429 past it, before the
bearer is checked.

```sh
MCP_PORT=8080 bun run serve
```

It is a port of its own, and not a route on the web app, because the web app reads JSON bodies
before its routes run and the MCP session table reads each body itself. Mint one token per
client, so each can be revoked on its own. The key travels in a header, so put HTTPS in front
of the port when a client reaches it over a network.

**Connecting a client over HTTP.** A client such as Insomnia or the MCP Inspector connects to
`http://localhost:8080/mcp` with the Streamable HTTP transport and no auth. The server answers
on any path, so `/mcp` is only a convention. Four things matter on a first connection:

- **`bun run mcp` alone is stdio.** It opens no port, so an HTTP client gets "connection
  refused". Start it with `MCP_TRANSPORT=http` as above.
- **One session per client.** Each `initialize` opens a session of its own, so several
  clients can connect at once, and a client that disconnects can connect again without a
  restart. A request carrying the id of a session that has ended gets a 404, and the client
  starts over with a new `initialize`.
- **A plain HTTP request needs the MCP headers.** A client's MCP mode sends them for you. A
  hand-built request must send `Content-Type: application/json` and
  `Accept: application/json, text/event-stream`, then repeat the `Mcp-Session-Id` header from
  the `initialize` response on every later request.
- **Tool calls need the database.** Listing tools works without Postgres, but a tool that reads
  or writes returns `{"error":{"name":"InternalError","message":"internal error"}}` when the
  database refuses the connection. The server hides the cause on purpose, and logs nothing about
  it. Check that `DATABASE_URL` in `.env` names the port `bun run db:up` publishes
  (`docker compose ps` shows it) and the password the container was created with.

The ten Open Notebook tools are added to that count only when a notebook is configured and
answers at startup; a second log line then says `notebook tools on: 10 Open Notebook tools`,
or `notebook tools off: <why>`. See "Open Notebook, an optional companion" above.

### Two shapes of error

A tool that fails inside the service returns `{ "error": { "name": "...", "message": "..." } }`
in its result, with the result's `isError` flag set. A call whose arguments do not match the
tool's input schema never reaches the service: the MCP SDK rejects it itself and returns its
own validation message as plain text, with `isError` set but no `error` object. A client that
parses tool results has to handle both. The SDK produces the second shape, so this repository
cannot make it match the first.
