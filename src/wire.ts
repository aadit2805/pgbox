import { MB } from "./postgres-settings";

const TYPE_BYTES = 1;
const INT32_BYTES = 4;
const TYPED_HEADER_BYTES = TYPE_BYTES + INT32_BYTES;
const UNTYPED_HEADER_BYTES = 2 * INT32_BYTES;
const MAX_MESSAGE_MB = 16;
const MAX_MESSAGE_BYTES = MAX_MESSAGE_MB * MB;
const SSL_REQUEST_CODE = 80877103;
const GSSENC_REQUEST_CODE = 80877104;
const CANCEL_REQUEST_CODE = 80877102;
const STRING_TERMINATOR = 0;
const MAX_FRAME_BYTES = MB;
const WIRE_ERROR_CLOSURE = 1011;

const charCode = (char: string) => char.charCodeAt(0);

const TERMINATE = charCode("X");
const QUERY = charCode("Q");
const SYNC = charCode("S");
const COPY_DONE = charCode("c");
const COPY_FAIL = charCode("f");
const EXECUTE = charCode("E");
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
const COPY_IN_UNSUPPORTED = "COPY FROM STDIN is not supported by pgbox; use INSERT instead";

const FATAL = "FATAL";
export const NO_ENCRYPTION = new Uint8Array([charCode("N")]);
export const TOO_MANY_CONNECTIONS = "53300";
export const PROTOCOL_VIOLATION = "08P01";
export const ADMIN_SHUTDOWN = "57P01";
export const INTERNAL_ERROR = "XX000";

const encoder = new TextEncoder();

export type WireMessage =
  | { kind: "encryption" }
  | { kind: "cancel" }
  | { kind: "terminate" }
  | PostgresMessage;

export type PostgresMessage = { kind: "startup"; bytes: Uint8Array } | { kind: "frontend"; type: number; bytes: Uint8Array };

export class WireProtocolError extends Error {}

interface WireError {
  code: string;
  message: string;
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function concat(chunks: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
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
    const bytes = buffered.slice(0, this.expected);
    this.chunks = [buffered.subarray(this.expected)];
    this.size -= this.expected;
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

function messageOffsets(output: Uint8Array): number[] {
  const messages = view(output);
  const offsets: number[] = [];
  for (let offset = 0; offset + TYPED_HEADER_BYTES <= output.length; offset += TYPE_BYTES + messages.getInt32(offset + TYPE_BYTES)) offsets.push(offset);
  return offsets;
}

function lastReadyStatus(output: Uint8Array): number | undefined {
  const last = messageOffsets(output).at(-1);
  return last !== undefined && output[last] === READY_FOR_QUERY ? output[last + TYPED_HEADER_BYTES] : undefined;
}

// PGlite exits the whole backend when COPY FROM STDIN waits for data in a later call, and Postgres ignores CopyFail outside COPY.
export const backendInput = (message: PostgresMessage) =>
  message.kind === "frontend" && MAY_START_COPY.has(message.type) ? concat([message.bytes, frontendMessage(COPY_FAIL, cString(COPY_IN_UNSUPPORTED))]) : message.bytes;

export function clientOutput(output: Uint8Array): Uint8Array {
  if (!output.includes(COPY_IN_RESPONSE)) return output;
  const offsets = messageOffsets(output);
  const kept = offsets.flatMap((offset, index) => (output[offset] === COPY_IN_RESPONSE ? [] : [output.subarray(offset, offsets[index + 1] ?? output.length)]));
  return concat(kept);
}

const endsBatch = (message: PostgresMessage) => message.kind === "startup" || BATCH_ENDS.has(message.type);

export const leavesSessionIdle = (message: PostgresMessage, output: Uint8Array) => endsBatch(message) && lastReadyStatus(output) === IDLE;

export function readMessages(reader: MessageReader, frame: ArrayBuffer | string): WireMessage[] {
  if (typeof frame === "string") throw new WireProtocolError("send Postgres protocol bytes as binary WebSocket frames");
  reader.push(new Uint8Array(frame));
  const messages: WireMessage[] = [];
  for (let message = reader.next(); message; message = reader.next()) messages.push(message);
  return messages;
}

const isOpen = (socket: WebSocket) => socket.readyState === WebSocket.READY_STATE_OPEN;

export function sendFrames(socket: WebSocket, bytes: Uint8Array) {
  if (!isOpen(socket)) return;
  for (let offset = 0; offset < bytes.length; offset += MAX_FRAME_BYTES) socket.send(bytes.slice(offset, offset + MAX_FRAME_BYTES));
}

export function closeWithError(socket: WebSocket, error: WireError) {
  if (!isOpen(socket)) return;
  sendFrames(socket, errorResponse(error));
  socket.close(WIRE_ERROR_CLOSURE);
}

const cString = (value: string) => [...encoder.encode(value), STRING_TERMINATOR];

function errorResponse({ code, message }: WireError): Uint8Array {
  const fields = [SEVERITY_FIELD, ...cString(FATAL), NONLOCALIZED_SEVERITY_FIELD, ...cString(FATAL), CODE_FIELD, ...cString(code), MESSAGE_FIELD, ...cString(message), STRING_TERMINATOR];
  const response = new Uint8Array(TYPED_HEADER_BYTES + fields.length);
  response[0] = ERROR_RESPONSE;
  view(response).setInt32(TYPE_BYTES, INT32_BYTES + fields.length);
  response.set(fields, TYPED_HEADER_BYTES);
  return response;
}

function frontendMessage(type: number, body: number[]): Uint8Array {
  const message = new Uint8Array(TYPED_HEADER_BYTES + body.length);
  message[0] = type;
  view(message).setInt32(TYPE_BYTES, INT32_BYTES + body.length);
  message.set(body, TYPED_HEADER_BYTES);
  return message;
}

export const simpleQuery = (sql: string) => frontendMessage(QUERY, cString(sql));

export const syncMessage = () => frontendMessage(SYNC, []);
