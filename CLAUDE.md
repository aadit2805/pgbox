# pgbox — a real Postgres per name, on Cloudflare

One Cloudflare Worker, one Durable Object class. `POST /<name>` with SQL in the body runs it
against that name's own Postgres; a new name gets a new, empty database. `DELETE /<name>`
wipes that database's storage. `POST /mcp` is a stateless MCP server (JSON responses, no
SSE) exposing `run_sql`, `list_tables` and `delete_database`; the name `mcp` is reserved for it.
Database names are 1 to 128 characters with no `/`, on both routes. Each Durable Object
runs PGlite (Postgres compiled to wasm) and keeps its data directory in the object's SQLite
storage, one row per 8 KB page, so memory holds only what Postgres is using.

TypeScript, strict, no `any`. Node 24 (`.nvmrc`; `nvm use`); Wrangler refuses older versions.

## Commands

- `npm run dev` — local Worker on `wrangler dev`.
- `npm run typecheck` — must pass before any commit.
- `npm test` — `test/storage-fs.test.ts`: real PGlite on `node:sqlite` through `StorageFS`
  (fresh boot from the template, 250k rows, reopen, update survives reopen).
- `npm run deploy` — `wrangler deploy` (builds the template first). Workers Builds runs it on
  every push to `main`, so a push is a production deploy.
- `PGBOX_URL=https://… node scripts/loadtest.mjs [growth|fanout|all]` — against the deployed
  Worker; reads the token from `.pgbox-token` and deletes every database it creates.
- `npm run patch-wasm` (runs on `npm install`) — rewrites `pglite.wasm`'s memory floor into
  `patched/pglite.wasm`.
- `npm run template` — builds `public/template.tar.gz`, the empty cluster new databases start
  from (gitignored; runs before `npm test` and `npm run deploy`).
- `npm run precompile` — re-records `src/precompiled/` after a PGlite upgrade.

## Layout

```
src/
  index.ts             fetch handler: bearer check, route /<name> to its Durable Object
  database.ts          PostgresDatabase Durable Object: one Postgres, booted once, queries
  postgres.ts          createPostgres({ fs, onLog }): PGlite with the Workers shims
  unpack-template.ts   streams the gzipped template tar into StorageFS one page at a time
  postgres-settings.ts POSTGRES_SETTINGS (small caches, capped WAL, quiet logs), shared with the test and template build
  storage-fs.ts        StorageFS: PGlite filesystem on a synchronous SQL exec (DO storage or node:sqlite)
  mcp.ts               MCP over HTTP: JSON-RPC initialize, tools/list, tools/call
  serialize.ts         JSON for Postgres values (int8 as string, bytea as hex) and error messages
  bearer.ts            timing-safe Authorization: Bearer check
  precompiled/         wasm Emscripten would compile at runtime, shipped compiled, matched by bytes
patched/
  patch-memory.py      lowers a wasm memory's minimum page count
  make-template.mjs    initdb once in Node, dump the empty cluster to public/template.tar.gz
  capture-precompiled.mjs  records every module PGlite compiles at runtime into src/precompiled
public/template.tar.gz served through the ASSETS binding, never directly (run_worker_first)
```

## Why the Workers shims exist

Each is a hard limit of the Workers runtime, found by running it, not guessed:

- **No runtime wasm compilation.** Emscripten's `addFunction` and Postgres's `.so` add-ons
  (`dict_snowball`, `plpgsql`) compile wasm on the fly. `patched/capture-precompiled.mjs` records
  them in Node; `postgres.ts` swaps `WebAssembly.Module` for a subclass that returns the
  precompiled module when the bytes match. A new PGlite version or new extension means
  re-running the capture.
- **128 MB per isolate, shared by every Durable Object in it.** Stock `pglite.wasm` declares a
  128 MB minimum memory, so it could never start. `patch-memory.py` lowers it to 32 MB and
  `postgresqlconf` shrinks `shared_buffers` and friends.
- **initdb boots a second Postgres.** PGlite's initdb path creates a throwaway PGlite and a
  separate initdb instance. New databases instead load `public/template.tar.gz`, built with
  `--wal-segsize=1`, without `template0`/`template1` and without spare WAL segments, so a new
  database stores about 10.6 MB instead of 40. `min_wal_size`/`max_wal_size` keep WAL from
  growing to Postgres's 80 MB default floor.
- **PGlite's `loadDataDir` holds the whole tar in memory** (compressed, unpacked, and split
  into files: about 60 MB), which ran isolates out of memory when many databases started at
  once. `unpack-template.ts` streams it into storage one 8 KB page at a time instead.
- **PGlite runs no background checkpointer**, so WAL grew with every write and was never
  recycled. `checkpointIfWalFull` checkpoints after a query once WAL passes `MAX_WAL_MB`.
- **`process.versions.node` exists** under Workers, so Emscripten takes its Node path and calls
  `process.binding`. `process` is hidden for the duration of `PGlite.create`.
- **`import.meta.url` is undefined**, so `wrangler.jsonc` defines it.
- **`Date.now()` only advances on I/O** inside a Worker, so timings come from the client
  (`scripts/loadtest.mjs`), never from inside the Worker.

