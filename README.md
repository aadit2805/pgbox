# pgbox

A real Postgres for every name, on Cloudflare.

Each database is a Durable Object running [PGlite](https://github.com/electric-sql/pglite). Its data lives in the object's storage, so an idle database costs almost nothing and wakes up when it's queried.

```sh
curl -X POST https://<your-worker>.workers.dev/my-agent \
  -H "Authorization: Bearer $PGBOX_TOKEN" \
  -d "create table notes (body text); select now()"
```

A new name gets a new, empty database. `DELETE /my-agent` wipes it.

## Use it from an agent

`/mcp` is an MCP server with three tools: `run_sql`, `list_tables` and `delete_database`. To add it to Claude Code:

```sh
claude mcp add --transport http pgbox https://<your-worker>.workers.dev/mcp \
  --header "Authorization: Bearer $PGBOX_TOKEN"
```

The agent picks a database name and gets the same data back in every later session. If Claude Code says the server needs authentication, the bearer header is missing or wrong.

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
- 100 new databases started at the same moment all came up. More than that hasn't been tested.
- Every database starts at about 29 MB of storage, so 5 GB holds about 170 of them.

## License

MIT. PGlite is Apache 2.0, and Postgres is under the PostgreSQL License.
