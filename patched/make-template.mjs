import { mkdirSync, writeFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { MB, POSTGRES_SETTINGS } from "../src/postgres-settings.ts";

const OUT_FILE = new URL("../public/template.tar.gz", import.meta.url);
const INITDB_ARGS = ["--wal-segsize=1"];
const UNUSED_DATABASES = ["template0", "template1"];
const WAL_DIR = "/pg_wal/";
const WAL_SEGMENT_NAME_PATTERN = "^[0-9A-F]{24}$";

async function dropUnusedDatabases(pg) {
  for (const name of UNUSED_DATABASES) {
    await pg.exec(`update pg_database set datistemplate = false where datname = '${name}'`);
    await pg.exec(`drop database ${name}`);
  }
}

async function walSegments(pg) {
  const { rows } = await pg.query(
    `select current_setting('data_directory') || $1 as dir, pg_walfile_name(pg_current_wal_lsn() + 1) as current,
      coalesce(array_agg(name order by name), '{}') as segments from pg_ls_waldir() where name ~ $2`,
    [WAL_DIR, WAL_SEGMENT_NAME_PATTERN],
  );
  return rows[0];
}

async function removeSpareWalSegments(pg) {
  await pg.exec("checkpoint");
  const { dir, current, segments } = await walSegments(pg);
  for (const segment of segments) if (segment > current) pg.Module.FS.unlink(dir + segment);
}

const pg = await PGlite.create({ initDbStartParams: INITDB_ARGS, postgresqlconf: POSTGRES_SETTINGS });
await dropUnusedDatabases(pg);
await removeSpareWalSegments(pg);
const dump = await pg.dumpDataDir("gzip");
mkdirSync(new URL(".", OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, Buffer.from(await dump.arrayBuffer()));
console.log(`template: ${(dump.size / MB).toFixed(2)} MB`);
await pg.close();
