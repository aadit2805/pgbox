const BEARER_PREFIX = "Bearer ";

const encoder = new TextEncoder();

export function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length) : undefined;
}

export function hasBearerSecret(request: Request, secret: string | undefined): boolean {
  const token = bearerToken(request);
  if (!secret || token === undefined) return false;
  const given = encoder.encode(token);
  const expected = encoder.encode(secret);
  return given.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(given, expected);
}
