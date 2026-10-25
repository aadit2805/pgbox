import { accessDenial, copyDenial, type Access } from "./access";
import { isRefused, isSessionBusy, openDatabase, type Env, type Refused, type SessionBusy } from "./database";
import { DATABASE_NAME_RULE, isDatabaseName } from "./database-name";
import { ACCEPTED, BAD_REQUEST, METHOD_NOT_ALLOWED, OK } from "./http-status";
import { errorMessage, jsonResponse, toJson } from "./serialize";

const SERVER_INFO = { name: "pgbox", version: "0.1.0" };
const PROTOCOL_VERSION = "2025-06-18";
const JSONRPC_VERSION = "2.0";
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const MAX_RESULT_CHARS = 100_000;
const COPY_TOOL = "copy_database";

const LIST_TABLES_SQL = `select table_schema as schema, table_name as table,
  string_agg(column_name || ' ' || data_type, ', ' order by ordinal_position) as columns
  from information_schema.columns
  where table_schema not in ('pg_catalog', 'information_schema')
  group by table_schema, table_name order by table_schema, table_name`;

const DATABASE_PARAM = {
  type: "string",
  description: "Name of the database. Any new name creates an empty Postgres database that persists until deleted; reuse the same name to get the same data back later.",
};

const TOOLS = [
  {
    name: "run_sql",
    description:
      "Run SQL against a persistent Postgres 18 database. Accepts several statements separated by semicolons and returns the rows of the last one. Use it to store and query structured data across sessions.",
    inputSchema: { type: "object", properties: { database: DATABASE_PARAM, sql: { type: "string", description: "One or more SQL statements." } }, required: ["database", "sql"] },
  },
  {
    name: "list_tables",
    description: "List the tables and views in a database with their columns and types. Call this first when coming back to a database to see what is already stored.",
    inputSchema: { type: "object", properties: { database: DATABASE_PARAM }, required: ["database"] },
  },
  {
    name: "delete_database",
    description: "Permanently delete a database and all of its data.",
    inputSchema: { type: "object", properties: { database: DATABASE_PARAM }, required: ["database"] },
  },
  {
    name: COPY_TOOL,
    description:
      "Copy a database with all of its data to a new name, for example to try a migration on the copy first. The copy is independent: later writes to either one don't affect the other. Fails if the new name is already in use. Needs the admin token.",
    inputSchema: {
      type: "object",
      properties: { database: DATABASE_PARAM, to: { type: "string", description: "Name for the copy. It must not have been used yet." } },
      required: ["database", "to"],
    },
  },
];

type RequestId = string | number;
type Params = Record<string, unknown>;
type Database = ReturnType<typeof openDatabase>;
type ToolHandler = (db: Database, database: string, args: Params) => Promise<unknown>;

interface RpcRequest {
  id?: RequestId;
  method: string;
  params: Params;
}

