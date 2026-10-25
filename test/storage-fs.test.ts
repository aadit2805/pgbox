import { strict as assert } from "node:assert";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { MB, POSTGRES_SETTINGS } from "../src/postgres-settings.ts";
import { unpackTemplate } from "../src/unpack-template.ts";
import { openStorage as openNodeStorage } from "./node-storage.ts";

const DB_FILE = join(tmpdir(), "pgbox-storage-fs-test.sqlite");
const TEMPLATE = "public/template.tar.gz";
const BATCHES = 10;
const ROWS_PER_BATCH = 25_000;
const LOOKUP_ID = 123_456;
const UPDATED_ID = 7;
const SHORT_FILE_BYTES = 100;
const GROWN_FILE_BYTES = 16_384;

const openStorage = () => openNodeStorage(DB_FILE);

async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const result = await run();
  console.debug(`${label}: ${Date.now() - started} ms`);
  return result;
}

async function freshDatabaseLoadsTemplateAndTakesWrites() {
  const { db, fs } = openStorage();
  assert.equal(fs.isInitialized(), false);
  const pg = await timed("fresh boot from template", async () => {
    await unpackTemplate(fs, new Blob([readFileSync(TEMPLATE)]).stream());
    return PGlite.create({ fs, postgresqlconf: POSTGRES_SETTINGS });
  });
  fs.markInitialized();
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

function growingAFileReadsZerosPastOldEnd() {
  const { db, fs } = openStorage();
  const fd = fs.open("/grow-test");
  fs.write(fd, new Uint8Array(SHORT_FILE_BYTES).fill(1), 0, SHORT_FILE_BYTES, 0);
  fs.truncate("/grow-test", GROWN_FILE_BYTES);
  const buffer = new Uint8Array(GROWN_FILE_BYTES).fill(9);
  assert.equal(fs.read(fd, buffer, 0, GROWN_FILE_BYTES, 0), GROWN_FILE_BYTES);
  assert.ok(buffer.subarray(0, SHORT_FILE_BYTES).every((b) => b === 1));
  assert.ok(buffer.subarray(SHORT_FILE_BYTES).every((b) => b === 0));
  fs.close(fd);
  fs.unlink("/grow-test");
  db.close();
}

rmSync(DB_FILE, { force: true });
growingAFileReadsZerosPastOldEnd();
await freshDatabaseLoadsTemplateAndTakesWrites();
await reopenSeesEveryRowAndPersistsUpdates();
