import type { PGlite } from "@electric-sql/pglite";
import { MB } from "./postgres-settings.ts";

const TYPE_BYTES = 1;
const INT32_BYTES = 4;
const TYPED_HEADER_BYTES = TYPE_BYTES + INT32_BYTES;
const UNTYPED_HEADER_BYTES = 2 * INT32_BYTES;
const MAX_FRAME_BYTES = MB;
const SSL_REQUEST_CODE = 80877103;
const GSSENC_REQUEST_CODE = 80877104;
const CANCEL_REQUEST_CODE = 80877102;
const STRING_TERMINATOR = 0;
const WIRE_ERROR_CLOSURE = 1011;
const FATAL = "FATAL";
export const ROLLBACK_SQL = "rollback";
const DISCARD_SESSION_SQL = "discard all";
const COPY_IN_UNSUPPORTED = "COPY FROM STDIN is not supported by pgbox; use INSERT instead";

const TERMINATE = charCode("X");
const QUERY = charCode("Q");
const SYNC = charCode("S");
const EXECUTE = charCode("E");
const COPY_DONE = charCode("c");
const COPY_FAIL = charCode("f");
const COPY_IN_RESPONSE = charCode("G");
const READY_FOR_QUERY = charCode("Z");
const ERROR_RESPONSE = charCode("E");
const SEVERITY_FIELD = charCode("S");
const NONLOCALIZED_SEVERITY_FIELD = charCode("V");
const CODE_FIELD = charCode("C");
const MESSAGE_FIELD = charCode("M");
const IDLE = charCode("I");
const BATCH_ENDS = new Set([QUERY, SYNC, COPY_DONE, COPY_FAIL]);
const MAY_START_COPY = new Set([QUERY, EXECUTE]);

export const MAX_MESSAGE_MB = 4;
export const MAX_MESSAGE_BYTES = MAX_MESSAGE_MB * MB;
export const MAX_QUEUED_MB = 8;
export const MAX_QUEUED_BYTES = MAX_QUEUED_MB * MB;
export const NO_ENCRYPTION = new Uint8Array([charCode("N")]);
export const TOO_MANY_CONNECTIONS = "53300";
export const CANNOT_CONNECT_NOW = "57P03";
export const PROTOCOL_VIOLATION = "08P01";
export const ADMIN_SHUTDOWN = "57P01";
export const IDLE_SESSION_TIMEOUT = "57P05";
export const INTERNAL_ERROR = "XX000";

const encoder = new TextEncoder();
const COPY_FAIL_MESSAGE = frontendMessage(COPY_FAIL, cString(COPY_IN_UNSUPPORTED));

export type PostgresMessage = { kind: "startup"; bytes: Uint8Array } | { kind: "frontend"; type: number; bytes: Uint8Array };

export type WireMessage = { kind: "encryption" } | { kind: "cancel" } | { kind: "terminate" } | PostgresMessage;

export type ProtocolBackend = Pick<PGlite, "execProtocolRaw" | "exec" | "isInTransaction">;

export class WireProtocolError extends Error {}

export interface WireError {
  code: string;
  message: string;
}

function charCode(char: string): number {
  return char.charCodeAt(0);
}

