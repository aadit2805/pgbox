import { PGlite } from "@electric-sql/pglite";
import { BaseFilesystem, ERRNO_CODES, type FsStats } from "@electric-sql/pglite/basefs";

export type SqlValue = string | number | null | ArrayBuffer | Uint8Array;
export type SqlExec = (query: string, ...bindings: SqlValue[]) => Record<string, SqlValue>[];

export const POSTGRES_PAGE_BYTES = 8192;
const STAT_BLOCK_BYTES = 512;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const PERMISSION_BITS = 0o7777;
const DEFAULT_DIR_MODE = 0o700;
const DEFAULT_FILE_MODE = 0o600;
const ROOT = "/";
const PATH_UNDER_PREFIX = "substr(path, 1, length(?)) = ?";
const INITIALIZED_KEY = "initialized";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS fs_node (
    path TEXT PRIMARY KEY, parent TEXT NOT NULL, is_dir INTEGER NOT NULL,
    mode INTEGER NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS fs_node_parent ON fs_node(parent)",
  `CREATE TABLE IF NOT EXISTS fs_block (
    path TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (path, idx))`,
  "CREATE TABLE IF NOT EXISTS fs_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
];

type ErrnoName = keyof typeof ERRNO_CODES;
type EmscriptenOptions = Parameters<BaseFilesystem["init"]>[1];
type PostgresModule = Parameters<NonNullable<EmscriptenOptions["preRun"]>[number]>[0];
type StreamWrite = (stream: { nfd: number }, buffer: ArrayBufferView, offset: number, length: number, position: number) => number;

class FsError extends Error {
  code: number;
  constructor(name: ErrnoName, path: string) {
    super(`${name}: ${path}`);
    this.code = ERRNO_CODES[name];
  }
}

interface FsNode {
  path: string;
  is_dir: number;
  mode: number;
  size: number;
  mtime: number;
}

interface BlockSpan {
  idx: number;
  within: number;
  length: number;
  offset: number;
}

const normalize = (path: string) => {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "") return ROOT;
  return trimmed.startsWith(ROOT) ? trimmed : `${ROOT}${trimmed}`;
};

const parentOf = (path: string) => {
  const slash = path.lastIndexOf("/");
  return slash <= 0 ? ROOT : path.slice(0, slash);
};

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const asBytes = (value: SqlValue) => (value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer));

const byteView = (view: ArrayBufferView) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

function* blockSpans(position: number, length: number): Generator<BlockSpan> {
  for (let pos = position; pos < position + length; ) {
    const idx = Math.floor(pos / POSTGRES_PAGE_BYTES);
    const within = pos - idx * POSTGRES_PAGE_BYTES;
    const spanLength = Math.min(POSTGRES_PAGE_BYTES - within, position + length - pos);
    yield { idx, within, length: spanLength, offset: pos - position };
    pos += spanLength;
  }
}

export class StorageFS extends BaseFilesystem {
  private sql: SqlExec;
  private fds = new Map<number, string>();
  private nextFd = 1;

  constructor(sql: SqlExec) {
    super();
    this.sql = sql;
    for (const statement of SCHEMA) sql(statement);
    if (!this.find(ROOT)) this.insertNode({ path: ROOT, is_dir: 1, mode: S_IFDIR | DEFAULT_DIR_MODE });
  }

  override async init(pg: PGlite, emscriptenOptions: EmscriptenOptions) {
    const { emscriptenOpts } = await super.init(pg, emscriptenOptions);
    const routeWrites = (mod: PostgresModule) => this.routeWritesWithViews(mod);
    return { emscriptenOpts: { ...emscriptenOpts, preRun: [...(emscriptenOpts.preRun ?? []), routeWrites] } };
  }

  isInitialized() {
    return this.sql("SELECT 1 FROM fs_meta WHERE key = ?", INITIALIZED_KEY).length > 0;
  }

  markInitialized() {
    this.sql("INSERT OR REPLACE INTO fs_meta (key, value) VALUES (?, ?)", INITIALIZED_KEY, new Date().toISOString());
  }

  clear() {
    this.sql("DELETE FROM fs_block");
    this.sql("DELETE FROM fs_node WHERE path != ?", ROOT);
    this.sql("DELETE FROM fs_meta");
  }

  chmod(path: string, mode: number) {
    const node = this.get(path);
    this.sql("UPDATE fs_node SET mode = ? WHERE path = ?", (node.mode & ~PERMISSION_BITS) | (mode & PERMISSION_BITS), node.path);
  }

  close(fd: number) {
    this.fds.delete(fd);
  }

  fstat(fd: number) {
    return this.stats(this.openFile(fd));
  }

  lstat(path: string) {
    return this.stats(this.get(path));
  }

