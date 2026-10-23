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
  closeWithError,
  endSession,
  exchange,
  IDLE_SESSION_TIMEOUT,
  INTERNAL_ERROR,
  isOpen,
  leavesSessionIdle,
  MAX_QUEUED_BYTES,
  MAX_QUEUED_MB,
  MessageReader,
  NO_ENCRYPTION,
  PROTOCOL_VIOLATION,
  readMessages,
  ROLLBACK_SQL,
  sendFrames,
  TOO_MANY_CONNECTIONS,
  WireProtocolError,
  type PostgresMessage,
  type WireError,
  type WireMessage,
} from "./wire";

const TEMPLATE_URL = "https://assets/template.tar.gz";
const STORAGE_MB_DIGITS = 1;
const NORMAL_CLOSURE = 1000;
const BINARY_TYPE = "arraybuffer";
const MS_PER_MINUTE = 60_000;
const WIRE_IDLE_TIMEOUT_MINUTES = 10;
const WIRE_IDLE_TIMEOUT_MS = WIRE_IDLE_TIMEOUT_MINUTES * MS_PER_MINUTE;
const POSTGRES_RESTARTED = "Postgres restarted after an internal error; reconnect";

export const DATABASE_NAME_HEADER = "x-pgbox-database";

const toStorageValue = (value: SqlValue): SqlStorageValue => (value instanceof Uint8Array ? value.slice().buffer : value);

export interface Env {
  DB: DurableObjectNamespace<PostgresDatabase>;
  ASSETS: Fetcher;
  PGBOX_TOKEN?: string;
}

export const openDatabase = (env: Env, name: string) => env.DB.get(env.DB.idFromName(name));

type Cell = string | number | bigint | boolean | null | object;

export interface QueryResult {
  rows: Record<string, Cell>[];
  startedFromTemplate: boolean;
  wasmMemoryMB: number;
  storageMB: number;
}

export interface SessionBusy {
  busy: string;
}

export const isSessionBusy = (outcome: object): outcome is SessionBusy => "busy" in outcome;

interface WireConnection {
  name: string;
  socket: WebSocket;
  reader: MessageReader;
  queuedBytes: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

type Frame = ArrayBuffer | string;

async function rollbackIfOpen(pg: PGlite): Promise<boolean> {
  if (!pg.isInTransaction()) return false;
  await pg.exec(ROLLBACK_SQL);
  return true;
}

const frameBytes = (frame: Frame) => (typeof frame === "string" ? frame.length : frame.byteLength);

export class PostgresDatabase extends DurableObject<Env> {
  private postgres?: Promise<PGlite>;
  private startedFromTemplate = false;
  private session = new Mutex();
  private wire?: WireConnection;

  query(name: string, sql: string): Promise<QueryResult | SessionBusy> {
    return this.session.runExclusive(async () => {
      if (this.wire) return { busy: `${name} has an open wire connection, so HTTP and MCP queries are refused until it disconnects` };
      const pg = await this.boot(name);
      const { results, leftTransactionOpen } = await this.execHttp(name, pg, sql);
      if (leftTransactionOpen) throw new Error("an HTTP request can't leave a transaction open, so it was rolled back; send begin and commit in the same request");
      await this.checkpoint(name, pg);
      return { rows: results.at(-1)?.rows ?? [], startedFromTemplate: this.startedFromTemplate, wasmMemoryMB: wasmMemoryMegabytes(pg), storageMB: this.storageMegabytes() };
    });
  }

