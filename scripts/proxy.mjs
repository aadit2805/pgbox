import net from "node:net";

const DEFAULT_PORT = 5432;
const LISTEN_HOST = "127.0.0.1";
const PORT_FLAG = "--port";
const WIRE_SEGMENT = "wire";
const USAGE = `usage: PGBOX_URL=https://<worker> PGBOX_TOKEN=<admin or scoped token> node scripts/proxy.mjs <database> [${PORT_FLAG} ${DEFAULT_PORT}]`;
const WEBSOCKET_PROTOCOLS = { "http:": "ws:", "https:": "wss:" };
const KB = 1024;
const MB = KB * KB;
const PAUSE_ABOVE_BUFFERED_BYTES = 4 * MB;
const RESUME_BELOW_BUFFERED_BYTES = 256 * KB;
const BUFFERED_POLL_MS = 10;
const ERROR_RESPONSE_TYPE = "E";
const SEVERITY_FIELD = "S";
const NONLOCALIZED_SEVERITY_FIELD = "V";
const CODE_FIELD = "C";
const MESSAGE_FIELD = "M";
const FIELD_TERMINATOR = "\0";
const FATAL = "FATAL";
const CONNECTION_FAILURE = "08006";
const TYPE_BYTES = 1;
const INT32_BYTES = 4;

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
  const field = (type, value) => `${type}${value}${FIELD_TERMINATOR}`;
  const body = field(SEVERITY_FIELD, FATAL) + field(NONLOCALIZED_SEVERITY_FIELD, FATAL) + field(CODE_FIELD, CONNECTION_FAILURE) + field(MESSAGE_FIELD, message) + FIELD_TERMINATOR;
  const fields = Buffer.from(body);
  const header = Buffer.alloc(TYPE_BYTES + INT32_BYTES);
  header.write(ERROR_RESPONSE_TYPE);
  header.writeInt32BE(INT32_BYTES + fields.length, TYPE_BYTES);
  return Buffer.concat([header, fields]);
}

function resumeWhenDrained(client, socket) {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > RESUME_BELOW_BUFFERED_BYTES) return setTimeout(resumeWhenDrained, BUFFERED_POLL_MS, client, socket);
  client.resume();
}

function sendUpstream(client, socket, chunk) {
  socket.send(chunk);
  if (socket.bufferedAmount <= PAUSE_ABOVE_BUFFERED_BYTES || client.isPaused()) return;
  client.pause();
  resumeWhenDrained(client, socket);
}

function bridge({ client, url, token }) {
  client.setNoDelay(true);
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  socket.binaryType = "arraybuffer";
  const pending = [];
  let opened = false;
  client.on("data", (chunk) => (opened ? sendUpstream(client, socket, chunk) : pending.push(chunk)));
  client.on("close", () => socket.close());
  client.on("error", (err) => console.error(`client connection failed: ${err.message}`));
  socket.addEventListener("open", () => {
    opened = true;
    for (const chunk of pending.splice(0)) sendUpstream(client, socket, chunk);
  });
  socket.addEventListener("message", (event) => client.write(new Uint8Array(event.data)));
  socket.addEventListener("close", () => client.end());
  socket.addEventListener("error", () => {
    if (opened) return console.error("pgbox connection dropped");
    const message = `could not open a WebSocket to ${url.origin}; check PGBOX_URL and PGBOX_TOKEN`;
    console.error(message);
    if (!client.destroyed) client.end(errorResponse(message));
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