function cString(value: string): number[] {
  return [...encoder.encode(value), STRING_TERMINATOR];
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

function frontendMessage(type: number, body: number[]): Uint8Array {
  const message = new Uint8Array(TYPED_HEADER_BYTES + body.length);
  message[0] = type;
  view(message).setInt32(TYPE_BYTES, INT32_BYTES + body.length);
  message.set(body, TYPED_HEADER_BYTES);
  return message;
}

export class MessageReader {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private expected?: number;
  private started = false;

  push(chunk: Uint8Array) {
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  next(): WireMessage | undefined {
    this.expected ??= this.readLength();
    if (this.expected === undefined || this.size < this.expected) return undefined;
    const buffered = this.flatten();
    const bytes = buffered.subarray(0, this.expected);
    this.size -= this.expected;
    this.chunks = this.size ? [buffered.subarray(this.expected)] : [];
    this.expected = undefined;
    return this.started ? typedMessage(bytes) : this.untypedMessage(bytes);
  }

  private readLength(): number | undefined {
    const headerBytes = this.started ? TYPED_HEADER_BYTES : UNTYPED_HEADER_BYTES;
    if (this.size < headerBytes) return undefined;
    const header = view(this.flatten());
    const length = this.started ? TYPE_BYTES + header.getInt32(TYPE_BYTES) : header.getInt32(0);
    if (length < headerBytes) throw new WireProtocolError(`invalid message length ${length}`);
    if (length > MAX_MESSAGE_BYTES) throw new WireProtocolError(`messages are limited to ${MAX_MESSAGE_MB} MB`);
    return length;
  }

  private flatten(): Uint8Array {
    if (this.chunks.length !== 1) this.chunks = [concat(this.chunks)];
    return this.chunks[0];
  }

  private untypedMessage(bytes: Uint8Array): WireMessage {
    const code = view(bytes).getInt32(INT32_BYTES);
    if (code === SSL_REQUEST_CODE || code === GSSENC_REQUEST_CODE) return { kind: "encryption" };
    if (code === CANCEL_REQUEST_CODE) return { kind: "cancel" };
    this.started = true;
    return { kind: "startup", bytes };
  }
}

function typedMessage(bytes: Uint8Array): WireMessage {
  const type = bytes[0];
  return type === TERMINATE ? { kind: "terminate" } : { kind: "frontend", type, bytes };
}

export function readMessages(reader: MessageReader, frame: ArrayBuffer | string): WireMessage[] {
  if (typeof frame === "string") throw new WireProtocolError("send Postgres protocol bytes as binary WebSocket frames");
  reader.push(new Uint8Array(frame));
  const messages: WireMessage[] = [];
  for (let message = reader.next(); message; message = reader.next()) messages.push(message);
  return messages;
}

function messageOffsets(output: Uint8Array): number[] {
  const messages = view(output);
  const offsets: number[] = [];
  for (let offset = 0; offset + TYPED_HEADER_BYTES <= output.length; offset += TYPE_BYTES + messages.getInt32(offset + TYPE_BYTES)) offsets.push(offset);
  return offsets;
}

const endsBatch = (message: PostgresMessage) => message.kind === "startup" || BATCH_ENDS.has(message.type);

// PGlite exits the whole backend when COPY FROM STDIN waits for data in a later call, and Postgres ignores CopyFail outside COPY.
const backendInput = (message: PostgresMessage) => (message.kind === "frontend" && MAY_START_COPY.has(message.type) ? concat([message.bytes, COPY_FAIL_MESSAGE]) : message.bytes);

// PGlite sends ReadyForQuery after an error even mid-batch, which real Postgres only sends after Sync.
function clientOutput(message: PostgresMessage, output: Uint8Array): Uint8Array {
  const dropped = endsBatch(message) ? [COPY_IN_RESPONSE] : [COPY_IN_RESPONSE, READY_FOR_QUERY];
  const offsets = messageOffsets(output);
  if (!offsets.some((offset) => dropped.includes(output[offset]))) return output;
  return concat(offsets.flatMap((offset, index) => (dropped.includes(output[offset]) ? [] : [output.subarray(offset, offsets[index + 1] ?? output.length)])));
}

export async function exchange(backend: ProtocolBackend, message: PostgresMessage): Promise<Uint8Array> {
  return clientOutput(message, await backend.execProtocolRaw(backendInput(message)));
}

export function leavesSessionIdle(message: PostgresMessage, output: Uint8Array): boolean {
  const last = messageOffsets(output).at(-1);
  return endsBatch(message) && last !== undefined && output[last] === READY_FOR_QUERY && output[last + TYPED_HEADER_BYTES] === IDLE;
}

export const simpleQuery = (sql: string) => frontendMessage(QUERY, cString(sql));

export const syncMessage = () => frontendMessage(SYNC, []);

export async function endSession(backend: ProtocolBackend) {
  await backend.execProtocolRaw(simpleQuery(ROLLBACK_SQL));
  await backend.execProtocolRaw(syncMessage());
  if (backend.isInTransaction()) await backend.exec(ROLLBACK_SQL);
  await backend.exec(DISCARD_SESSION_SQL);
}

export function errorResponse({ code, message }: WireError): Uint8Array {
  const fields = [SEVERITY_FIELD, ...cString(FATAL), NONLOCALIZED_SEVERITY_FIELD, ...cString(FATAL), CODE_FIELD, ...cString(code), MESSAGE_FIELD, ...cString(message), STRING_TERMINATOR];
  const response = new Uint8Array(TYPED_HEADER_BYTES + fields.length);
  response[0] = ERROR_RESPONSE;
  view(response).setInt32(TYPE_BYTES, INT32_BYTES + fields.length);
  response.set(fields, TYPED_HEADER_BYTES);
  return response;
}

export const isOpen = (socket: WebSocket) => socket.readyState === WebSocket.READY_STATE_OPEN;

export function sendFrames(socket: WebSocket, bytes: Uint8Array) {
  if (!isOpen(socket)) return;
  for (let offset = 0; offset < bytes.length; offset += MAX_FRAME_BYTES) socket.send(bytes.subarray(offset, offset + MAX_FRAME_BYTES));
}

export function closeWithError(socket: WebSocket, error: WireError) {
  if (!isOpen(socket)) return;
  sendFrames(socket, errorResponse(error));
  socket.close(WIRE_ERROR_CLOSURE);
}
