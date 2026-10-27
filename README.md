# pgbox

A real Postgres for every name, on Cloudflare.

Each database is a Durable Object running [PGlite](https://github.com/electric-sql/pglite). Idle databases cost almost nothing and wake on the next query.

```sh
curl -X POST https://<your-worker>.workers.dev/my-agent \
  -H "Authorization: Bearer $PGBOX_TOKEN" \
  -d "create table notes (body text); select now()"
```

A new name gets an empty database. `DELETE /my-agent` wipes it. The name `mcp` is reserved.

## Use it from an agent

`/mcp` is an MCP server with `run_sql`, `list_tables`, `delete_database` and `copy_database`:

```sh
claude mcp add --transport http pgbox https://<your-worker>.workers.dev/mcp \
  --header "Authorization: Bearer $PGBOX_TOKEN"
```

The agent picks a name and gets the same data back in later sessions.

## Scoped tokens

`PGBOX_TOKEN` unlocks every database. To share just one, mint a token for it:

```sh
curl -X POST "https://<your-worker>.workers.dev/my-agent/token?ttl=86400" \
  -H "Authorization: Bearer $PGBOX_TOKEN"
# {"token":"pgbox_…","database":"my-agent","expiresAt":1792796328}
```

`ttl` is in seconds (default 30 days, max one year, or `never`).

A scoped token can query and delete its own database, and nothing else: it can't touch other names, mint tokens, or copy. Use it anywhere `PGBOX_TOKEN` goes, including MCP and the proxy.

Tokens aren't stored, so you can't revoke one. Changing `PGBOX_TOKEN` revokes them all.

## Copy a database

```sh
curl -X POST "https://<your-worker>.workers.dev/my-agent/copy?to=my-agent-test" \
  -H "Authorization: Bearer $PGBOX_TOKEN"
# {"copied":"my-agent","to":"my-agent-test","pages":23528,"copiedMB":183.7}
```

The copy is independent, so it's a safe place to try a migration.

- Needs `PGBOX_TOKEN`.
- The new name must be unused, or you get a 409. Nothing is overwritten.
- The source can't have a psql or ORM connection open.
- Queries to the source wait until the copy finishes.
- A 204 MB database copies in about 8 seconds. Larger ones are untested.
- If a copy is cut off by a crash or Cloudflare's 30-second CPU limit, the new name answers with a 409 until you delete it.

## Connect with psql or an ORM

`scripts/proxy.mjs` (Node 24, no dependencies) exposes a database as a local Postgres port:

```sh
PGBOX_URL=https://<your-worker>.workers.dev PGBOX_TOKEN=$PGBOX_TOKEN \
  npm run proxy -- my-agent --port 5432
psql postgresql://postgres@127.0.0.1:5432/postgres
```

The user, password and database in the URL are ignored. The local port has no SSL, so use `sslmode=disable` or `prefer`.

Each database allows one connection at a time, so cap your client's pool at one:

- node-postgres and Drizzle: `new Pool({ connectionString, max: 1 })`
- Prisma 7: `new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 1 }) })` (it ignores `connection_limit`)
- Prisma 6: `?connection_limit=1&sslmode=disable`

Prisma's `migrate dev` needs a shadow database, which pgbox can't create. Use `migrate diff` and `migrate deploy` instead:

```sh
mkdir -p prisma/migrations/0001_init
npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script > prisma/migrations/0001_init/migration.sql
npx prisma migrate deploy
```

While connected:

- HTTP queries to that database get a 409 and MCP calls return an error until you disconnect. `DELETE` still works and closes the connection.
- Idle connections close after 10 minutes, and you're billed for the time they're open.
- `COPY FROM STDIN` and Ctrl-C cancellation don't work.
- Messages are capped at 4 MB, and responses are buffered, so page large results.
- `LISTEN`/`NOTIFY` only reaches the same connection.

## Run it

Needs Workers Paid (the bundle is about 6.5 MB).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/aadit2805/pgbox)

The button asks for `PGBOX_TOKEN`. Use `openssl rand -hex 32` and save it, since it can't be read back.

Or deploy with Node 24:

```sh
npm install
npx wrangler secret put PGBOX_TOKEN
npm run deploy
```

`npm test` runs the tests locally.

## Limits

- Postgres uses about 46 MB of a 128 MB memory limit that's shared with other databases.
- Starting 50+ new databases in the same second can fail a few percent of them with a 500. Retry if it's safe.
- The clock is frozen during a query, so timeouts never fire and `pg_sleep` hangs until Cloudflare resets the database (about 30 s). Data survives.
- An empty database takes about 10.6 MB, so 5 GB holds about 470. Tested up to about 200 MB each.
- `create database` fails. Use schemas, another name, or a copy.

## License

MIT. PGlite is Apache 2.0, and Postgres is under the PostgreSQL License.
