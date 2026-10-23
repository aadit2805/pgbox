import { authorizeDatabase, forbidden, requestAccess, unauthorized, type Access } from "./access";
import { DATABASE_NAME_RULE, isDatabaseName, openDatabase, type Env } from "./database";
import { handleMcp } from "./mcp";
import { mintScopedToken, nowSeconds, type TokenClaims } from "./scoped-token";
import { errorMessage, jsonResponse } from "./serialize";

export { PostgresDatabase } from "./database";

const MCP_PATH = "/mcp";
const TOKEN_SEGMENT = "token";
const TTL_PARAM = "ttl";
const TTL_PATTERN = /^[1-9]\d*$/;
const SECONDS_PER_DAY = 86_400;
const MAX_TOKEN_TTL_DAYS = 365;
const MAX_TOKEN_TTL_SECONDS = MAX_TOKEN_TTL_DAYS * SECONDS_PER_DAY;
const BAD_REQUEST = 400;
const USAGE = `POST /<database-name> with SQL as the body, DELETE /<database-name>, POST /<database-name>/${TOKEN_SEGMENT}[?${TTL_PARAM}=<seconds>] for a token scoped to it, or MCP at ${MCP_PATH}. Names are ${DATABASE_NAME_RULE}.`;
const INVALID_TTL = `${TTL_PARAM} must be whole seconds from 1 to ${MAX_TOKEN_TTL_SECONDS}`;
const SCOPED_CANNOT_MINT = "scoped tokens cannot mint tokens";

interface Route {
  name: string;
  mintsToken: boolean;
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
  if (!segment || rest.length || (action !== undefined && action !== TOKEN_SEGMENT)) return undefined;
  const name = decodeName(segment);
  return name === undefined ? undefined : { name, mintsToken: action === TOKEN_SEGMENT };
}

async function withAccess(request: Request, env: Env, handle: (access: Access) => Response | Promise<Response>): Promise<Response> {
  const access = await requestAccess(request, env);
  return access ? handle(access) : unauthorized();
}

function expiryClaim(ttl: string | null): Pick<TokenClaims, "exp"> | undefined {
  if (ttl === null) return {};
  if (!TTL_PATTERN.test(ttl) || Number(ttl) > MAX_TOKEN_TTL_SECONDS) return undefined;
  return { exp: nowSeconds() + Number(ttl) };
}

async function mintToken(request: Request, env: Env, name: string): Promise<Response> {
  if (request.method !== "POST") return usage();
  if (!env.PGBOX_TOKEN) return unauthorized();
  const expiry = expiryClaim(new URL(request.url).searchParams.get(TTL_PARAM));
  if (!expiry) return new Response(INVALID_TTL, { status: BAD_REQUEST });
  const token = await mintScopedToken(env.PGBOX_TOKEN, { db: name, ...expiry });
  return jsonResponse({ token, database: name, expiresAt: expiry.exp ?? null });
}

async function respond(name: string, error: string, run: () => Promise<object>): Promise<Response> {
  try {
    return jsonResponse(await run());
  } catch (err) {
    const message = errorMessage(err);
    console.error(`${error} for ${name}: ${message}`);
    return jsonResponse({ error, message }, { status: 500 });
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === MCP_PATH) return withAccess(request, env, (access) => handleMcp(request, env, access));
    const route = parseRoute(url);
    if (!route) return withAccess(request, env, usage);
    if (!route.mintsToken) return runDatabase(request, env, route.name);
    return withAccess(request, env, (access) => (access.kind === "admin" ? mintToken(request, env, route.name) : forbidden(SCOPED_CANNOT_MINT)));
  },
};
