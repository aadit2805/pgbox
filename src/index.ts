import { authorizeDatabase, copyDenial, forbidden, requestAccess, unauthorized, type Access } from "./access";
import { COPY_IN_PROGRESS, DATABASE_NAME_HEADER, DATABASE_NOT_FOUND, isRefused, isSessionBusy, openDatabase, TARGET_EXISTS, type Env, type Refused } from "./database";
import { DATABASE_NAME_RULE, isDatabaseName, MCP_NAME } from "./database-name";
import { BAD_REQUEST, CONFLICT, INTERNAL_SERVER_ERROR, NOT_FOUND, UPGRADE_REQUIRED } from "./http-status";
import { handleMcp } from "./mcp";
import { mintScopedToken, nowSeconds, type TokenClaims } from "./scoped-token";
import { errorMessage, jsonResponse } from "./serialize";

export { PostgresDatabase } from "./database";

const MCP_PATH = `/${MCP_NAME}`;
const TOKEN_SEGMENT = "token";
const WIRE_SEGMENT = "wire";
const COPY_SEGMENT = "copy";
const ACTIONS = new Set([TOKEN_SEGMENT, WIRE_SEGMENT, COPY_SEGMENT]);
const TO_PARAM = "to";
const WEBSOCKET = "websocket";
const WIRE_FAILED = "wire_failed";
const WIRE_CONNECTION_OPEN = "wire_connection_open";
const TTL_PARAM = "ttl";
const TTL_NEVER = "never";
const TTL_PATTERN = /^[1-9]\d*$/;
const SECONDS_PER_DAY = 86_400;
const DEFAULT_TOKEN_TTL_DAYS = 30;
const MAX_TOKEN_TTL_DAYS = 365;
const DEFAULT_TOKEN_TTL_SECONDS = DEFAULT_TOKEN_TTL_DAYS * SECONDS_PER_DAY;
const MAX_TOKEN_TTL_SECONDS = MAX_TOKEN_TTL_DAYS * SECONDS_PER_DAY;
const USAGE = `POST /<database-name> with SQL as the body, DELETE /<database-name>, POST /<database-name>/${TOKEN_SEGMENT}[?${TTL_PARAM}=<seconds>|${TTL_NEVER}] for a token scoped to it, POST /<database-name>/${COPY_SEGMENT}?${TO_PARAM}=<new-name> to copy it, a Postgres connection over a WebSocket at GET /<database-name>/${WIRE_SEGMENT}, or MCP at ${MCP_PATH}. Names are ${DATABASE_NAME_RULE}.`;
const INVALID_TTL = `${TTL_PARAM} must be whole seconds from 1 to ${MAX_TOKEN_TTL_SECONDS}, or ${TTL_NEVER}`;
const WIRE_USAGE = `/<database-name>/${WIRE_SEGMENT} only accepts a GET WebSocket upgrade carrying Postgres protocol bytes; run scripts/proxy.mjs to connect psql or an ORM.`;
const SCOPED_CANNOT_MINT = "scoped tokens cannot mint tokens";
const INVALID_COPY_TARGET = `${TO_PARAM} must name the copy, ${DATABASE_NAME_RULE}`;
const REFUSAL_STATUS: Record<Refused["refused"], number> = { [TARGET_EXISTS]: CONFLICT, [COPY_IN_PROGRESS]: CONFLICT, [DATABASE_NOT_FOUND]: NOT_FOUND };

interface Route {
  name: string;
  action?: string;
}

const usage = () => new Response(USAGE, { status: BAD_REQUEST });

function decodeName(segment: string): string | undefined {
  try {
    const decoded = decodeURIComponent(segment);
    return isDatabaseName(decoded) ? decoded : undefined;
  } catch (err) {
    if (err instanceof URIError) return undefined;
    throw err;
  }
}

function parseRoute(url: URL): Route | undefined {
  const [, segment, action, ...rest] = url.pathname.split("/");
  if (!segment || rest.length || (action !== undefined && !ACTIONS.has(action))) return undefined;
  const name = decodeName(segment);
  return name === undefined ? undefined : { name, action };
}

async function withAccess(request: Request, env: Env, handle: (access: Access) => Response | Promise<Response>): Promise<Response> {
  const access = await requestAccess(request, env);
  return access ? handle(access) : unauthorized();
}

