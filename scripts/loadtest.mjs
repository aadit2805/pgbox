import { readFileSync } from "node:fs";

const URL_BASE = process.env.PGBOX_URL ?? "https://pgbox.pgbox.workers.dev";
const TOKEN = readFileSync(new URL("../.pgbox-token", import.meta.url), "utf8").trim();
const RUN = Date.now().toString(36);
const GROWTH_BATCHES = 40;
const GROWTH_ROWS_PER_BATCH = 20_000;
const FANOUT_SIZES = [10, 50, 100, 250];
const ERROR_PREVIEW_CHARS = 200;

async function sql(db, query) {
  const started = Date.now();
  const res = await fetch(`${URL_BASE}/${db}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: query });
  const text = await res.text();
  const wallMs = Date.now() - started;
  try {
    return { ok: res.ok, status: res.status, wallMs, ...JSON.parse(text) };
  } catch {
    return { ok: false, status: res.status, wallMs, message: text.slice(0, ERROR_PREVIEW_CHARS) };
  }
}

const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor((p / 100) * values.length))];

async function growth() {
  console.log("\n== one database, growing until something breaks ==");
  const db = `growth-${RUN}`;
  const created = await sql(db, "create table t(id serial primary key, v text)");
  console.log(`created: ${created.ok ? "ok" : created.message}, wall ${created.wallMs}ms, wasm ${created.wasmMemoryMB}MB`);
  for (let batch = 1; batch <= GROWTH_BATCHES; batch++) {
    const r = await sql(db, `insert into t(v) select repeat(md5(random()::text), 6) from generate_series(1, ${GROWTH_ROWS_PER_BATCH}); select pg_size_pretty(pg_database_size(current_database())) as size`);
    if (!r.ok) {
      console.log(`batch ${batch}: FAILED (${r.status}) ${r.message}`);
      return;
    }
    console.log(`batch ${batch}: db ${r.rows[0].size}, wasm ${r.wasmMemoryMB}MB, wall ${r.wallMs}ms`);
  }
}

async function fanout(n) {
  const results = await Promise.all(
    Array.from({ length: n }, (_, i) => sql(`fan-${RUN}-${n}-${i}`, "create table t(id int); insert into t select generate_series(1, 1000); select count(*) from t")),
  );
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const walls = ok.map((r) => r.wallMs);
  console.log(`${n} at once: ${ok.length} ok, ${failed.length} failed | wall p50 ${percentile(walls, 50)}ms p95 ${percentile(walls, 95)}ms | wasm ${ok[0]?.wasmMemoryMB}MB`);
  for (const reason of [...new Set(failed.map((r) => `${r.status} ${r.message ?? ""}`.trim()))].slice(0, 3)) console.log(`  failure: ${reason}`);
}

const mode = process.argv[2] ?? "all";
if (mode === "growth" || mode === "all") await growth();
if (mode === "fanout" || mode === "all") {
  console.log("\n== many databases booting at the same moment ==");
  for (const n of FANOUT_SIZES) await fanout(n);
}
