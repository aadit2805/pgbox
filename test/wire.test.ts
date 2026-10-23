import { strict as assert } from "node:assert";
import { PGlite } from "@electric-sql/pglite";
import { endSession, exchange, leavesSessionIdle, MAX_MESSAGE_BYTES, MessageReader, readMessages, simpleQuery, syncMessage, WireProtocolError, type PostgresMessage } from "../src/wire.ts";

const PROTOCOL_VERSION_3 = 196608;
const SSL_REQUEST_CODE = 80877103;
const TYPE_BYTES = 1;
const INT32_BYTES = 4;
const SPLIT_AT = 3;
const PARAMETER_STATUS = "S";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const cString = (value: string) => [...encoder.encode(value), 0];

function untyped(code: number, body: number[]): Uint8Array {
  const bytes = new Uint8Array(2 * INT32_BYTES + body.length);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, bytes.length);
  view.setInt32(INT32_BYTES, code);
  bytes.set(body, 2 * INT32_BYTES);
  return bytes;
}

function typed(type: string, body: number[]): Uint8Array {
  const bytes = new Uint8Array(TYPE_BYTES + INT32_BYTES + body.length);
  bytes[0] = type.charCodeAt(0);
  new DataView(bytes.buffer).setInt32(TYPE_BYTES, INT32_BYTES + body.length);
  bytes.set(body, TYPE_BYTES + INT32_BYTES);
  return bytes;
}

const startup = () => untyped(PROTOCOL_VERSION_3, [...cString("user"), ...cString("postgres"), 0]);
const parse = (sql: string) => typed("P", [...cString(""), ...cString(sql), 0, 0]);
const bind = () => typed("B", [...cString(""), ...cString(""), 0, 0, 0, 0, 0, 0]);
const execute = () => typed("E", [...cString(""), 0, 0, 0, 0]);
const join = (...parts: Uint8Array[]) => new Uint8Array(parts.flatMap((part) => [...part]));
const frame = (bytes: Uint8Array) => bytes.slice().buffer;

function messageTypes(output: Uint8Array): string {
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  const types: string[] = [];
  for (let offset = 0; offset < output.length; offset += TYPE_BYTES + view.getInt32(offset + TYPE_BYTES)) types.push(String.fromCharCode(output[offset]));
  return types.filter((type) => type !== PARAMETER_STATUS).join("");
}

function postgresMessages(reader: MessageReader, bytes: Uint8Array): PostgresMessage[] {
  return readMessages(reader, frame(bytes)).filter((message): message is PostgresMessage => message.kind === "startup" || message.kind === "frontend");
}

async function run(pg: PGlite, reader: MessageReader, bytes: Uint8Array) {
  const outputs: Uint8Array[] = [];
  let idle = false;
  for (const message of postgresMessages(reader, bytes)) {
    const output = await exchange(pg, message);
    outputs.push(output);
    idle = leavesSessionIdle(message, output);
  }
  const output = join(...outputs);
  return { types: messageTypes(output), text: decoder.decode(output), idle };
}

const pg = await PGlite.create();
const reader = new MessageReader();

const sslAndStartup = join(untyped(SSL_REQUEST_CODE, []), startup());
assert.deepEqual(readMessages(reader, frame(sslAndStartup.subarray(0, SPLIT_AT))), []);
const [ssl, start] = readMessages(reader, frame(sslAndStartup.subarray(SPLIT_AT)));
assert.equal(ssl.kind, "encryption");
assert.equal(start.kind, "startup");
const started = await exchange(pg, start);
assert.ok(messageTypes(started).endsWith("Z"));

const query = simpleQuery("select 41 + 1 as answer");
assert.deepEqual(readMessages(reader, frame(query.subarray(0, SPLIT_AT))), []);
const split = await run(pg, reader, query.subarray(SPLIT_AT));
assert.equal(split.types, "TDCZ");
assert.ok(split.text.includes("42"));
assert.ok(split.idle);

const several = await run(pg, reader, join(simpleQuery("create table t (x int)"), simpleQuery("insert into t values (1)"), simpleQuery("select count(*) from t")));
assert.equal(several.types, "CZCZTDCZ");

const pipelinedError = await run(pg, reader, join(parse("select 1/0"), bind(), execute(), syncMessage()));
assert.equal(pipelinedError.types, "1EZ");
assert.ok(pipelinedError.text.includes("division by zero"));
assert.ok(pipelinedError.idle);

const executeError = await run(pg, reader, join(parse("select 1 / (x - 1) from t"), bind(), execute(), syncMessage()));
assert.equal(executeError.types, "12EZ");

const midBatch = await run(pg, reader, join(parse("select 1/0"), bind(), execute()));
assert.equal(midBatch.types, "1E");
assert.ok(!midBatch.idle);
assert.equal((await run(pg, reader, syncMessage())).types, "Z");

const copyIn = await run(pg, reader, simpleQuery("copy t from stdin"));
assert.equal(copyIn.types, "EZ");
assert.ok(copyIn.text.includes("COPY FROM STDIN is not supported"));
const extendedCopy = await run(pg, reader, join(parse("copy t from stdin"), bind(), execute(), syncMessage()));
assert.equal(extendedCopy.types, "12EZ");
const afterCopy = await run(pg, reader, simpleQuery("select count(*) from t"));
assert.equal(afterCopy.types, "TDCZ");

const inTransaction = await run(pg, reader, simpleQuery("begin; insert into t values (2)"));
assert.ok(!inTransaction.idle);
await run(pg, reader, simpleQuery("commit"));

await run(pg, reader, join(parse("insert into t values (3)"), bind(), execute()));
await run(pg, reader, simpleQuery("set statement_timeout = 1234"));
await endSession(pg);
assert.equal((await pg.query<{ c: number }>("select count(*)::int as c from t")).rows[0].c, 2);
assert.equal((await pg.query<{ statement_timeout: string }>("show statement_timeout")).rows[0].statement_timeout, "0");

const oversized = new Uint8Array(TYPE_BYTES + INT32_BYTES);
oversized[0] = "Q".charCodeAt(0);
new DataView(oversized.buffer).setInt32(TYPE_BYTES, MAX_MESSAGE_BYTES);
assert.throws(() => readMessages(reader, frame(oversized)), WireProtocolError);
assert.throws(() => readMessages(new MessageReader(), "text frame"), WireProtocolError);

await pg.close();
console.log("wire framing and output rewriting: ok");
