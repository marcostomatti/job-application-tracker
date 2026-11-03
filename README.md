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

## The MCP server

`bun run mcp` starts the MCP server, which offers 46 tools for recording, scoring and reading
your search, writes included. It reads `DATABASE_URL` from `.env` like the rest of the
repository, so run `bun run db:up` and `bun run db:migrate` first. At start it prints
`registered 46 MCP tools` to stderr, which is how you see that every tool module loaded.

It has two transports, chosen by the `MCP_TRANSPORT` environment variable. **stdio is the
default and the supported path. HTTP is opt-in**, because nothing authenticates it (see below).

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
