/**
 * Exam and solution PDFs are immutable once published and are re-read on every
 * turn of every chat, so the fetch + base64 encode is pure repeated work. This
 * caches the encoded form in process, keyed by URL.
 *
 * Two properties matter beyond the obvious hit/miss:
 *  - concurrent requests for the same URL share one fetch, so a class opening
 *    the same tenta at once does not fan out into N downloads;
 *  - failures are never cached, only the in-flight promise is shared, so a
 *    transient storage error does not pin a null for the whole TTL.
 */

const MAX_BYTES = 256 * 1024 * 1024;
const TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  data: string;
  bytes: number;
  expiresAt: number;
}

// Map iteration order is insertion order, which gives LRU for free: re-inserting
// on read moves an entry to the back, so the front is always the coldest.
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<string | null>>();
let totalBytes = 0;

function drop(url: string, entry: CacheEntry) {
  cache.delete(url);
  totalBytes -= entry.bytes;
}

function evictUntilUnderLimit() {
  for (const [url, entry] of cache) {
    if (totalBytes <= MAX_BYTES) return;
    drop(url, entry);
  }
}

function read(url: string): string | null {
  const entry = cache.get(url);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    drop(url, entry);
    return null;
  }

  cache.delete(url);
  cache.set(url, entry);
  return entry.data;
}

function write(url: string, data: string) {
  const existing = cache.get(url);
  if (existing) drop(url, existing);

  const bytes = data.length;
  if (bytes > MAX_BYTES) return;

  cache.set(url, { data, bytes, expiresAt: Date.now() + TTL_MS });
  totalBytes += bytes;
  evictUntilUnderLimit();
}

async function download(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Failed to fetch PDF at ${url}: ${response.statusText}`);
      return null;
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer).toString("base64");
  } catch (error) {
    console.error(`Network error fetching PDF at ${url}:`, error);
    return null;
  }
}

export async function fetchPdfAsBase64(url: string): Promise<string | null> {
  const cached = read(url);
  if (cached !== null) return cached;

  const pending = inFlight.get(url);
  if (pending) return pending;

  const request = download(url)
    .then((data) => {
      if (data !== null) write(url, data);
      return data;
    })
    .finally(() => {
      inFlight.delete(url);
    });

  inFlight.set(url, request);
  return request;
}

/** Test seam: drops every entry and any recorded size. */
export function clearPdfCache() {
  cache.clear();
  inFlight.clear();
  totalBytes = 0;
}

export function pdfCacheStats() {
  return { entries: cache.size, bytes: totalBytes };
}
