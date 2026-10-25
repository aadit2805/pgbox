# pgbox

A real Postgres for every name, on Cloudflare.

Each database is a Durable Object running [PGlite](https://github.com/electric-sql/pglite). Its data lives in the object's storage, so an idle database costs almost nothing and wakes up when it's queried.

```sh
curl -X POST https://<your-worker>.workers.dev/my-agent \
  -H "Authorization: Bearer $PGBOX_TOKEN" \
  -d "create table notes (body text); select now()"
```

A new name gets a new, empty database. `DELETE /my-agent` wipes it. The name `mcp` is reserved.

## Use it from an agent

`/mcp` is an MCP server with four tools: `run_sql`, `list_tables`, `delete_database` and `copy_database` (admin token only). To add it to Claude Code:

```sh
claude mcp add --transport http pgbox https://<your-worker>.workers.dev/mcp \
  --header "Authorization: Bearer $PGBOX_TOKEN"
```

The agent picks a database name and gets the same data back in every later session. If Claude Code says the server needs authentication, the bearer header is missing or wrong.

## Scoped tokens

`PGBOX_TOKEN` unlocks every database. To hand out access to just one, mint a token for it:

```sh
curl -X POST "https://<your-worker>.workers.dev/my-agent/token?ttl=86400" \
  -H "Authorization: Bearer $PGBOX_TOKEN"
# {"token":"pgbox_…","database":"my-agent","expiresAt":1792796328}
```

`ttl` is in seconds, up to one year. Without it a token lasts 30 days. `ttl=never` makes one that never expires. `expiresAt` is a Unix time, or `null` for a token that never expires.

A scoped token can `POST` and `DELETE` its own database and nothing else. Over HTTP, any other name gets a 403, and so does minting a token or copying a database. Over MCP it can only pass its own name as `database`. Any other name comes back as a tool error (`isError: true`) instead of a 403:

```sh
claude mcp add --transport http pgbox-my-agent https://<your-worker>.workers.dev/mcp \
  --header "Authorization: Bearer pgbox_…"
```

Tokens are signed with a key derived from `PGBOX_TOKEN` and aren't stored anywhere, so one can't be revoked on its own. Changing `PGBOX_TOKEN` revokes all of them.

## Copy a database

```sh
curl -X POST "https://<your-worker>.workers.dev/my-agent/copy?to=my-agent-test" \
  -H "Authorization: Bearer $PGBOX_TOKEN"
# {"copied":"my-agent","to":"my-agent-test","pages":23528,"copiedMB":183.7}
```

The copy is a separate database, so writes to one never reach the other. It's useful for trying a migration before running it for real.

- Only `PGBOX_TOKEN` can copy. A scoped token can't, because a copy reads one name and creates another.
- The new name must never have been used. If it has, the copy gets a 409 (`target_exists`) and nothing is overwritten; delete it first. Copying a name that was never used is a 404.
- The copy is a consistent snapshot. Queries to the source wait until it finishes, and it gets a 409 (`wire_connection_open`) while the source has a wire connection open.
- Pages move 4 MB at a time, so memory doesn't limit the size: a 204 MB database copied in about 8 seconds.
- Until the copy finishes, the new name answers with a 409 (`copy_in_progress`). A copy that fails partway is wiped. If the Worker dies mid-copy, the new name stays in that state until you delete it.
- A copy stores as much as its source, so copying a database doubles its storage.

## Connect with psql or an ORM

`GET /<name>/wire` carries the Postgres wire protocol over a WebSocket. `scripts/proxy.mjs` (Node 24, no dependencies) turns that into a local Postgres port:

```sh
PGBOX_URL=https://<your-worker>.workers.dev PGBOX_TOKEN=$PGBOX_TOKEN \
  npm run proxy -- my-agent --port 5432
psql postgresql://postgres@127.0.0.1:5432/postgres
```

Any client that speaks Postgres can then use that URL: node-postgres, Drizzle, Prisma, `psql`. The password is ignored, because the proxy already sent the token. A scoped token for `my-agent` works as `PGBOX_TOKEN` too. The user and database name in the URL don't matter either; the database is the name you gave the proxy.

The traffic between the proxy and the Worker is TLS when `PGBOX_URL` is `https://`, and the local port is plain TCP on `127.0.0.1`, so the client must not require SSL (`sslmode=disable` or `prefer`).

What to expect:

- One wire connection per database at a time. A second one gets `too many connections` (SQLSTATE 53300) and is closed. Set your ORM's pool size to 1.
- While a wire connection is open, HTTP queries to that database get a 409 (`wire_connection_open`) and MCP calls get a tool error instead of running, because the connection and those queries would share one Postgres session. Disconnect to use them again.
- An HTTP or MCP request can't leave a transaction open. If one does (`begin` without `commit`, or an error after `begin`), it is rolled back and the request fails, so the next wire connection never starts inside someone else's transaction.
- Disconnecting rolls back any open transaction, including a batch that never reached its Sync, and runs `discard all`.
- A connection with no traffic for 10 minutes is closed with SQLSTATE 57P05.
- A single client message is limited to 4 MB, and a connection that has more than 8 MB of messages waiting to run is closed.
- `COPY FROM STDIN` (and `psql`'s `\copy ... from`) fails with an error. `COPY TO STDOUT` works.
- Query cancellation (Ctrl-C in `psql`) doesn't work: the cancel request arrives as a second connection and is refused.
- A single response is held in memory before it's sent, so select large results in pages.
- The Durable Object stays awake for as long as the connection is open, so an idle connection is billed as active time.
- Prisma's `migrate dev` needs a shadow database it can create, which pgbox can't. `prisma db push` and `prisma migrate deploy` don't need one.

## Run it

Needs a Cloudflare account on Workers Paid, because the bundle is about 6.5 MB.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/aadit2805/pgbox)

The button copies this repo to your Git account, builds it on Cloudflare and asks for `PGBOX_TOKEN`. Pick a long random one (`openssl rand -hex 32`) and save it, since it can't be read back.

Or deploy from your machine with Node 24:

```sh
npm install
npx wrangler secret put PGBOX_TOKEN
npm run deploy
```

`npm test` runs Postgres on the same storage layer locally, against `node:sqlite`.

## Limits

- Each Durable Object gets about 128 MB of memory, shared with others in the same isolate. Postgres uses about 46 MB.
- One database has been tested past 200 MB.
- 100 new databases started at the same moment: all came up in one run, 99 in another. More than that hasn't been tested.
- Every database starts at about 10.6 MB of storage, so 5 GB holds about 470 of them. Past that, storage runs about 20 MB above the data size (203 MB of data took 226 MB).
- There are no template databases, so `create database` fails. Use schemas, another name, or a copy.

## License

MIT. PGlite is Apache 2.0, and Postgres is under the PostgreSQL License.
