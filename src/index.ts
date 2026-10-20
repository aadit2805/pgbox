import { hasBearerSecret } from "./bearer";
import type { Env } from "./database";

export { PostgresDatabase } from "./database";

const USAGE = "POST /<database-name> with SQL as the body, or DELETE /<database-name>";

function databaseName(url: URL): string | undefined {
  const [, name, ...rest] = url.pathname.split("/");
  if (!name || rest.length) return undefined;
  try {
    return decodeURIComponent(name);
  } catch (err) {
    if (err instanceof URIError) return undefined;
    throw err;
  }
}

async function respond(name: string, error: string, run: () => Promise<object>): Promise<Response> {
  try {
    return Response.json(await run());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`${error} for ${name}: ${message}`);
    return Response.json({ error, message }, { status: 500 });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!hasBearerSecret(request, env.PGBOX_TOKEN)) return new Response("unauthorized", { status: 401 });
    const name = databaseName(new URL(request.url));
    if (!name) return new Response(USAGE, { status: 400 });
    const database = env.DB.get(env.DB.idFromName(name));
    if (request.method === "DELETE") return respond(name, "delete_failed", () => database.destroy(name));
    if (request.method !== "POST") return new Response(USAGE, { status: 400 });
    return respond(name, "query_failed", async () => database.query(name, await request.text()));
  },
};
