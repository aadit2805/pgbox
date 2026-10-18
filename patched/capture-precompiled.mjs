import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const OUT_DIR = new URL("../src/precompiled/", import.meta.url);
const MAIN_MODULE_MIN_BYTES = 4 * 1024 * 1024;
const EXERCISE_SQL = [
  "do $$ begin perform 1; end $$",
  "select to_tsvector('english', 'running dogs')",
  "create table t(id serial primary key, v text); insert into t(v) values ('x'); select * from t",
];

const asBuffer = (bytes) =>
  Buffer.from(ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes));

const RuntimeModule = WebAssembly.Module;
const captured = new Map();
class RecordingModule extends RuntimeModule {
  static [Symbol.hasInstance](value) {
    return value instanceof RuntimeModule;
  }

  constructor(bytes) {
    const buf = asBuffer(bytes);
    if (buf.length < MAIN_MODULE_MIN_BYTES) captured.set(createHash("sha256").update(buf).digest("hex").slice(0, 16), buf);
    super(bytes);
  }
}
WebAssembly.Module = RecordingModule;

const pg = await PGlite.create();
for (const sql of EXERCISE_SQL) await pg.exec(sql);
await pg.close();

mkdirSync(OUT_DIR, { recursive: true });
const names = [...captured.keys()].sort();
for (const name of names) {
  writeFileSync(new URL(`${name}.wasm`, OUT_DIR), captured.get(name));
  writeFileSync(new URL(`${name}.bin`, OUT_DIR), captured.get(name));
}
const index = [
  ...names.flatMap((name, i) => [`import module${i} from "./${name}.wasm";`, `import bytes${i} from "./${name}.bin";`]),
  "",
  "export const PRECOMPILED: { bytes: Uint8Array; module: WebAssembly.Module }[] = [",
  ...names.map((_, i) => `  { bytes: new Uint8Array(bytes${i}), module: module${i} },`),
  "];",
  "",
].join("\n");
writeFileSync(new URL("index.ts", OUT_DIR), index);
console.log(`captured ${names.length} modules: ${names.map((name) => `${name} (${captured.get(name).length} B)`).join(", ")}`);
