import { isDatabaseName } from "./database-name.ts";

const TOKEN_PREFIX = "pgbox_";
const TOKEN_SEPARATOR = ".";
const KEY_CONTEXT = "pgbox scoped token v1";
const HMAC_ALGORITHM = "HMAC";
const HMAC_PARAMS = { name: HMAC_ALGORITHM, hash: "SHA-256" };
const SIGNATURE_BYTES = 32;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const BASE64_PADDING = /=+$/;
const MS_PER_SECOND = 1000;

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export interface TokenClaims {
  db: string;
  exp?: number;
}

interface SignedToken {
  payload: string;
  payloadBytes: Uint8Array;
  signature: Uint8Array;
}

let cachedKey: { secret: string; key: Promise<CryptoKey> } | undefined;

export const nowSeconds = () => Math.floor(Date.now() / MS_PER_SECOND);

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(BASE64_PADDING, "");

function decodeBase64(text: string): Uint8Array | undefined {
  try {
    return Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
  } catch (err) {
    if (err instanceof DOMException) return undefined;
    throw err;
  }
}

function fromCanonicalBase64Url(text: string): Uint8Array | undefined {
  if (!BASE64URL_PATTERN.test(text)) return undefined;
  const bytes = decodeBase64(text);
  return bytes && toBase64Url(bytes) === text ? bytes : undefined;
}

async function deriveSigningKey(secret: string): Promise<CryptoKey> {
  const adminKey = await crypto.subtle.importKey("raw", encoder.encode(secret), HMAC_PARAMS, false, ["sign"]);
  const derived = await crypto.subtle.sign(HMAC_ALGORITHM, adminKey, encoder.encode(KEY_CONTEXT));
  return crypto.subtle.importKey("raw", derived, HMAC_PARAMS, false, ["sign", "verify"]);
}

function signingKey(secret: string): Promise<CryptoKey> {
  if (cachedKey?.secret !== secret) cachedKey = { secret, key: deriveSigningKey(secret) };
  return cachedKey.key;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(strictDecoder.decode(bytes));
  } catch (err) {
    if (err instanceof SyntaxError || err instanceof TypeError) return undefined;
    throw err;
  }
}

function parseClaims(bytes: Uint8Array): TokenClaims | undefined {
  const value = parseJson(bytes);
  if (typeof value !== "object" || value === null) return undefined;
  const { db, exp } = value as { db?: unknown; exp?: unknown };
  if (typeof db !== "string" || !isDatabaseName(db)) return undefined;
  if (exp === undefined) return { db };
  return typeof exp === "number" && Number.isSafeInteger(exp) ? { db, exp } : undefined;
}

function splitToken(token: string): SignedToken | undefined {
  if (!token.startsWith(TOKEN_PREFIX)) return undefined;
  const [payload, signatureText, ...rest] = token.slice(TOKEN_PREFIX.length).split(TOKEN_SEPARATOR);
  if (payload === undefined || signatureText === undefined || rest.length) return undefined;
  const payloadBytes = fromCanonicalBase64Url(payload);
  const signature = fromCanonicalBase64Url(signatureText);
  if (!payloadBytes || signature?.byteLength !== SIGNATURE_BYTES) return undefined;
  return { payload, payloadBytes, signature };
}

async function hasValidSignature(secret: string, { payload, signature }: SignedToken): Promise<boolean> {
  return crypto.subtle.verify(HMAC_ALGORITHM, await signingKey(secret), signature, encoder.encode(payload));
}

const isLive = (claims: TokenClaims) => claims.exp === undefined || claims.exp > nowSeconds();

export async function mintScopedToken(secret: string, claims: TokenClaims): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(HMAC_ALGORITHM, await signingKey(secret), encoder.encode(payload));
  return `${TOKEN_PREFIX}${payload}${TOKEN_SEPARATOR}${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifyScopedToken(secret: string, token: string): Promise<TokenClaims | undefined> {
  const signed = splitToken(token);
  if (!signed || !(await hasValidSignature(secret, signed))) return undefined;
  const claims = parseClaims(signed.payloadBytes);
  return claims && isLive(claims) ? claims : undefined;
}
