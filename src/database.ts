import { DurableObject } from "cloudflare:workers";
import type { PGlite } from "@electric-sql/pglite";
import { createPostgres, wasmMemoryMegabytes } from "./postgres";
import { StorageFS, type SqlValue } from "./storage-fs";

const TEMPLATE_URL = "https://assets/template.tar.gz";

const toStorageValue = (value: SqlValue): SqlStorageValue =>
  value instanceof Uint8Array ? value.slice().buffer : value;

export interface Env {
  DB: DurableObjectNamespace<Database>;
  ASSETS: Fetcher;
  PGBOX_TOKEN?: string;
}

export interface QueryResult {
  rows: unknown[];
  startedFromTemplate: boolean;
  wasmMemoryMB: number;
}

export class Database extends DurableObject<Env> {
  private postgres?: Promise<PGlite>;
  private startedFromTemplate = false;

  async query(name: string, sql: string): Promise<QueryResult> {
    const pg = await this.boot(name);
    const results = await pg.exec(sql);
    return { rows: results.at(-1)?.rows ?? [], startedFromTemplate: this.startedFromTemplate, wasmMemoryMB: wasmMemoryMegabytes(pg) };
  }

  private boot(name: string): Promise<PGlite> {
    this.postgres ??= this.start(name).catch((err: unknown) => {
      this.postgres = undefined;
      console.error(`postgres boot failed for ${name}:`, err);
      throw err;
    });
    return this.postgres;
  }

  private async start(name: string): Promise<PGlite> {
    const storage = this.ctx.storage.sql;
    const fs = new StorageFS((query, ...bindings) => storage.exec(query, ...bindings.map(toStorageValue)).toArray());
    this.startedFromTemplate = !fs.isInitialized();
    const template = this.startedFromTemplate ? await this.loadTemplate() : undefined;
    return createPostgres({ fs, template, onLog: (line) => console.debug(`postgres ${name}: ${line}`) });
  }

  private async loadTemplate(): Promise<Blob> {
    const response = await this.env.ASSETS.fetch(TEMPLATE_URL);
    if (!response.ok) throw new Error(`template asset returned ${response.status}`);
    return response.blob();
  }
}
