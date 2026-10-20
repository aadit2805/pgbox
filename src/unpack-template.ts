import { POSTGRES_PAGE_BYTES, type StorageFS } from "./storage-fs.ts";

const TAR_BLOCK_BYTES = 512;
const NAME = { start: 0, end: 100 };
const MODE = { start: 100, end: 108 };
const SIZE = { start: 124, end: 136 };
const MTIME = { start: 136, end: 148 };
const TYPE_FLAG = 156;
const USTAR_MAGIC = { start: 257, end: 262 };
const USTAR_PREFIX = { start: 345, end: 500 };
const FILE_TYPES = new Set(["0", "\0"]);
const DIRECTORY_TYPE = "5";
const OCTAL = 8;
const MS_PER_SECOND = 1000;

interface Field {
  start: number;
  end: number;
}

interface TarEntry {
  path: string;
  type: string;
  mode: number;
  size: number;
  mtimeMs: number;
}

const decoder = new TextDecoder();

const text = (header: Uint8Array, { start, end }: Field) => {
  const field = header.subarray(start, end);
  const nul = field.indexOf(0);
  return decoder.decode(nul === -1 ? field : field.subarray(0, nul));
};

const octal = (header: Uint8Array, field: Field) => parseInt(text(header, field).trim() || "0", OCTAL);

const paddingAfter = (size: number) => (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;

function parseHeader(header: Uint8Array): TarEntry | undefined {
  if (header.every((byte) => byte === 0)) return undefined;
  const prefix = text(header, USTAR_MAGIC) === "ustar" ? text(header, USTAR_PREFIX) : "";
  const name = text(header, NAME);
  const path = prefix ? `${prefix}/${name}` : name;
  const size = octal(header, SIZE);
  if (!Number.isFinite(size)) throw new Error(`template entry ${path} has an unreadable size`);
  return { path, type: String.fromCharCode(header[TYPE_FLAG] ?? 0), mode: octal(header, MODE), size, mtimeMs: octal(header, MTIME) * MS_PER_SECOND };
}

class ByteReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private pending: Uint8Array = new Uint8Array(0);

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  async next(max: number): Promise<Uint8Array> {
    while (!this.pending.length) {
      const { done, value } = await this.reader.read();
      if (done) throw new Error("template ended mid-entry");
      this.pending = value;
    }
    const chunk = this.pending.subarray(0, max);
    this.pending = this.pending.subarray(chunk.length);
    return chunk;
  }

  async exactly(length: number): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    for (let filled = 0; filled < length; ) {
      const chunk = await this.next(length - filled);
      out.set(chunk, filled);
      filled += chunk.length;
    }
    return out;
  }

  async skip(length: number) {
    for (let left = length; left > 0; ) left -= (await this.next(left)).length;
  }

  cancel() {
    return this.reader.cancel();
  }
}

async function writeEntry(fs: StorageFS, bytes: ByteReader, entry: TarEntry) {
  if (entry.type === DIRECTORY_TYPE) fs.mkdir(entry.path, { recursive: true, mode: entry.mode });
  else if (FILE_TYPES.has(entry.type)) await writeFile(fs, bytes, entry);
  else throw new Error(`template entry ${entry.path} has unsupported tar type ${entry.type}`);
}

async function writeFile(fs: StorageFS, bytes: ByteReader, entry: TarEntry) {
  const fd = fs.open(entry.path, undefined, entry.mode);
  try {
    for (let position = 0; position < entry.size; ) {
      const chunk = await bytes.exactly(Math.min(POSTGRES_PAGE_BYTES, entry.size - position));
      position += fs.write(fd, chunk, 0, chunk.length, position);
    }
  } finally {
    fs.close(fd);
  }
  fs.utimes(entry.path, entry.mtimeMs, entry.mtimeMs);
}

export async function unpackTemplate(fs: StorageFS, gzipped: ReadableStream<Uint8Array>) {
  const bytes = new ByteReader(gzipped.pipeThrough(new DecompressionStream("gzip")));
  const nextEntry = async () => parseHeader(await bytes.exactly(TAR_BLOCK_BYTES));
  try {
    for (let entry = await nextEntry(); entry; entry = await nextEntry()) {
      await writeEntry(fs, bytes, entry);
      await bytes.skip(paddingAfter(entry.size));
    }
  } finally {
    await bytes.cancel();
  }
}
