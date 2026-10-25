import { strict as assert } from "node:assert";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { copyStorage, type CopyDestination } from "../src/copy-storage.ts";
import { POSTGRES_SETTINGS } from "../src/postgres-settings.ts";
import type { StorageFS } from "../src/storage-fs.ts";
import { unpackTemplate } from "../src/unpack-template.ts";
import { openStorage } from "./node-storage.ts";

const SOURCE_FILE = join(tmpdir(), "pgbox-copy-source-test.sqlite");
const CHECKPOINTED_COPY_FILE = join(tmpdir(), "pgbox-copy-checkpointed-test.sqlite");
const UNCHECKPOINTED_COPY_FILE = join(tmpdir(), "pgbox-copy-uncheckpointed-test.sqlite");
const INTERRUPTED_COPY_FILE = join(tmpdir(), "pgbox-copy-interrupted-test.sqlite");
const TEMPLATE = "public/template.tar.gz";
const ROWS = 100_000;
const ROWS_AFTER_CHECKPOINT = 1_000;
const COPY_ID = "test-copy";
const SUMMARY_SQL = "select count(*)::int as rows, md5(string_agg(v, ',' order by id)) as checksum from t";
const COPY_ONLY_SQL = "insert into t(v) values ('only in the copy')";

interface Summary {
  rows: number;
  checksum: string;
}

const deliverTo = (fs: StorageFS): CopyDestination => ({
  putNodes: async (nodes) => fs.putNodes(nodes),
  putPages: async (pages) => fs.putPages(pages),
});

const failingAfterFirstPages = (fs: StorageFS): CopyDestination => {
  let delivered = 0;
  return {
    putNodes: async (nodes) => fs.putNodes(nodes),
    putPages: async (pages) => {
      if (delivered++) throw new Error("destination went away");
      fs.putPages(pages);
    },
  };
};

async function summarize(pg: PGlite): Promise<Summary> {
  const { rows } = await pg.query<Summary>(SUMMARY_SQL);
  const [summary] = rows;
  assert.ok(summary);
  return summary;
}

async function startSource() {
  const source = openStorage(SOURCE_FILE);
  await unpackTemplate(source.fs, new Blob([readFileSync(TEMPLATE)]).stream());
  const pg = await PGlite.create({ fs: source.fs, postgresqlconf: POSTGRES_SETTINGS });
  source.fs.markInitialized();
  await pg.exec("create table t(id serial primary key, v text)");
  await pg.exec(`insert into t(v) select repeat(md5(i::text), 6) from generate_series(1, ${ROWS}) as i`);
  return { ...source, pg };
}

async function copyInto(source: StorageFS, file: string) {
  const target = openStorage(file);
  target.fs.startReceivingCopy(COPY_ID);
  const copied = await copyStorage(source, deliverTo(target.fs));
  assert.equal(target.fs.isInitialized(), false);
  target.fs.finishReceivingCopy();
  assert.equal(target.fs.isInitialized(), true);
  assert.equal(target.fs.receivingCopy(), undefined);
  console.debug(`copied ${copied.pages} pages`);
  return target;
}

async function bootedCopyMatches(source: PGlite, file: string) {
  const target = openStorage(file);
  const pg = await PGlite.create({ fs: target.fs, postgresqlconf: POSTGRES_SETTINGS });
  const before = await summarize(source);
  assert.deepEqual(await summarize(pg), before);
  await pg.exec(COPY_ONLY_SQL);
  assert.equal((await summarize(pg)).rows, before.rows + 1);
  assert.deepEqual(await summarize(source), before);
  await pg.close();
  target.db.close();
}

async function interruptedCopyStaysUninitialized(source: StorageFS) {
  const target = openStorage(INTERRUPTED_COPY_FILE);
  target.fs.startReceivingCopy(COPY_ID);
  await assert.rejects(copyStorage(source, failingAfterFirstPages(target.fs)), /destination went away/);
  assert.equal(target.fs.isInitialized(), false);
  assert.equal(target.fs.receivingCopy(), COPY_ID);
  target.db.close();
}

for (const file of [SOURCE_FILE, CHECKPOINTED_COPY_FILE, UNCHECKPOINTED_COPY_FILE, INTERRUPTED_COPY_FILE]) rmSync(file, { force: true });
const source = await startSource();
await source.pg.exec("checkpoint");
(await copyInto(source.fs, CHECKPOINTED_COPY_FILE)).db.close();
await bootedCopyMatches(source.pg, CHECKPOINTED_COPY_FILE);
await source.pg.exec(`insert into t(v) select md5(i::text) from generate_series(1, ${ROWS_AFTER_CHECKPOINT}) as i`);
(await copyInto(source.fs, UNCHECKPOINTED_COPY_FILE)).db.close();
await bootedCopyMatches(source.pg, UNCHECKPOINTED_COPY_FILE);
await interruptedCopyStaysUninitialized(source.fs);
await source.pg.close();
source.db.close();
