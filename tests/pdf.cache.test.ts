import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  clearPdfCache,
  fetchPdfAsBase64,
  pdfCacheStats,
} from "../src/utils/pdf.cache";

const realFetch = globalThis.fetch;

function stubFetch(body: string, ok = true) {
  const spy = mock(async () => ({
    ok,
    statusText: ok ? "OK" : "Not Found",
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  }));
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  clearPdfCache();
});

describe("pdf base64 cache", () => {
  it("downloads once and serves later reads from cache", async () => {
    const spy = stubFetch("tenta");

    const first = await fetchPdfAsBase64("https://example.test/a.pdf");
    const second = await fetchPdfAsBase64("https://example.test/a.pdf");

    expect(first).toBe(Buffer.from("tenta").toString("base64"));
    expect(second).toBe(first);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(pdfCacheStats().entries).toBe(1);
  });

  it("collapses concurrent misses for the same URL into one download", async () => {
    const spy = stubFetch("facit");

    const results = await Promise.all([
      fetchPdfAsBase64("https://example.test/b.pdf"),
      fetchPdfAsBase64("https://example.test/b.pdf"),
      fetchPdfAsBase64("https://example.test/b.pdf"),
    ]);

    expect(new Set(results).size).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("keeps distinct URLs separate", async () => {
    stubFetch("shared");

    await fetchPdfAsBase64("https://example.test/c.pdf");
    await fetchPdfAsBase64("https://example.test/d.pdf");

    expect(pdfCacheStats().entries).toBe(2);
  });

  it("does not cache a failed response and retries on the next call", async () => {
    const failing = stubFetch("", false);
    expect(await fetchPdfAsBase64("https://example.test/e.pdf")).toBeNull();
    expect(pdfCacheStats().entries).toBe(0);

    const succeeding = stubFetch("recovered");
    expect(await fetchPdfAsBase64("https://example.test/e.pdf")).toBe(
      Buffer.from("recovered").toString("base64"),
    );
    expect(failing).toHaveBeenCalledTimes(1);
    expect(succeeding).toHaveBeenCalledTimes(1);
  });

  it("does not cache a network error", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    expect(await fetchPdfAsBase64("https://example.test/f.pdf")).toBeNull();
    expect(pdfCacheStats().entries).toBe(0);
  });
});
