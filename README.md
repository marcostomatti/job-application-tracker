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
so the pack leaves it blank for you to fill in. Until you do, a position scored against the set
has no overall score and is never recommended for apply. That is the template arriving empty,
not a fault.

Installing is safe to repeat: a second run for the same pack name and version reports that the
set exists and changes nothing. The loaded set is not made the default; you choose that.

`bun run lint:migrations` rejects any pack in `seeds/vanilla/` with a weight or an apply
threshold set, and `seed:pack` refuses such a file too.

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

`src/backup/schedule.ts` also exports `startBackupSchedule` and `createBackupDependency`, which
check hourly whether the newest dump is `intervalDays` old and dump if so. Nothing starts them
yet: `bun run serve` does not make backups.

The binary is `pg_dump`, or the path in `PG_DUMP_BIN`. **Its major version must be at least the
server's**: the Docker database is Postgres 16, and a `pg_dump` 14 refuses it with
`aborting because of server version mismatch`. Point `PG_DUMP_BIN` at a 16 or newer binary.
The connection is given to `pg_dump` through its `PG*` environment variables, so the password
is in no command line, and an error from `pg_dump` is shown with the URL and password removed.
Restore with `pg_restore --dbname <url> backups/<file>`.

## The HTTP service

`bun run serve` starts the internal HTTP service: 23 routes under `/api` for the web app, and
`GET /health`. It reads `DATABASE_URL` from `.env`, so run `bun run db:up` and
`bun run db:migrate` first. It listens on port 3000; `PORT` changes it.

```sh
bun run setApiKey --burn-after-reading   # once: writes API_KEY into .env, shows it once, then clears the screen
bun run serve
curl -s localhost:3000/health
curl -s -H "Authorization: Bearer <the key setApiKey showed you>" localhost:3000/api/positions
```

Paste the key the script showed you into that last command; that is why it shows the key once
and then clears the screen. The script writes the key into `.env`, which the service reads. A
shell does not read `.env`, so a shell variable named `API_KEY` is empty unless you set it yourself.

**It will not start without an `API_KEY`.** The package that runs the service listens on
**every network interface** and has no setting for a host, so a service with no key would hand
every route, writes included, to any machine on the network. With a key set, `/api` answers 401
to a missing or wrong bearer token. `/health` is not behind the key and says only `ok` or `error`.

The rate limit is 1,000 requests a minute, ten times the package default, so a board that loads
several routes at once does not trip it. When a built web app exists in `src/web/dist`, the same
process serves it, so the app and the API share one origin and no CORS setting is needed.

## The MCP server

`bun run mcp` starts the MCP server, which offers 46 tools for recording, scoring and reading
your search, writes included. It reads `DATABASE_URL` from `.env` like the rest of the
repository, so run `bun run db:up` and `bun run db:migrate` first. At start it prints
`registered 46 MCP tools` to stderr, which is how you see that every tool module loaded.

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

The API key from `bun run setApiKey` does nothing on stdio. There is no request to carry a
header, so the key is inert, and the control is process-level access: whoever can start the
process, or reach the client that starts it, can call every tool. Treat stdio as
unauthenticated and rely on who can run commands as you.

**HTTP, opt-in.** Set `MCP_TRANSPORT=http` and the server listens on port 8080 (`PORT`
changes it), with a health endpoint on port 3001 at `/health`. Those are the defaults of the
`@open-tomato/service-mcp` package that runs the server, and the health port has no setting
here.

```sh
MCP_TRANSPORT=http bun run mcp
```

**No key is checked on this port.** The package has no place to check a header and this
repository does not add one, so the key from `setApiKey` is not consulted. Anyone who can
reach the port can call every tool, including the ones that write and the ones that set a
position aside. The package binds **every network interface**, not only loopback (a socket
listing shows `*:8080` and `*:3001`), so on a machine joined to a network the port is
reachable from other machines. Use HTTP only behind a firewall that allows loopback alone, or
where you put your own authenticating proxy in front of it.

### Two shapes of error

A tool that fails inside the service returns `{ "error": { "name": "...", "message": "..." } }`
in its result, with the result's `isError` flag set. A call whose arguments do not match the
tool's input schema never reaches the service: the MCP SDK rejects it itself and returns its
own validation message as plain text, with `isError` set but no `error` object. A client that
parses tool results has to handle both. The SDK produces the second shape, so this repository
cannot make it match the first.
