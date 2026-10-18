const BEARER_PREFIX = "Bearer ";

const encoder = new TextEncoder();

export function hasBearerSecret(request: Request, secret: string | undefined): boolean {
  const header = request.headers.get("authorization") ?? "";
  if (!secret || !header.startsWith(BEARER_PREFIX)) return false;
  const given = encoder.encode(header.slice(BEARER_PREFIX.length));
  const expected = encoder.encode(secret);
  return given.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(given, expected);
}