class RpcError extends Error {
  code: number;
  status: number;
  constructor(code: number, message: string, status = OK) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const isRecord = (value: unknown): value is Params => typeof value === "object" && value !== null && !Array.isArray(value);

const isRequestId = (value: unknown): value is RequestId => typeof value === "string" || typeof value === "number";

const reply = (id: RequestId | null, body: { result: unknown } | { error: { code: number; message: string } }, status?: number) =>
  jsonResponse({ jsonrpc: JSONRPC_VERSION, id, ...body }, { status });

const textResult = (text: string, isError = false) => ({ content: [{ type: "text", text: text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated]` : text }], isError });

const invalidRequest = (message: string) => new RpcError(INVALID_REQUEST, message, BAD_REQUEST);

const isClientResponse = (body: Params) => body.method === undefined && ("result" in body || "error" in body);

function stringParam(params: Params, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value) throw new RpcError(INVALID_PARAMS, `${key} must be a non-empty string`);
  return value;
}

function databaseParam(params: Params, key: string): string {
  const name = stringParam(params, key);
  if (!isDatabaseName(name)) throw new RpcError(INVALID_PARAMS, `${key} must be ${DATABASE_NAME_RULE}`);
  return name;
}

const refusalMessage = (outcome: SessionBusy | Refused) => (isSessionBusy(outcome) ? outcome.busy : outcome.message);

async function queryRows(db: Database, database: string, sql: string) {
  const outcome = await db.query(database, sql);
  if (isSessionBusy(outcome) || isRefused(outcome)) throw new Error(refusalMessage(outcome));
  return outcome.rows;
}

async function copyDatabase(db: Database, database: string, to: string) {
  const outcome = await db.copyTo(database, to);
  if (isSessionBusy(outcome) || isRefused(outcome)) throw new Error(refusalMessage(outcome));
  return outcome;
}

async function deleteDatabase(db: Database, database: string) {
  const outcome = await db.destroy(database);
  if (isRefused(outcome)) throw new Error(outcome.message);
  return outcome;
}

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  run_sql: (db, database, args) => queryRows(db, database, stringParam(args, "sql")),
  list_tables: (db, database) => queryRows(db, database, LIST_TABLES_SQL),
  delete_database: deleteDatabase,
  [COPY_TOOL]: (db, database, args) => copyDatabase(db, database, databaseParam(args, "to")),
};

async function callTool(env: Env, access: Access, params: Params) {
  const handler = typeof params.name === "string" ? TOOL_HANDLERS[params.name] : undefined;
  if (!handler) throw new RpcError(INVALID_PARAMS, `unknown tool ${String(params.name)}`);
  const args = isRecord(params.arguments) ? params.arguments : {};
  const database = databaseParam(args, "database");
  const denial = params.name === COPY_TOOL ? copyDenial(access) : accessDenial(access, database);
  if (denial !== undefined) return textResult(denial, true);
  try {
    return textResult(toJson(await handler(openDatabase(env, database), database, args)));
  } catch (err) {
    const message = errorMessage(err);
    console.error(`mcp ${String(params.name)} failed for ${database}: ${message}`);
    return textResult(message, true);
  }
}

async function dispatch(env: Env, access: Access, { method, params }: RpcRequest): Promise<unknown> {
  if (method === "initialize") return { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO };
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: TOOLS };
  if (method === "tools/call") return callTool(env, access, params);
  throw new RpcError(METHOD_NOT_FOUND, `method ${method} not found`);
}

async function readBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch (err) {
    if (err instanceof SyntaxError) throw new RpcError(PARSE_ERROR, "body is not valid JSON", BAD_REQUEST);
    throw err;
  }
}

function parseRequest(body: Params): RpcRequest {
  if (body.jsonrpc !== JSONRPC_VERSION || typeof body.method !== "string") throw invalidRequest("expected a JSON-RPC 2.0 request");
  if ("id" in body && !isRequestId(body.id)) throw invalidRequest("id must be a string or number");
  return { id: isRequestId(body.id) ? body.id : undefined, method: body.method, params: isRecord(body.params) ? body.params : {} };
}

async function handleMessage(env: Env, access: Access, body: unknown, setId: (id: RequestId) => void): Promise<Response> {
  if (!isRecord(body)) throw invalidRequest("expected a single JSON-RPC message; batches are not supported");
  if (isRequestId(body.id)) setId(body.id);
  if (isClientResponse(body)) return new Response(null, { status: ACCEPTED });
  const rpc = parseRequest(body);
  if (rpc.id === undefined) return new Response(null, { status: ACCEPTED });
  return reply(rpc.id, { result: await dispatch(env, access, rpc) });
}

export async function handleMcp(request: Request, env: Env, access: Access): Promise<Response> {
  if (request.method !== "POST") return new Response("MCP here only accepts POST", { status: METHOD_NOT_ALLOWED, headers: { allow: "POST" } });
  let id: RequestId | null = null;
  try {
    return await handleMessage(env, access, await readBody(request), (found) => (id = found));
  } catch (err) {
    if (err instanceof RpcError) return reply(id, { error: { code: err.code, message: err.message } }, err.status);
    const message = errorMessage(err);
    console.error(`mcp request failed: ${message}`);
    return reply(id, { error: { code: INTERNAL_ERROR, message } });
  }
}
