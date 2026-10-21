import { mkdirSync, writeFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const OUT_FILE = new URL("../public/template.tar.gz", import.meta.url);
const INITDB_ARGS = ["--wal-segsize=1"];
const MB = 1024 * 1024;

const pg = await PGlite.create({ initDbStartParams: INITDB_ARGS });
const dump = await pg.dumpDataDir("gzip");
mkdirSync(new URL(".", OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, Buffer.from(await dump.arrayBuffer()));
console.log(`template: ${(dump.size / MB).toFixed(2)} MB`);
await pg.close();
