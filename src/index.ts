import { hasBearerSecret } from "./bearer";
import { DATABASE_NAME_RULE, isDatabaseName, openDatabase, type Env } from "./database";
import { handleMcp } from "./mcp";
import { errorMessage, jsonResponse } from "./serialize";

export { PostgresDatabase } from "./database";

const MCP_PATH = "/mcp";
const USAGE = `POST /<database-name> with SQL as the body, DELETE /<database-name>, or MCP at ${MCP_PATH}. Names are ${DATABASE_NAME_RULE}.`;

function databaseName(url: URL): string | undefined {
  const [, name, ...rest] = url.pathname.split("/");
  if (!name || rest.length) return undefined;
  try {
    const decoded = decodeURIComponent(name);
    return isDatabaseName(decoded) ? decoded : undefined;
  } catch (err) {
    if (err instanceof URIError) return undefined;
    throw err;
  }
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!hasBearerSecret(request, env.PGBOX_TOKEN)) return new Response("unauthorized", { status: 401 });
    const url = new URL(request.url);
    if (url.pathname === MCP_PATH) return handleMcp(request, env);
    const name = databaseName(url);
    if (!name) return new Response(USAGE, { status: 400 });
    const database = openDatabase(env, name);
    if (request.method === "DELETE") return respond(name, "delete_failed", () => database.destroy(name));
    if (request.method !== "POST") return new Response(USAGE, { status: 400 });
    return respond(name, "query_failed", async () => database.query(name, await request.text()));
  },
};
