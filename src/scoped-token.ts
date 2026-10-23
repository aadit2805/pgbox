import { isDatabaseName } from "./database";

const TOKEN_PREFIX = "pgbox_";
const TOKEN_SEPARATOR = ".";
const KEY_CONTEXT = "pgbox scoped token v1";
const HMAC_ALGORITHM = "HMAC";
const HMAC_PARAMS = { name: HMAC_ALGORITHM, hash: "SHA-256" };
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const BASE64_PADDING = /=+$/;
const MS_PER_SECOND = 1000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface TokenClaims {
  db: string;
  exp?: number;
}

export const nowSeconds = () => Math.floor(Date.now() / MS_PER_SECOND);

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(BASE64_PADDING, "");

function fromBase64Url(text: string): Uint8Array | undefined {
  if (!BASE64URL_PATTERN.test(text)) return undefined;
  try {
    return Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
  } catch (err) {
    if (err instanceof DOMException) return undefined;
    throw err;
  }
}

async function signingKey(secret: string): Promise<CryptoKey> {
  const adminKey = await crypto.subtle.importKey("raw", encoder.encode(secret), HMAC_PARAMS, false, ["sign"]);
  const derived = await crypto.subtle.sign(HMAC_ALGORITHM, adminKey, encoder.encode(KEY_CONTEXT));
  return crypto.subtle.importKey("raw", derived, HMAC_PARAMS, false, ["sign", "verify"]);
}

function parseClaims(json: string): TokenClaims | undefined {
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null) return undefined;
  const { db, exp } = value as { db?: unknown; exp?: unknown };
  if (typeof db !== "string" || !isDatabaseName(db)) return undefined;
  if (exp === undefined) return { db };
  return typeof exp === "number" && Number.isSafeInteger(exp) ? { db, exp } : undefined;
}

export async function mintScopedToken(secret: string, claims: TokenClaims): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(HMAC_ALGORITHM, await signingKey(secret), encoder.encode(payload));
  return `${TOKEN_PREFIX}${payload}${TOKEN_SEPARATOR}${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifyScopedToken(secret: string, token: string): Promise<TokenClaims | undefined> {
  if (!token.startsWith(TOKEN_PREFIX)) return undefined;
  const [payload, signature, ...rest] = token.slice(TOKEN_PREFIX.length).split(TOKEN_SEPARATOR);
  const signatureBytes = signature === undefined ? undefined : fromBase64Url(signature);
  const payloadBytes = payload === undefined ? undefined : fromBase64Url(payload);
  if (!payload || !signatureBytes || !payloadBytes || rest.length) return undefined;
  if (!(await crypto.subtle.verify(HMAC_ALGORITHM, await signingKey(secret), signatureBytes, encoder.encode(payload)))) return undefined;
  const claims = parseClaims(decoder.decode(payloadBytes));
  return claims && (claims.exp === undefined || claims.exp > nowSeconds()) ? claims : undefined;
}