  mkdir(path: string, options?: { recursive?: boolean; mode?: number }) {
    const target = normalize(path);
    const existing = this.find(target);
    if (existing) {
      if (options?.recursive && existing.is_dir) return;
      throw new FsError("EEXIST", target);
    }
    const parent = this.find(parentOf(target));
    if (!parent && options?.recursive) this.mkdir(parentOf(target), options);
    else this.requireDir(parent, parentOf(target));
    this.insertNode({ path: target, is_dir: 1, mode: S_IFDIR | ((options?.mode ?? DEFAULT_DIR_MODE) & PERMISSION_BITS) });
  }

  open(path: string, _flags?: string, mode?: number) {
    const target = normalize(path);
    const node = this.find(target);
    if (!node) this.createFile(target, mode ?? DEFAULT_FILE_MODE);
    else if (node.is_dir) throw new FsError("EISDIR", target);
    const fd = this.nextFd++;
    this.fds.set(fd, target);
    return fd;
  }

  readdir(path: string) {
    const node = this.requireDir(this.find(normalize(path)), path);
    return this.sql("SELECT path FROM fs_node WHERE parent = ? AND path != ?", node.path, ROOT).map((row) => baseName(String(row.path)));
  }

  read(fd: number, buffer: ArrayBufferView, offset: number, length: number, position: number) {
    const node = this.openFile(fd);
    const target = byteView(buffer);
    const readable = Math.max(0, Math.min(length, node.size - position));
    for (const span of blockSpans(position, readable)) {
      const stored = this.readBlock(node.path, span.idx)?.subarray(span.within, span.within + span.length);
      const dest = offset + span.offset;
      if (stored) target.set(stored, dest);
      target.fill(0, dest + (stored?.length ?? 0), dest + span.length);
    }
    return readable;
  }

  rename(oldPath: string, newPath: string) {
    const from = this.get(oldPath);
    const to = normalize(newPath);
    this.removeRenameTarget(from, to);
    this.sql("UPDATE fs_node SET path = ?, parent = ?, mtime = ? WHERE path = ?", to, parentOf(to), Date.now(), from.path);
    this.sql("UPDATE fs_block SET path = ? WHERE path = ?", to, from.path);
    if (from.is_dir) this.moveDescendants(from.path, to);
    this.moveOpenFds(from.path, to);
  }

  rmdir(path: string) {
    const node = this.requireDir(this.find(normalize(path)), path);
    if (this.sql("SELECT 1 FROM fs_node WHERE parent = ? LIMIT 1", node.path).length) throw new FsError("ENOTEMPTY", node.path);
    this.sql("DELETE FROM fs_node WHERE path = ?", node.path);
  }

  truncate(path: string, len = 0) {
    const node = this.requireFile(this.get(path));
    if (len < node.size) this.dropBlocksFrom(node.path, len);
    this.sql("UPDATE fs_node SET size = ?, mtime = ? WHERE path = ?", len, Date.now(), node.path);
  }

  unlink(path: string) {
    const node = this.requireFile(this.get(path));
    this.sql("DELETE FROM fs_block WHERE path = ?", node.path);
    this.sql("DELETE FROM fs_node WHERE path = ?", node.path);
  }

  utimes(path: string, _atime: number, mtime: number) {
    this.sql("UPDATE fs_node SET mtime = ? WHERE path = ?", mtime, this.get(path).path);
  }

  writeFile(path: string, data: string | Uint8Array, options?: { encoding?: string; mode?: number; flag?: string }) {
    const target = normalize(path);
    const node = this.find(target);
    if (!node) this.createFile(target, options?.mode ?? DEFAULT_FILE_MODE);
    else this.truncate(target, 0);
    const content = typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.writeAt({ path: target, position: 0, source: content, offset: 0, length: content.length, size: 0 });
  }

  write(fd: number, buffer: Uint8Array, offset: number, length: number, position: number) {
    const node = this.openFile(fd);
    return this.writeAt({ path: node.path, position, source: buffer, offset, length, size: node.size });
  }

  private routeWritesWithViews(mod: PostgresModule) {
    const ops: { write: StreamWrite } = Reflect.get(mod.FS.lookupPath(PGlite.paths.PGDATA, {}).node, "stream_ops");
    // PGlite's bridge forwards write(buffer) as buffer.buffer, which drops a view's byteOffset and corrupts files PGlite writes itself.
    ops.write = (stream, buffer, offset, length, position) => {
      try {
        return this.write(stream.nfd, byteView(buffer), offset, length, position);
      } catch (err) {
        if (err instanceof FsError) throw new mod.FS.ErrnoError(err.code);
        throw err;
      }
    };
  }

  private find(path: string): FsNode | undefined {
    const [row] = this.sql("SELECT path, is_dir, mode, size, mtime FROM fs_node WHERE path = ?", path);
    return row && { path: String(row.path), is_dir: Number(row.is_dir), mode: Number(row.mode), size: Number(row.size), mtime: Number(row.mtime) };
  }