  async destroy(name: string): Promise<{ deleted: string }> {
    await this.ctx.blockConcurrencyWhile(() =>
      this.session.runExclusive(async () => {
        this.dropWire({ code: ADMIN_SHUTDOWN, message: `${name} was deleted` });
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
    const connection: WireConnection = { name, socket: server, reader: new MessageReader(), queuedBytes: 0 };
    if (this.wire) this.refuseWire(connection);
    else this.acceptWire(connection);
    return new Response(null, { status: SWITCHING_PROTOCOLS, webSocket: client });
  }

  private async execHttp(name: string, pg: PGlite, sql: string) {
    try {
      const results = await pg.exec(sql);
      return { results, leftTransactionOpen: await rollbackIfOpen(pg) };
    } catch (err) {
      if (!(err instanceof messages.DatabaseError)) this.discardPostgres(name, err);
      else await rollbackIfOpen(pg);
      throw err;
    }
  }

  private acceptWire(connection: WireConnection) {
    this.wire = connection;
    const release = () => this.session.runExclusive(() => this.releaseWire(connection));
    connection.socket.addEventListener("message", (event) => this.queueWireFrame(connection, event.data));
    connection.socket.addEventListener("close", release);
    connection.socket.addEventListener("error", release);
    this.armIdleTimer(connection);
    console.debug(`wire connection to ${connection.name} opened`);
  }

  private queueWireFrame(connection: WireConnection, frame: Frame) {
    if (!isOpen(connection.socket)) return;
    this.armIdleTimer(connection);
    const bytes = frameBytes(frame);
    connection.queuedBytes += bytes;
    if (connection.queuedBytes > MAX_QUEUED_BYTES) {
      return this.abortWire(connection, { code: PROTOCOL_VIOLATION, message: `more than ${MAX_QUEUED_MB} MB of messages were waiting to run` });
    }
    return this.session.runExclusive(async () => {
      connection.queuedBytes -= bytes;
      await this.onWireFrame(connection, frame);
    });
  }

  private refuseWire(connection: WireConnection) {
    const { name, socket, reader } = connection;
    socket.addEventListener("message", (event) => {
      try {
        this.answerRefused(connection, readMessages(reader, event.data));
      } catch (err) {
        this.failWire(connection, err);
      }
    });
    socket.addEventListener("close", () => clearTimeout(connection.idleTimer));
    this.armIdleTimer(connection);
    console.warn(`second wire connection to ${name} refused`);
  }

  private answerRefused({ name, socket, idleTimer }: WireConnection, received: WireMessage[]) {
    for (const message of received) {
      if (message.kind === "encryption") {
        sendFrames(socket, NO_ENCRYPTION);
        continue;
      }
      clearTimeout(idleTimer);
      closeWithError(socket, { code: TOO_MANY_CONNECTIONS, message: `${name} already has an open wire connection; pgbox allows one per database at a time` });
      return;
    }
  }

  private armIdleTimer(connection: WireConnection) {
    clearTimeout(connection.idleTimer);
    connection.idleTimer = setTimeout(
      () => this.abortWire(connection, { code: IDLE_SESSION_TIMEOUT, message: `closed after ${WIRE_IDLE_TIMEOUT_MINUTES} minutes without traffic` }),
      WIRE_IDLE_TIMEOUT_MS,
    );
  }

  private abortWire(connection: WireConnection, error: WireError) {
    console.warn(`wire connection to ${connection.name} closed: ${error.message}`);
    closeWithError(connection.socket, error);
    return this.session.runExclusive(() => this.releaseWire(connection));
  }

  private async onWireFrame(connection: WireConnection, frame: Frame) {
    try {
      for (const message of readMessages(connection.reader, frame)) {
        if (this.wire !== connection || !isOpen(connection.socket)) return;
        await this.handleWireMessage(connection, message);
      }
    } catch (err) {
      this.failWire(connection, err);
      await this.releaseWire(connection);
    }
  }

  private async handleWireMessage(connection: WireConnection, message: WireMessage) {
    if (message.kind === "encryption") return sendFrames(connection.socket, NO_ENCRYPTION);
    if (message.kind === "cancel") throw new WireProtocolError("cancel requests are not supported");
    if (message.kind === "terminate") {
      await this.releaseWire(connection);
      return connection.socket.close(NORMAL_CLOSURE);
    }
    await this.feedWire(connection, message);
  }

  private async feedWire({ name, socket }: WireConnection, message: PostgresMessage) {
    const pg = await this.boot(name);
    const output = await this.exchangeWire(name, pg, message);
    sendFrames(socket, output);
    if (leavesSessionIdle(message, output)) await this.checkpoint(name, pg);
  }

  private async exchangeWire(name: string, pg: PGlite, message: PostgresMessage): Promise<Uint8Array> {
    try {
      return await exchange(pg, message);
    } catch (err) {
      this.discardPostgres(name, err);
      throw err;
    }
  }

  private failWire({ name, socket }: WireConnection, err: unknown) {
    const message = errorMessage(err);
    console.error(`wire connection to ${name} failed: ${message}`);
    closeWithError(socket, { code: err instanceof WireProtocolError ? PROTOCOL_VIOLATION : INTERNAL_ERROR, message });
  }

  private async releaseWire(connection: WireConnection) {
    clearTimeout(connection.idleTimer);
    if (this.wire !== connection) return;
    this.wire = undefined;
    console.debug(`wire connection to ${connection.name} closed`);
    if (this.postgres) await this.resetSession(connection.name, this.postgres);
  }

  private async resetSession(name: string, booted: Promise<PGlite>) {
    try {
      await endSession(await booted);
    } catch (err) {
      this.discardPostgres(name, err);
    }
  }

  private dropWire(error: WireError) {
    const connection = this.wire;
    if (!connection) return;
    this.wire = undefined;
    clearTimeout(connection.idleTimer);
    closeWithError(connection.socket, error);
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
    this.dropWire({ code: INTERNAL_ERROR, message: POSTGRES_RESTARTED });
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
