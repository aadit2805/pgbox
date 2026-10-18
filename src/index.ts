import { hasBearerSecret } from "./bearer";
import type { Env } from "./database";

export { Database } from "./database";

const USAGE = "POST /<database-name> with SQL as the body";

function databaseName(url: URL): string | undefined {
  const [, name, ...rest] = url.pathname.split("/");
  return name && rest.length === 0 ? decodeURIComponent(name) : undefined;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!hasBearerSecret(request, env.PGBOX_TOKEN)) return new Response("unauthorized", { status: 401 });
    const name = databaseName(new URL(request.url));
    if (request.method !== "POST" || !name) return new Response(USAGE, { status: 400 });
    const database = env.DB.get(env.DB.idFromName(name));
    try {
      return Response.json(await database.query(name, await request.text()));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`query failed for ${name}: ${message}`);
      return Response.json({ error: "query_failed", message }, { status: 500 });
    }
  },
};
