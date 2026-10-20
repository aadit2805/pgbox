import { DurableObject } from "cloudflare:workers";
import { messages, type PGlite } from "@electric-sql/pglite";
import { createPostgres, wasmMemoryMegabytes } from "./postgres";
import { StorageFS, type SqlValue } from "./storage-fs";
import { unpackTemplate } from "./unpack-template";

const TEMPLATE_URL = "https://assets/template.tar.gz";

const toStorageValue = (value: SqlValue): SqlStorageValue => (value instanceof Uint8Array ? value.slice().buffer : value);

export interface Env {
  DB: DurableObjectNamespace<PostgresDatabase>;
  ASSETS: Fetcher;
  PGBOX_TOKEN?: string;
}

export const MAX_DATABASE_NAME_CHARS = 128;
export const DATABASE_NAME_RULE = `1 to ${MAX_DATABASE_NAME_CHARS} characters with no "/"`;

export const isDatabaseName = (name: string) => name.length > 0 && name.length <= MAX_DATABASE_NAME_CHARS && !name.includes("/");

export const openDatabase = (env: Env, name: string) => env.DB.get(env.DB.idFromName(name));

type Cell = string | number | bigint | boolean | null | object;

export interface QueryResult {
  rows: Record<string, Cell>[];
  startedFromTemplate: boolean;
  wasmMemoryMB: number;
}

export class PostgresDatabase extends DurableObject<Env> {
  private postgres?: Promise<PGlite>;
  private startedFromTemplate = false;

  async query(name: string, sql: string): Promise<QueryResult> {
    const pg = await this.boot(name);
    try {
      const results = await pg.exec(sql);
      return { rows: results.at(-1)?.rows ?? [], startedFromTemplate: this.startedFromTemplate, wasmMemoryMB: wasmMemoryMegabytes(pg) };
    } catch (err) {
      if (!(err instanceof messages.DatabaseError)) this.discardPostgres(name, err);
      throw err;
    }
  }

  async destroy(name: string): Promise<{ deleted: string }> {
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.closePostgres(name);
      await this.ctx.storage.deleteAll();
    });
    console.debug(`database ${name} deleted`);
    return { deleted: name };
  }

  private async closePostgres(name: string) {
    const booted = this.postgres;
    this.postgres = undefined;
    if (!booted) return;
    try {
      await (await booted).close();
    } catch (err) {
      console.warn(`postgres for ${name} did not close cleanly before delete:`, err);
    }
  }

  private boot(name: string): Promise<PGlite> {
    this.postgres ??= this.start(name).catch((err: unknown) => {
      this.discardPostgres(name, err);
      throw err;
    });
    return this.postgres;
  }

  private discardPostgres(name: string, err: unknown) {
    this.postgres = undefined;
    console.error(`postgres for ${name} discarded after:`, err);
  }

  private async start(name: string): Promise<PGlite> {
    const storage = this.ctx.storage.sql;
    const fs = new StorageFS((query, ...bindings) => storage.exec(query, ...bindings.map(toStorageValue)).toArray());
    this.startedFromTemplate = !fs.isInitialized();
    if (this.startedFromTemplate) await this.loadTemplate(fs);
    const pg = await createPostgres({ fs, onLog: (line) => console.debug(`postgres ${name}: ${line}`) });
    fs.markInitialized();
    return pg;
  }

  private async loadTemplate(fs: StorageFS) {
    fs.clear();
    const response = await this.env.ASSETS.fetch(TEMPLATE_URL);
    if (!response.ok) throw new Error(`template asset returned ${response.status}`);
    if (!response.body) throw new Error("template asset has no body");
    await unpackTemplate(fs, response.body);
  }
}
