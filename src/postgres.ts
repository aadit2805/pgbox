import { PGlite } from "@electric-sql/pglite";
import pgliteData from "@electric-sql/pglite/dist/pglite.data";
import pgliteWasm from "../patched/pglite.wasm";
import { PRECOMPILED } from "./precompiled/index";
import type { StorageFS } from "./storage-fs";

const MB = 1024 * 1024;
const INITIAL_WASM_MEMORY_BYTES = 32 * MB;
const POSTGRES_SETTINGS = [
  "shared_buffers = 16MB",
  "work_mem = 2MB",
  "maintenance_work_mem = 8MB",
  "temp_buffers = 2MB",
  "wal_buffers = 1MB",
];

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

const asBytes = (source: BufferSource) =>
  source instanceof Uint8Array ? source : ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);

type ModuleConstructor = new (bytes: BufferSource) => WebAssembly.Module;

const wasmNamespace: object = WebAssembly;
const RuntimeModule: ModuleConstructor = Reflect.get(wasmNamespace, "Module");

class PrecompiledModule extends RuntimeModule {
  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof RuntimeModule;
  }

  constructor(bytes: BufferSource) {
    const view = asBytes(bytes);
    const match = PRECOMPILED.find((entry) => sameBytes(entry.bytes, view));
    if (match) return match.module;
    super(bytes);
  }
}

// Workers forbid compiling wasm at runtime, which Emscripten's addFunction and Postgres's .so add-ons both do.
Object.defineProperty(WebAssembly, "Module", { value: PrecompiledModule, writable: true, configurable: true });

async function withoutNodeGlobal<T>(run: () => Promise<T>): Promise<T> {
  const nodeProcess: unknown = Reflect.get(globalThis, "process");
  // Emscripten takes its Node path whenever process.versions.node exists, which it does under Workers.
  Reflect.set(globalThis, "process", undefined);
  try {
    return await run();
  } finally {
    Reflect.set(globalThis, "process", nodeProcess);
  }
}

export interface PostgresOptions {
  fs: StorageFS;
  template?: Blob;
  onLog: (line: string) => void;
}

export function createPostgres({ fs, template, onLog }: PostgresOptions): Promise<PGlite> {
  return withoutNodeGlobal(() =>
    PGlite.create({
      fs,
      pgliteWasmModule: pgliteWasm,
      fsBundle: new Blob([pgliteData]),
      loadDataDir: template,
      initialMemory: INITIAL_WASM_MEMORY_BYTES,
      postgresqlconf: POSTGRES_SETTINGS,
      onStderr: (line) => {
        onLog(line);
        return true;
      },
    }),
  );
}

export function wasmMemoryMegabytes(pg: PGlite): number {
  return Math.round(pg.Module.HEAPU8.length / MB);
}
