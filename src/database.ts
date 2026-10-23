import { DurableObject } from "cloudflare:workers";
import { messages, Mutex, type PGlite } from "@electric-sql/pglite";
import { checkpointIfWalFull, createPostgres, wasmMemoryMegabytes } from "./postgres";
import { SWITCHING_PROTOCOLS } from "./http-status";
import { MB } from "./postgres-settings";
import { errorMessage } from "./serialize";
import { StorageFS, type SqlValue } from "./storage-fs";
import { unpackTemplate } from "./unpack-template";
import {
  ADMIN_SHUTDOWN,
  backendInput,
  clientOutput,
  closeWithError,
  INTERNAL_ERROR,
  leavesSessionIdle,
  MessageReader,
  NO_ENCRYPTION,
  PROTOCOL_VIOLATION,
  readMessages,
  sendFrames,
  simpleQuery,
  syncMessage,
  TOO_MANY_CONNECTIONS,
  WireProtocolError,
  type PostgresMessage,
  type WireMessage,
} from "./wire";

const TEMPLATE_URL = "https://assets/template.tar.gz";
const STORAGE_MB_DIGITS = 1;
const NORMAL_CLOSURE = 1000;
const BINARY_TYPE = "arraybuffer";
const ROLLBACK_SQL = "rollback";
const DISCARD_SESSION_SQL = "discard all";

const toStorageValue = (value: SqlValue): SqlStorageValue => (value instanceof Uint8Array ? value.slice().buffer : value);

export interface Env {
  DB: DurableObjectNamespace<PostgresDatabase>;
  ASSETS: Fetcher;
  PGBOX_TOKEN?: string;
}

export const DATABASE_NAME_HEADER = "x-pgbox-database";

export const openDatabase = (env: Env, name: string) => env.DB.get(env.DB.idFromName(name));

type Cell = string | number | bigint | boolean | null | object;

export interface QueryResult {
  rows: Record<string, Cell>[];
  startedFromTemplate: boolean;
  wasmMemoryMB: number;
  storageMB: number;
}

interface WireFrame {
  name: string;
  socket: WebSocket;
  reader: MessageReader;
  frame: ArrayBuffer | string;
}

export class PostgresDatabase extends DurableObject<Env> {
  private postgres?: Promise<PGlite>;
  private startedFromTemplate = false;
  private session = new Mutex();
  private wire?: WebSocket;
  private wireBusy = false;

  query(name: string, sql: string): Promise<QueryResult> {
    return this.session.runExclusive(async () => {
      if (this.wireBusy) throw new Error(`${name} is in a transaction on a wire connection; retry once it commits or disconnects`);
      const pg = await this.boot(name);
      try {
        const results = await pg.exec(sql);
        await this.checkpoint(name, pg);
        return { rows: results.at(-1)?.rows ?? [], startedFromTemplate: this.startedFromTemplate, wasmMemoryMB: wasmMemoryMegabytes(pg), storageMB: this.storageMegabytes() };
      } catch (err) {
        if (!(err instanceof messages.DatabaseError)) this.discardPostgres(name, err);
        throw err;
      }
    });
  }

  async destroy(name: string): Promise<{ deleted: string }> {
    await this.ctx.blockConcurrencyWhile(() =>
      this.session.runExclusive(async () => {
        this.dropWire(name);
        await this.closePostgres(name);
        await this.ctx.storage.deleteAll();
      }),
    );
    console.debug(`database ${name} deleted`);
    return { deleted: name };
  }

  async fetch(request: Request): Promise<Response> {
    const name = decodeURIComponent(request.headers.get(DATABASE_NAME_HEADER) ?? "");
    const { 0: client, 1: server } = new WebSocketPair();
    server.binaryType = BINARY_TYPE;
    server.accept();
    if (this.wire) this.refuseWire(name, server);
    else this.acceptWire(name, server);
    return new Response(null, { status: SWITCHING_PROTOCOLS, webSocket: client });
  }

  private acceptWire(name: string, socket: WebSocket) {
    this.wire = socket;
    this.wireBusy = false;
    const reader = new MessageReader();
    const release = () => this.session.runExclusive(() => this.releaseWire(name, socket));
    socket.addEventListener("message", (event) => this.session.runExclusive(() => this.onWireFrame({ name, socket, reader, frame: event.data })));
    socket.addEventListener("close", release);
    socket.addEventListener("error", release);
    console.debug(`wire connection to ${name} opened`);
  }

