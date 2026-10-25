import { MB } from "./postgres-settings.ts";
import { POSTGRES_PAGE_BYTES, type StorageFS, type StoredNode, type StoredPage } from "./storage-fs.ts";

const COPY_BATCH_MB = 4;
const COPY_BATCH_PAGES = (COPY_BATCH_MB * MB) / POSTGRES_PAGE_BYTES;
const COPY_BATCH_NODES = 1000;

export interface CopyDestination {
  putNodes(nodes: StoredNode[]): Promise<void>;
  putPages(pages: StoredPage[]): Promise<void>;
}

interface CopiedStorage {
  pages: number;
  bytes: number;
}

export async function copyStorage(source: StorageFS, destination: CopyDestination): Promise<CopiedStorage> {
  const copied: CopiedStorage = { pages: 0, bytes: 0 };
  for (const nodes of source.nodeBatches(COPY_BATCH_NODES)) await destination.putNodes(nodes);
  for (const pages of source.pageBatches(COPY_BATCH_PAGES)) {
    await destination.putPages(pages);
    copied.pages += pages.length;
    copied.bytes += pages.reduce((sum, page) => sum + page.data.byteLength, 0);
  }
  return copied;
}
