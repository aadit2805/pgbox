import { strict as assert } from "node:assert";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { StorageFS, type SqlExec, type SqlValue } from "../src/storage-fs.ts";

const DB_FILE = join(tmpdir(), "pgbox-storage-fs-test.sqlite");
const TEMPLATE = "public/template.tar.gz";
const BATCHES = 10;
const ROWS_PER_BATCH = 25_000;
const LOOKUP_ID = 123_456;
const UPDATED_ID = 7;
const POSTGRES_SETTINGS = ["shared_buffers = 16MB", "work_mem = 2MB", "maintenance_work_mem = 8MB", "temp_buffers = 2MB", "wal_buffers = 1MB"];
const MB = 1024 * 1024;

const toInput = (value: SqlValue): SQLInputValue => (value instanceof ArrayBuffer ? new Uint8Array(value) : value);
const toOutput = (value: SQLOutputValue): SqlValue => (typeof value === "bigint" ? Number(value) : value);

function openStorage() {
  const db = new DatabaseSync(DB_FILE);
  const sql: SqlExec = (query, ...bindings) => {
    const statement = db.prepare(query);
    if (!statement.columns().length) {
      statement.run(...bindings.map(toInput));
      return [];
    }
    return statement.all(...bindings.map(toInput)).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, toOutput(value)])));
  };
  return { db, fs: new StorageFS(sql) };
}

async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const result = await run();
  console.debug(`${label}: ${Date.now() - started} ms`);
  return result;
}

async function freshDatabaseLoadsTemplateAndTakesWrites() {
  const { db, fs } = openStorage();
  assert.equal(fs.isInitialized(), false);
  const pg = await timed("fresh boot from template", () =>
    PGlite.create({ fs, loadDataDir: new Blob([readFileSync(TEMPLATE)]), postgresqlconf: POSTGRES_SETTINGS }),
  );
  assert.equal(fs.isInitialized(), true);
  await pg.exec("create table t(id serial primary key, v text)");
  await timed(`insert ${BATCHES * ROWS_PER_BATCH} rows`, async () => {
    for (let i = 0; i < BATCHES; i++) await pg.exec(`insert into t(v) select repeat(md5(random()::text), 6) from generate_series(1, ${ROWS_PER_BATCH})`);
  });
  const { rows } = await pg.query<{ n: number }>("select count(*)::int as n from t");
  assert.equal(rows[0]?.n, BATCHES * ROWS_PER_BATCH);
  console.debug(`wasm memory ${pg.Module.HEAPU8.length / MB} MB, js heap ${Math.round(process.memoryUsage().heapUsed / MB)} MB`);
  await pg.close();
  db.close();
}

async function reopenSeesEveryRowAndPersistsUpdates() {
  const { db, fs } = openStorage();
  const pg = await timed("reopen", () => PGlite.create({ fs, postgresqlconf: POSTGRES_SETTINGS }));
  const { rows } = await pg.query<{ n: number; max: number }>("select count(*)::int as n, max(id) as max from t");
  assert.equal(rows[0]?.n, BATCHES * ROWS_PER_BATCH);
  const lookup = await timed("point lookup after reopen", () => pg.query("select v from t where id = $1", [LOOKUP_ID]));
  assert.equal(lookup.rows.length, 1);
  await pg.exec(`update t set v = 'changed' where id = ${UPDATED_ID}`);
  await pg.close();
  db.close();

  const again = openStorage();
  const pg2 = await PGlite.create({ fs: again.fs, postgresqlconf: POSTGRES_SETTINGS });
  const updated = await pg2.query<{ v: string }>("select v from t where id = $1", [UPDATED_ID]);
  assert.equal(updated.rows[0]?.v, "changed");
  await pg2.close();
  again.db.close();
}

rmSync(DB_FILE, { force: true });
await freshDatabaseLoadsTemplateAndTakesWrites();
await reopenSeesEveryRowAndPersistsUpdates();