  private refuseWire(name: string, socket: WebSocket) {
    const reader = new MessageReader();
    socket.addEventListener("message", (event) => {
      try {
        this.answerRefused(name, socket, readMessages(reader, event.data));
      } catch (err) {
        this.failWire({ name, socket, err });
      }
    });
  }

  private answerRefused(name: string, socket: WebSocket, received: WireMessage[]) {
    for (const message of received) {
      if (message.kind === "encryption") {
        sendFrames(socket, NO_ENCRYPTION);
        continue;
      }
      console.warn(`second wire connection to ${name} refused`);
      closeWithError(socket, { code: TOO_MANY_CONNECTIONS, message: `${name} already has an open connection; pgbox allows one at a time per database` });
      return;
    }
  }

  private async onWireFrame({ name, socket, reader, frame }: WireFrame) {
    if (this.wire !== socket) return;
    try {
      for (const message of readMessages(reader, frame)) {
        if (this.wire !== socket) return;
        await this.handleWireMessage(name, socket, message);
      }
    } catch (err) {
      this.failWire({ name, socket, err });
      await this.releaseWire(name, socket);
    }
  }

  private async handleWireMessage(name: string, socket: WebSocket, message: WireMessage) {
    if (message.kind === "encryption") return sendFrames(socket, NO_ENCRYPTION);
    if (message.kind === "cancel") throw new WireProtocolError("cancel requests are not supported");
    if (message.kind === "terminate") {
      await this.releaseWire(name, socket);
      return socket.close(NORMAL_CLOSURE);
    }
    await this.feedWire(name, socket, message);
  }

  private async feedWire(name: string, socket: WebSocket, message: PostgresMessage) {
    const pg = await this.boot(name);
    const output = await this.execProtocol(name, pg, message);
    sendFrames(socket, output);
    this.wireBusy = !leavesSessionIdle(message, output);
    if (!this.wireBusy) await this.checkpoint(name, pg);
  }

  private async execProtocol(name: string, pg: PGlite, message: PostgresMessage): Promise<Uint8Array> {
    try {
      return clientOutput(await pg.execProtocolRaw(backendInput(message)));
    } catch (err) {
      this.discardPostgres(name, err);
      throw err;
    }
  }

  private failWire({ name, socket, err }: { name: string; socket: WebSocket; err: unknown }) {
    const message = errorMessage(err);
    console.error(`wire connection to ${name} failed: ${message}`);
    closeWithError(socket, { code: err instanceof WireProtocolError ? PROTOCOL_VIOLATION : INTERNAL_ERROR, message });
  }

  private async releaseWire(name: string, socket: WebSocket) {
    if (this.wire !== socket) return;
    this.wire = undefined;
    this.wireBusy = false;
    console.debug(`wire connection to ${name} closed`);
    if (this.postgres) await this.resetSession(name, this.postgres);
  }

  private async resetSession(name: string, booted: Promise<PGlite>) {
    try {
      const pg = await booted;
      await pg.execProtocolRaw(simpleQuery(ROLLBACK_SQL));
      await pg.execProtocolRaw(syncMessage());
      if (pg.isInTransaction()) await pg.exec(ROLLBACK_SQL);
      await pg.exec(DISCARD_SESSION_SQL);
    } catch (err) {
      this.discardPostgres(name, err);
    }
  }

  private dropWire(name: string) {
    if (!this.wire) return;
    closeWithError(this.wire, { code: ADMIN_SHUTDOWN, message: `${name} was deleted` });
    this.wire = undefined;
    this.wireBusy = false;
  }

  private storageMegabytes(): number {
    return Number((this.ctx.storage.sql.databaseSize / MB).toFixed(STORAGE_MB_DIGITS));
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

  private async checkpoint(name: string, pg: PGlite) {
    try {
      await checkpointIfWalFull(pg);
    } catch (err) {
      if (err instanceof messages.DatabaseError) console.error(`checkpoint for ${name} failed: ${err.message}`);
      else this.discardPostgres(name, err);
    }
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
