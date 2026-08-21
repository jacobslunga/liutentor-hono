import { afterEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import {
  rateLimitBlockCounts,
  rateLimitByIdentity,
  resetRateLimitBlockCounts,
} from "../src/utils/rate.limit";

const realWarn = console.warn;
afterEach(() => {
  console.warn = realWarn;
  resetRateLimitBlockCounts();
});

function app(max: number, name: string) {
  const a = new Hono();
  a.use(rateLimitByIdentity({ windowMs: 60_000, max, name }));
  a.get("/", (c) => c.text("ok"));
  return a;
}

const hit = (a: Hono, headers: Record<string, string>) =>
  a.request("/", { headers });

describe("identity rate limit", () => {
  it("allows up to the limit then returns 429 with Retry-After", async () => {
    const a = app(3, "t1");
    const h = { "x-anonymous-user-id": "anon-1" };
    for (let i = 0; i < 3; i++) expect((await hit(a, h)).status).toBe(200);

    const blocked = await hit(a, h);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("counts each identity separately, so one student cannot block another", async () => {
    const a = app(2, "t2");
    const shared = { "x-forwarded-for": "10.0.0.1" };
    for (let i = 0; i < 2; i++)
      await hit(a, { ...shared, "x-anonymous-user-id": "anon-a" });

    expect((await hit(a, { ...shared, "x-anonymous-user-id": "anon-a" })).status).toBe(429);
    // Same NAT address, different student: unaffected.
    expect((await hit(a, { ...shared, "x-anonymous-user-id": "anon-b" })).status).toBe(200);
  });

  it("prefers the auth token over the anonymous id", async () => {
    const a = app(1, "t3");
    const authed = { Authorization: "Bearer tok-1", "x-anonymous-user-id": "anon-x" };
    expect((await hit(a, authed)).status).toBe(200);
    expect((await hit(a, authed)).status).toBe(429);

    // Same anon id, different account: separate bucket.
    expect((await hit(a, { Authorization: "Bearer tok-2", "x-anonymous-user-id": "anon-x" })).status).toBe(200);
  });

  it("falls back to IP when the request carries no identity", async () => {
    const a = app(1, "t4");
    expect((await hit(a, { "x-forwarded-for": "10.0.0.9" })).status).toBe(200);
    expect((await hit(a, { "x-forwarded-for": "10.0.0.9" })).status).toBe(429);
    expect((await hit(a, { "x-forwarded-for": "10.0.0.10" })).status).toBe(200);
  });

  it("keeps separate buckets per limiter name", async () => {
    const chat = app(1, "chat");
    const quiz = app(1, "quiz");
    const h = { "x-anonymous-user-id": "anon-2" };
    expect((await hit(chat, h)).status).toBe(200);
    expect((await hit(quiz, h)).status).toBe(200);
  });

  it("logs a structured line for every block, with a running total", async () => {
    const lines: any[] = [];
    console.warn = mock((line: string) => lines.push(JSON.parse(line)));

    const a = app(1, "chat");
    const h = { "x-anonymous-user-id": "anon-log" };
    await hit(a, h);
    await hit(a, h);
    await hit(a, h);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      event: "rate_limit_exceeded",
      limiter: "chat",
      identity: "anon:anon-log",
      max: 1,
      blockedSinceBoot: 1,
    });
    expect(lines[0].retryAfter).toBeGreaterThan(0);
    expect(lines[1].blockedSinceBoot).toBe(2);
    expect(rateLimitBlockCounts()).toEqual({ chat: 2 });
  });

  it("never puts a raw bearer token in the log", async () => {
    const lines: any[] = [];
    console.warn = mock((line: string) => lines.push(JSON.parse(line)));

    const a = app(1, "chat");
    const h = { Authorization: "Bearer super-secret-token" };
    await hit(a, h);
    await hit(a, h);

    expect(lines).toHaveLength(1);
    expect(lines[0].identity).toStartWith("auth:");
    expect(JSON.stringify(lines[0])).not.toContain("super-secret-token");
  });
});