## Rules

- Every database is reachable only through the Worker, behind `PGBOX_TOKEN`. The template asset
  is never served to a request.
- Postgres data lives in Durable Object storage through `StorageFS`. Never reintroduce whole-
  directory dumps or in-memory copies of PGDATA; that is the 20 MB ceiling we removed.
- Memory numbers come from production (`wrangler tail` shows `Exceeded Memory Limit`), not from
  `wrangler dev`, which doesn't enforce the limit.
- A new secret goes in `.dev.vars.example` and gets a `cloudflare.bindings.<NAME>.description`
  in `package.json`, or the Deploy to Cloudflare button won't ask for it.
- Commit as `Aadit Shah <aadit2805@gmail.com>`.

## Coding rules

Rules, not preferences. Each one is a defect in review.

**Comments**
- Zero comments: no JSDoc, no banner or section-divider comments, no narration inside
  functions, no commented-out code, no TODOs. Code explains itself through names and small
  functions. If a line seems to need a comment, rename the constant or extract a function with
  a descriptive name, then delete the comment.
- The only exception is one line for a genuinely non-obvious external quirk that code cannot
  express: an API or runtime limitation (Workers forbid runtime wasm compilation; PGlite hands
  writes the raw heap `ArrayBuffer`). Keep these rare; every one is a deletion candidate in
  review.
- `// eslint-disable` and `/// <reference` are directives, not comments.

**Types and shape**
- Strict TypeScript, no `any`. No type assertions or non-null assertions except at a typed
  boundary (PGlite/Emscripten internals, SQL rows, wasm bytes): type the payload at the fields
  you read and keep loose shapes out of callers.
- Functions do one thing; extract instead of nesting. No long parameter lists; pass an object.
- No magic values. Thresholds, limits, page sizes, memory sizes, and Postgres settings are
  `SCREAMING_SNAKE_CASE` constants at module scope, or come from env with a named default.
  Module-level constants sit at the top of the file above the functions, never inside a
  function body.
- No IIFEs and no `typeof import("…")` type imports.
- Kebab-case file names. Match the surrounding file's style when editing it.

**Reuse**
- Grep for the canonical example before writing pattern-shaped code, and mirror it exactly,
  defaults and quirks included.
- Shared logic lives in one place.
- Default to the durable option over the shortcut.

**Errors and replies**
- Never `catch {}` into silence. A catch returns a typed error value, rethrows, or logs and
  produces a visible response.
- Every request path responds. A Postgres or storage failure is an HTTP error with a message,
  never a dropped request.
- Logs go through `console.error` / `console.warn` for failures with the identifying id (the
  database name) in the message, and `console.debug` for everything else. No `console.log` in
  `src/`. Never log tokens, secrets, or full payloads.

**Non-negotiables (easy to violate, always checked)**
- Nothing that validates secrets runs at import time.
- Never compare the bearer token with `===`; use `bearer.ts`.
- `StorageFS` paths are compared with `substr`, never `LIKE`: Postgres file names contain `_`.

**Scope and verification**
- Change only what the task needs: no cosmetic cleanups in touched files, no repo-wide
  refactors to make verification pass.
- `npm run typecheck` and `npm test` before finishing; a deploy plus
  `node scripts/loadtest.mjs` for anything touching memory, boot, or storage. Run checks
  through the package scripts, never one-off substitutes, and never `echo` a success marker.
  A pre-existing failure you did not cause gets raised, not worked around.
- A failing check gets its cause fixed: never skip it, loosen it, or special-case around it.
- Test the real path first (the deployed Worker, real PGlite) before writing stubs, and
  confirm a test is needed before writing one. Every hand-off includes the local steps to
  verify it.
- Before every push, a code-reviewer subagent reviews the diff for dead code, rule violations
  and edge cases. Read the whole batch of findings, group them by root cause, and fix each
  cause once.
- Never commit or push without an explicit instruction. Single-line conventional-commit
  messages (`feat:`, `fix:`, `perf:`, `chore:`, `refactor:`, `docs:`, `test:`), lowercase after
  the colon, aiming under 50 chars, saying what changed (not why), no ticket ids, no body, no
  trailing period.
- "Reset" or "clean" tooling replays the flow; it never deletes data.

## Audit rubric (flag these)

Each is a defect to fix, not a preference:

1. Any comment beyond the single-line external-quirk exception: banners, narration, JSDoc.
2. Commented-out code or TODOs.
3. `any`, type assertions, or non-null assertions outside a typed boundary.
4. Functions doing several things, deep nesting, long parameter lists.
5. Duplicated logic.
6. Magic numbers or meaningful bare string literals (limits, sizes, settings, URLs).
7. Swallowed errors, or a failure path that does not end in a visible response.
8. Dead code, unused exports/imports/params.
9. A client constructed or a required secret read at module top level.
10. Secrets or tokens in code, logs, comments, or committed files.
11. `console.log` in `src/`; module constants declared mid-file or inside functions; IIFEs;
    `typeof import()` types.
