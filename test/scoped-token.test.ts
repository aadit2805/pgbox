import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { MCP_NAME } from "../src/database-name.ts";
import { mintScopedToken, nowSeconds, verifyScopedToken } from "../src/scoped-token.ts";

const SECRET = "test-admin-secret";
const OTHER_SECRET = "other-admin-secret";
const KEY_CONTEXT = "pgbox scoped token v1";
const PREFIX = "pgbox_";
const DATABASE = "alpha";
const HOUR_SECONDS = 3600;
const NON_INTEGER_EXP = 1.5;
const INVALID_UTF8 = Buffer.from([0xff, 0xfe, 0xfd]);

const signingKey = createHmac("sha256", SECRET).update(KEY_CONTEXT).digest();

function signRaw(payloadBytes: Buffer): string {
  const payload = payloadBytes.toString("base64url");
  return `${PREFIX}${payload}.${createHmac("sha256", signingKey).update(payload).digest("base64url")}`;
}

const signJson = (value: unknown) => signRaw(Buffer.from(JSON.stringify(value)));

function splitToken(token: string): [string, string] {
  const [payload = "", signature = ""] = token.slice(PREFIX.length).split(".");
  return [payload, signature];
}

function nonCanonicalSpelling(segment: string): string {
  const last = segment.at(-1) ?? "";
  const bytes = Buffer.from(segment, "base64url");
  const sibling = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"].find(
    (char) => char !== last && Buffer.from(segment.slice(0, -1) + char, "base64url").equals(bytes),
  );
  assert.ok(sibling, "segment has a non-canonical spelling");
  return segment.slice(0, -1) + sibling;
}

const minted = await mintScopedToken(SECRET, { db: DATABASE });
assert.deepEqual(await verifyScopedToken(SECRET, minted), { db: DATABASE }, "round trip without expiry");
assert.equal(minted, signJson({ db: DATABASE }), "matches the documented format");

const exp = nowSeconds() + HOUR_SECONDS;
assert.deepEqual(await verifyScopedToken(SECRET, await mintScopedToken(SECRET, { db: DATABASE, exp })), { db: DATABASE, exp }, "round trip with expiry");

assert.equal(await verifyScopedToken(OTHER_SECRET, minted), undefined, "another secret rejects it");

const [payload, signature] = splitToken(minted);
const forgedPayload = Buffer.from(JSON.stringify({ db: "beta" })).toString("base64url");
assert.equal(await verifyScopedToken(SECRET, `${PREFIX}${forgedPayload}.${signature}`), undefined, "tampered payload");

const flippedSignature = `${signature.slice(0, 1) === "A" ? "B" : "A"}${signature.slice(1)}`;
assert.equal(await verifyScopedToken(SECRET, `${PREFIX}${payload}.${flippedSignature}`), undefined, "tampered signature");

assert.equal(await verifyScopedToken(SECRET, `${PREFIX}${payload}.${nonCanonicalSpelling(signature)}`), undefined, "non-canonical signature");
assert.equal(await verifyScopedToken(SECRET, `${PREFIX}${payload}.${signature.slice(0, -1)}`), undefined, "short signature");
assert.equal(await verifyScopedToken(SECRET, `${PREFIX}${payload}.${signature}.x`), undefined, "extra segment");

assert.equal(await verifyScopedToken(SECRET, signJson({ db: DATABASE, exp: nowSeconds() - 1 })), undefined, "expired");
assert.equal(await verifyScopedToken(SECRET, signJson({ db: DATABASE, exp: null })), undefined, "exp null");
assert.equal(await verifyScopedToken(SECRET, signJson({ db: DATABASE, exp: NON_INTEGER_EXP })), undefined, "exp non-integer");
assert.equal(await verifyScopedToken(SECRET, signJson({ db: MCP_NAME })), undefined, "reserved name");
assert.equal(await verifyScopedToken(SECRET, signRaw(Buffer.from("{not json"))), undefined, "garbage JSON behind a valid signature");
assert.equal(await verifyScopedToken(SECRET, signRaw(INVALID_UTF8)), undefined, "invalid UTF-8 behind a valid signature");
assert.equal(await verifyScopedToken(SECRET, SECRET), undefined, "admin secret is not a scoped token");
