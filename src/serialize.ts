const HEX_RADIX = 16;
const HEX_BYTE_DIGITS = 2;

const toHex = (bytes: Uint8Array) => `\\x${Array.from(bytes, (byte) => byte.toString(HEX_RADIX).padStart(HEX_BYTE_DIGITS, "0")).join("")}`;

const postgresValue = (_key: string, value: unknown) => {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return toHex(value);
  return value;
};

export const toJson = (value: unknown) => JSON.stringify(value, postgresValue);

export const jsonResponse = (value: unknown, init?: ResponseInit) =>
  new Response(toJson(value), { ...init, headers: { "content-type": "application/json", ...init?.headers } });

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
