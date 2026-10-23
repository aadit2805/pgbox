import net from "node:net";

const DEFAULT_PORT = 5432;
const LISTEN_HOST = "127.0.0.1";
const PORT_FLAG = "--port";
const WIRE_SEGMENT = "wire";
const USAGE = `usage: PGBOX_URL=https://<worker> PGBOX_TOKEN=<token> node scripts/proxy.mjs <database> [${PORT_FLAG} ${DEFAULT_PORT}]`;
const WEBSOCKET_PROTOCOLS = { "http:": "ws:", "https:": "wss:" };
const ERROR_RESPONSE = "E";
const FATAL = "FATAL";
const CONNECTION_FAILURE = "08006";
const INT32_BYTES = 4;
const TYPE_BYTES = 1;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const [database, ...rest] = argv;
  if (!database || database.startsWith("-")) fail(USAGE);
  if (rest.length === 0) return { database, port: DEFAULT_PORT };
  const port = Number(rest[1]);
  if (rest.length !== 2 || rest[0] !== PORT_FLAG || !Number.isInteger(port)) fail(USAGE);
  return { database, port };
}

function wireUrl(base, database) {
  const url = new URL(`/${encodeURIComponent(database)}/${WIRE_SEGMENT}`, base);
  const protocol = WEBSOCKET_PROTOCOLS[url.protocol];
  if (!protocol) fail(`PGBOX_URL must start with http:// or https://, got ${base}`);
  url.protocol = protocol;
  return url;
}

function errorResponse(message) {
  const fields = Buffer.from(`S${FATAL}\0V${FATAL}\0C${CONNECTION_FAILURE}\0M${message}\0\0`);
  const header = Buffer.alloc(TYPE_BYTES + INT32_BYTES);
  header.write(ERROR_RESPONSE);
  header.writeInt32BE(INT32_BYTES + fields.length, TYPE_BYTES);
  return Buffer.concat([header, fields]);
}

function bridge({ client, url, token }) {
  client.setNoDelay(true);
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  socket.binaryType = "arraybuffer";
  const pending = [];
  let opened = false;
  client.on("data", (chunk) => (opened ? socket.send(chunk) : pending.push(chunk)));
  client.on("close", () => socket.close());
  client.on("error", (err) => console.error(`client connection failed: ${err.message}`));
  socket.addEventListener("open", () => {
    opened = true;
    for (const chunk of pending.splice(0)) socket.send(chunk);
  });
  socket.addEventListener("message", (event) => client.write(new Uint8Array(event.data)));
  socket.addEventListener("close", () => client.end());
  socket.addEventListener("error", () => {
    if (opened) return console.error("pgbox connection dropped");
    const message = `could not open a WebSocket to ${url.origin}; check PGBOX_URL and PGBOX_TOKEN`;
    console.error(message);
    client.end(errorResponse(message));
  });
}

const { database, port } = parseArgs(process.argv.slice(2));
const base = process.env.PGBOX_URL;
const token = process.env.PGBOX_TOKEN;
if (!base || !token) fail(USAGE);
const url = wireUrl(base, database);

net
  .createServer((client) => bridge({ client, url, token }))
  .on("error", (err) => fail(`proxy could not listen on ${LISTEN_HOST}:${port}: ${err.message}`))
  .listen(port, LISTEN_HOST, () => console.error(`pgbox ${database} on postgresql://postgres@${LISTEN_HOST}:${port}/postgres`));
