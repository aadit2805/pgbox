export const MCP_NAME = "mcp";
export const MAX_DATABASE_NAME_CHARS = 128;
export const DATABASE_NAME_RULE = `1 to ${MAX_DATABASE_NAME_CHARS} characters with no "/", and not "${MCP_NAME}"`;

export const isDatabaseName = (name: string) =>
  name.length > 0 && name.length <= MAX_DATABASE_NAME_CHARS && !name.includes("/") && name !== MCP_NAME;
