import { PGlite } from "@electric-sql/pglite";
import pgliteData from "@electric-sql/pglite/dist/pglite.data";
import pgliteWasm from "../patched/pglite.wasm";
import { PRECOMPILED } from "./precompiled/index";
import { MB, POSTGRES_SETTINGS } from "./postgres-settings";
import type { StorageFS } from "./storage-fs";

type ModuleConstructor = new (bytes: BufferSource) => WebAssembly.Module;

const INITIAL_WASM_MEMORY_BYTES = 32 * MB;
const wasmNamespace: object = WebAssembly;
const RuntimeModule: ModuleConstructor = Reflect.get(wasmNamespace, "Module");
const nodeProcess: unknown = Reflect.get(globalThis, "process");

let activeBoots = 0;

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

const asBytes = (source: BufferSource) =>
  source instanceof Uint8Array ? source : ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);

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
  // Emscripten takes its Node path whenever process.versions.node exists, which it does under Workers.
  if (activeBoots++ === 0) Reflect.set(globalThis, "process", undefined);
  try {
    return await run();
  } finally {
    if (--activeBoots === 0) Reflect.set(globalThis, "process", nodeProcess);
  }
}

export interface PostgresOptions {
  fs: StorageFS;
  onLog: (line: string) => void;
}

export function createPostgres({ fs, onLog }: PostgresOptions): Promise<PGlite> {
  return withoutNodeGlobal(() =>
    PGlite.create({
      fs,
      pgliteWasmModule: pgliteWasm,
      fsBundle: new Blob([pgliteData]),
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
