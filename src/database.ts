import { DurableObject } from "cloudflare:workers";
import { messages, Mutex, type PGlite } from "@electric-sql/pglite";
import { copyStorage } from "./copy-storage";
import { checkpointIfWalFull, checkpointNow, createPostgres, wasmMemoryMegabytes } from "./postgres";
import { SWITCHING_PROTOCOLS } from "./http-status";
import { MB } from "./postgres-settings";
import { errorMessage } from "./serialize";
import { StorageFS, type SqlValue, type StoredNode, type StoredPage } from "./storage-fs";
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
export const TARGET_EXISTS = "target_exists";
export const DATABASE_NOT_FOUND = "database_not_found";
export const COPY_IN_PROGRESS = "copy_in_progress";

const toMegabytes = (bytes: number) => Number((bytes / MB).toFixed(STORAGE_MB_DIGITS));

const wireBusy = (name: string): SessionBusy => ({ busy: `${name} has an open wire connection, so HTTP and MCP queries are refused until it disconnects` });

const receivingCopy = (name: string): Refused => ({
  refused: COPY_IN_PROGRESS,
  message: `${name} is receiving a copy, or a copy into it was interrupted; wait for it, or delete ${name} to clear it`,
});

const toStorageValue = (value: SqlValue): SqlStorageValue => (value instanceof Uint8Array ? value.slice().buffer : value);

export interface Env {
  DB: DurableObjectNamespace<PostgresDatabase>;
  ASSETS: Fetcher;
  PGBOX_TOKEN?: string;
}

export const openDatabase = (env: Env, name: string) => env.DB.get(env.DB.idFromName(name));

type DatabaseStub = ReturnType<typeof openDatabase>;

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

export interface Refused {
  refused: typeof TARGET_EXISTS | typeof DATABASE_NOT_FOUND | typeof COPY_IN_PROGRESS;
  message: string;
}

export const isRefused = (outcome: object): outcome is Refused => "refused" in outcome;

interface CopyResult {
  copied: string;
  to: string;
  pages: number;
  copiedMB: number;
}

interface CopyRequest {
  name: string;
  target: string;
  source: StorageFS;
}

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

  query(name: string, sql: string): Promise<QueryResult | SessionBusy | Refused> {
    return this.session.runExclusive(async () => {
      if (this.wire) return wireBusy(name);
      if (this.isReceivingCopy()) return receivingCopy(name);
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

  copyTo(name: string, target: string): Promise<CopyResult | SessionBusy | Refused> {
    return this.session.runExclusive(async () => {
      if (this.wire) return wireBusy(name);
      const source = this.openStorage();
      if (source.receivingCopy() !== undefined) return receivingCopy(name);
      if (!source.isInitialized()) return { refused: DATABASE_NOT_FOUND, message: `${name} has never been used, so there is nothing to copy` };
      if (target === name) return { refused: TARGET_EXISTS, message: `${name} can't be copied onto itself` };
      if (this.postgres) await this.checkpointForCopy(name, this.postgres);
      return this.sendCopy({ name, target, source });
    });
  }

  startCopy(name: string, copyId: string): Promise<Refused | undefined> {
    return this.session.runExclusive(async () => {
      const fs = this.openStorage();
      if (this.wire || this.postgres || fs.isInitialized()) return { refused: TARGET_EXISTS, message: `${name} already exists; delete it first or copy to a new name` };
      if (fs.receivingCopy() !== undefined) return receivingCopy(name);
      fs.startReceivingCopy(copyId);
      return undefined;
    });
  }

  receiveNodes(copyId: string, nodes: StoredNode[]) {
    this.receivingStorage(copyId).putNodes(nodes);
  }

  receivePages(copyId: string, pages: StoredPage[]) {
    this.receivingStorage(copyId).putPages(pages);
  }

  finishCopy(copyId: string) {
    this.receivingStorage(copyId).finishReceivingCopy();
  }

  abortCopy(name: string, copyId: string): Promise<void> {
    return this.session.runExclusive(async () => {
      if (this.openStorage().receivingCopy() !== copyId) return;
      await this.ctx.storage.deleteAll();
      console.warn(`incomplete copy into ${name} wiped`);
    });
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

  private async sendCopy({ name, target, source }: CopyRequest): Promise<CopyResult | Refused> {
    const destination = openDatabase(this.env, target);
    const copyId = crypto.randomUUID();
    const refused = await destination.startCopy(target, copyId);
    if (refused) return refused;
    try {
      const copied = await copyStorage(source, {
        putNodes: (nodes) => destination.receiveNodes(copyId, nodes),
        putPages: (pages) => destination.receivePages(copyId, pages),
      });
      await destination.finishCopy(copyId);
      console.debug(`database ${name} copied to ${target}: ${copied.pages} pages`);
      return { copied: name, to: target, pages: copied.pages, copiedMB: toMegabytes(copied.bytes) };
    } catch (err) {
      await this.abandonCopy({ destination, target, copyId });
      throw err;
    }
  }

  private async abandonCopy({ destination, target, copyId }: { destination: DatabaseStub; target: string; copyId: string }) {
    try {
      await destination.abortCopy(target, copyId);
    } catch (err) {
      console.error(`incomplete copy into ${target} could not be wiped:`, err);
    }
  }

  private receivingStorage(copyId: string): StorageFS {
    const fs = this.openStorage();
    if (fs.receivingCopy() !== copyId) throw new Error("the copy was cancelled because its target was deleted");
    return fs;
  }

  private isReceivingCopy(): boolean {
    return !this.postgres && this.openStorage().receivingCopy() !== undefined;
  }

  private async checkpointForCopy(name: string, booted: Promise<PGlite>) {
    try {
      await checkpointNow(await booted);
    } catch (err) {
      if (!(err instanceof messages.DatabaseError)) this.discardPostgres(name, err);
      throw err;
    }
  }

  private async execHttp(name: string, pg: PGlite, sql: string) {
    try {
      const results = await pg.exec(sql);
      return { results, leftTransactionOpen: await rollbackIfOpen(pg) };
    } catch (err) {
      if (!(err instanceof messages.DatabaseError)) this.discardPostgres(name, err);
      else await this.rollbackAfterFailure(name, pg);
      throw err;
    }
  }

  private async rollbackAfterFailure(name: string, pg: PGlite) {
    try {
      await rollbackIfOpen(pg);
    } catch (rollbackErr) {
      this.discardPostgres(name, rollbackErr);
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
    return toMegabytes(this.ctx.storage.sql.databaseSize);
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

  private openStorage(): StorageFS {
    const storage = this.ctx.storage.sql;
    return new StorageFS((query, ...bindings) => storage.exec(query, ...bindings.map(toStorageValue)).toArray());
  }

  private async start(name: string): Promise<PGlite> {
    const fs = this.openStorage();
    if (fs.receivingCopy() !== undefined) throw new Error(receivingCopy(name).message);
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