  private get(path: string): FsNode {
    const target = normalize(path);
    const node = this.find(target);
    if (!node) throw new FsError("ENOENT", target);
    return node;
  }

  private requireDir(node: FsNode | undefined, path: string): FsNode {
    if (!node) throw new FsError("ENOENT", path);
    if (!node.is_dir) throw new FsError("ENOTDIR", node.path);
    return node;
  }

  private requireFile(node: FsNode): FsNode {
    if (node.is_dir) throw new FsError("EISDIR", node.path);
    return node;
  }

  private openFile(fd: number): FsNode {
    const path = this.fds.get(fd);
    if (path === undefined) throw new FsError("EBADF", String(fd));
    return this.requireFile(this.get(path));
  }

  private stats(node: FsNode): FsStats {
    return {
      dev: 0,
      ino: 0,
      mode: node.mode,
      nlink: 1,
      uid: 0,
      gid: 0,
      rdev: 0,
      size: node.size,
      blksize: POSTGRES_PAGE_BYTES,
      blocks: Math.ceil(node.size / STAT_BLOCK_BYTES),
      atime: node.mtime,
      mtime: node.mtime,
      ctime: node.mtime,
    };
  }

  private insertNode({ path, is_dir, mode }: Pick<FsNode, "path" | "is_dir" | "mode">) {
    this.sql("INSERT INTO fs_node VALUES (?, ?, ?, ?, 0, ?)", path, path === ROOT ? "" : parentOf(path), is_dir, mode, Date.now());
  }

  private createFile(path: string, mode: number) {
    this.requireDir(this.find(parentOf(path)), parentOf(path));
    this.insertNode({ path, is_dir: 0, mode: S_IFREG | (mode & PERMISSION_BITS) });
  }

  private readBlock(path: string, idx: number): Uint8Array | undefined {
    const [row] = this.sql("SELECT data FROM fs_block WHERE path = ? AND idx = ?", path, idx);
    return row ? asBytes(row.data) : undefined;
  }

  private dropBlocksFrom(path: string, len: number) {
    const keep = Math.ceil(len / POSTGRES_PAGE_BYTES);
    this.sql("DELETE FROM fs_block WHERE path = ? AND idx >= ?", path, keep);
    const tail = len % POSTGRES_PAGE_BYTES;
    const last = tail ? this.readBlock(path, keep - 1) : undefined;
    if (last && last.length > tail) this.sql("UPDATE fs_block SET data = ? WHERE path = ? AND idx = ?", last.slice(0, tail), path, keep - 1);
  }

  private removeRenameTarget(from: FsNode, to: string) {
    const existing = this.find(to);
    if (!existing) return;
    if (existing.is_dir && !from.is_dir) throw new FsError("EISDIR", to);
    if (existing.is_dir) this.rmdir(to);
    else this.unlink(to);
  }

  private moveDescendants(from: string, to: string) {
    const prefix = `${from}/`;
    this.sql(
      `UPDATE fs_node SET path = ? || substr(path, length(?) + 1), parent = ? || substr(parent, length(?) + 1) WHERE ${PATH_UNDER_PREFIX}`,
      to,
      from,
      to,
      from,
      prefix,
      prefix,
    );
    this.sql(`UPDATE fs_block SET path = ? || substr(path, length(?) + 1) WHERE ${PATH_UNDER_PREFIX}`, to, from, prefix, prefix);
  }

  private moveOpenFds(from: string, to: string) {
    const prefix = `${from}/`;
    for (const [fd, path] of this.fds) {
      if (path === from) this.fds.set(fd, to);
      else if (path.startsWith(prefix)) this.fds.set(fd, to + path.slice(from.length));
    }
  }

  private writeAt({ path, position, source, offset, length, size }: { path: string; position: number; source: Uint8Array; offset: number; length: number; size: number }) {
    for (const span of blockSpans(position, length)) {
      const start = offset + span.offset;
      const chunk = source.subarray(start, start + span.length);
      this.sql("INSERT OR REPLACE INTO fs_block (path, idx, data) VALUES (?, ?, ?)", path, span.idx, this.mergeIntoBlock(path, span, chunk));
    }
    this.sql("UPDATE fs_node SET size = ?, mtime = ? WHERE path = ?", Math.max(size, position + length), Date.now(), path);
    return length;
  }

  private mergeIntoBlock(path: string, span: BlockSpan, chunk: Uint8Array): Uint8Array {
    if (span.within === 0 && span.length === POSTGRES_PAGE_BYTES) return chunk.slice();
    const existing = this.readBlock(path, span.idx);
    const block = new Uint8Array(Math.max(span.within + span.length, existing?.length ?? 0));
    if (existing) block.set(existing);
    block.set(chunk, span.within);
    return block;
  }
}
