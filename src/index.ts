import { authorizeDatabase, forbidden, requestAccess, unauthorized, type Access } from "./access";
import { DATABASE_NAME_HEADER, openDatabase, type Env } from "./database";
import { DATABASE_NAME_RULE, isDatabaseName, MCP_NAME } from "./database-name";
import { BAD_REQUEST, INTERNAL_SERVER_ERROR, UPGRADE_REQUIRED } from "./http-status";
import { handleMcp } from "./mcp";
import { mintScopedToken, nowSeconds, type TokenClaims } from "./scoped-token";
import { errorMessage, jsonResponse } from "./serialize";

export { PostgresDatabase } from "./database";

const MCP_PATH = `/${MCP_NAME}`;
const TOKEN_SEGMENT = "token";
const WIRE_SEGMENT = "wire";
const WEBSOCKET = "websocket";
const TTL_PARAM = "ttl";
const TTL_NEVER = "never";
const TTL_PATTERN = /^[1-9]\d*$/;
const SECONDS_PER_DAY = 86_400;
const DEFAULT_TOKEN_TTL_DAYS = 30;
const MAX_TOKEN_TTL_DAYS = 365;
const DEFAULT_TOKEN_TTL_SECONDS = DEFAULT_TOKEN_TTL_DAYS * SECONDS_PER_DAY;
const MAX_TOKEN_TTL_SECONDS = MAX_TOKEN_TTL_DAYS * SECONDS_PER_DAY;
const USAGE = `POST /<database-name> with SQL as the body, DELETE /<database-name>, POST /<database-name>/${TOKEN_SEGMENT}[?${TTL_PARAM}=<seconds>|${TTL_NEVER}] for a token scoped to it, a Postgres connection over a WebSocket at GET /<database-name>/${WIRE_SEGMENT}, or MCP at ${MCP_PATH}. Names are ${DATABASE_NAME_RULE}.`;
const INVALID_TTL = `${TTL_PARAM} must be whole seconds from 1 to ${MAX_TOKEN_TTL_SECONDS}, or ${TTL_NEVER}`;
const WIRE_USAGE = `/<database-name>/${WIRE_SEGMENT} only accepts a GET WebSocket upgrade carrying Postgres protocol bytes; run scripts/proxy.mjs to connect psql or an ORM.`;
const SCOPED_CANNOT_MINT = "scoped tokens cannot mint tokens";

interface Route {
  name: string;
  mintsToken: boolean;
  wire: boolean;
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
  if (!segment || rest.length || (action !== undefined && action !== TOKEN_SEGMENT && action !== WIRE_SEGMENT)) return undefined;
  const name = decodeName(segment);
  return name === undefined ? undefined : { name, mintsToken: action === TOKEN_SEGMENT, wire: action === WIRE_SEGMENT };
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

async function respond(name: string, error: string, run: () => Promise<object>): Promise<Response> {
  try {
    return jsonResponse(await run());
  } catch (err) {
    const message = errorMessage(err);
    console.error(`${error} for ${name}: ${message}`);
    return jsonResponse({ error, message }, { status: INTERNAL_SERVER_ERROR });
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
    const message = errorMessage(err);
    console.error(`wire_failed for ${name}: ${message}`);
    return jsonResponse({ error: "wire_failed", message }, { status: INTERNAL_SERVER_ERROR });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === MCP_PATH) return withAccess(request, env, (access) => handleMcp(request, env, access));
    const route = parseRoute(url);
    if (!route) return withAccess(request, env, usage);
    if (route.wire) return connectWire(request, env, route.name);
    if (!route.mintsToken) return runDatabase(request, env, route.name);
    return withAccess(request, env, (access) => mintRoute(request, access, route.name));
  },
};
