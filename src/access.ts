import { bearerToken, hasBearerSecret } from "./bearer";
import type { Env } from "./database";
import { verifyScopedToken } from "./scoped-token";

const UNAUTHORIZED = 401;
const FORBIDDEN = 403;

export type Access = { kind: "admin" } | { kind: "scoped"; database: string };

const ADMIN: Access = { kind: "admin" };

export const unauthorized = () => new Response("unauthorized", { status: UNAUTHORIZED });

export const forbidden = (message: string) => new Response(message, { status: FORBIDDEN });

export async function requestAccess(request: Request, env: Env): Promise<Access | undefined> {
  const secret = env.PGBOX_TOKEN;
  if (!secret) return undefined;
  if (hasBearerSecret(request, secret)) return ADMIN;
  const token = bearerToken(request);
  const claims = token === undefined ? undefined : await verifyScopedToken(secret, token);
  return claims && { kind: "scoped", database: claims.db };
}

export function accessDenial(access: Access, name: string): string | undefined {
  if (access.kind === "admin" || access.database === name) return undefined;
  return `this token is scoped to database "${access.database}" and cannot use "${name}"`;
}

export async function authorizeDatabase(request: Request, env: Env, name: string): Promise<Response | undefined> {
  const access = await requestAccess(request, env);
  if (!access) return unauthorized();
  const denial = accessDenial(access, name);
  return denial === undefined ? undefined : forbidden(denial);
}