function ttlSeconds(ttl: string | null): number | undefined {
  if (ttl === null) return DEFAULT_TOKEN_TTL_SECONDS;
  return TTL_PATTERN.test(ttl) && Number(ttl) <= MAX_TOKEN_TTL_SECONDS ? Number(ttl) : undefined;
}

function expiryClaim(ttl: string | null): Pick<TokenClaims, "exp"> | undefined {
  if (ttl === TTL_NEVER) return {};
  const seconds = ttlSeconds(ttl);
  return seconds === undefined ? undefined : { exp: nowSeconds() + seconds };
}

async function mintToken(request: Request, secret: string, name: string): Promise<Response> {
  if (request.method !== "POST") return usage();
  const expiry = expiryClaim(new URL(request.url).searchParams.get(TTL_PARAM));
  if (!expiry) return new Response(INVALID_TTL, { status: BAD_REQUEST });
  const token = await mintScopedToken(secret, { db: name, ...expiry });
  return jsonResponse({ token, database: name, expiresAt: expiry.exp ?? null });
}

function mintRoute(request: Request, access: Access, name: string): Response | Promise<Response> {
  return access.kind === "admin" ? mintToken(request, access.secret, name) : forbidden(SCOPED_CANNOT_MINT);
}

function failure(name: string, error: string, err: unknown): Response {
  const message = errorMessage(err);
  console.error(`${error} for ${name}: ${message}`);
  return jsonResponse({ error, message }, { status: INTERNAL_SERVER_ERROR });
}

function outcomeResponse(result: object): Response {
  if (isSessionBusy(result)) return jsonResponse({ error: WIRE_CONNECTION_OPEN, message: result.busy }, { status: CONFLICT });
  if (isRefused(result)) return jsonResponse({ error: result.refused, message: result.message }, { status: REFUSAL_STATUS[result.refused] });
  return jsonResponse(result);
}

async function respond(name: string, error: string, run: () => Promise<object>): Promise<Response> {
  try {
    return outcomeResponse(await run());
  } catch (err) {
    return failure(name, error, err);
  }
}

async function runDatabase(request: Request, env: Env, name: string): Promise<Response> {
  const denied = await authorizeDatabase(request, env, name);
  if (denied) return denied;
  const database = openDatabase(env, name);
  if (request.method === "DELETE") return respond(name, "delete_failed", () => database.destroy(name));
  if (request.method !== "POST") return usage();
  return respond(name, "query_failed", async () => database.query(name, await request.text()));
}

function copyRoute(request: Request, env: Env, access: Access, name: string): Response | Promise<Response> {
  const denial = copyDenial(access);
  if (denial !== undefined) return forbidden(denial);
  if (request.method !== "POST") return usage();
  const target = new URL(request.url).searchParams.get(TO_PARAM);
  if (target === null || !isDatabaseName(target)) return new Response(INVALID_COPY_TARGET, { status: BAD_REQUEST });
  return respond(name, "copy_failed", () => openDatabase(env, name).copyTo(name, target));
}

const isWebSocketUpgrade = (request: Request) => request.method === "GET" && request.headers.get("upgrade")?.toLowerCase() === WEBSOCKET;

async function connectWire(request: Request, env: Env, name: string): Promise<Response> {
  const denied = await authorizeDatabase(request, env, name);
  if (denied) return denied;
  if (!isWebSocketUpgrade(request)) return new Response(WIRE_USAGE, { status: UPGRADE_REQUIRED, headers: { upgrade: WEBSOCKET } });
  const headers = new Headers(request.headers);
  headers.set(DATABASE_NAME_HEADER, encodeURIComponent(name));
  try {
    return await openDatabase(env, name).fetch(request.url, { headers });
  } catch (err) {
    return failure(name, WIRE_FAILED, err);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === MCP_PATH) return withAccess(request, env, (access) => handleMcp(request, env, access));
    const route = parseRoute(url);
    if (!route) return withAccess(request, env, usage);
    if (route.action === WIRE_SEGMENT) return connectWire(request, env, route.name);
    if (route.action === TOKEN_SEGMENT) return withAccess(request, env, (access) => mintRoute(request, access, route.name));
    if (route.action === COPY_SEGMENT) return withAccess(request, env, (access) => copyRoute(request, env, access, route.name));
    return runDatabase(request, env, route.name);
  },
};
