import type { Context, Next } from "hono";
import { LRUCache } from "lru-cache";
import { fail } from "~/utils/response";

/**
 * Per-identity throttle for the LLM-backed routes.
 *
 * Deliberately keyed on identity rather than IP. Campus wifi puts many students
 * behind one NAT address, so an IP-shaped limit tight enough to matter for one
 * abuser would throttle a whole lecture hall. Identity keys cost an abuser
 * nothing to rotate — the IP limit in app.ts stays as the floor for that — but
 * they make the common case correct, which IP limiting cannot.
 */
export interface RateLimitOptions {
  windowMs: number;
  max: number;
  name: string;
}

/** Shortens a bearer token into a key so raw tokens are not held in memory. */
function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function identify(c: Context): string {
  const auth = c.req.header("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    if (token) return `auth:${fingerprint(token)}`;
  }

  const anon = c.req.header("x-anonymous-user-id");
  if (anon) return `anon:${anon}`;

  return `ip:${
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "unknown"
  }`;
}

/**
 * Cumulative blocks per limiter since boot. Emitted on every 429 so a log search
 * shows both the individual events and whether the rate of them is climbing —
 * the signal for whether a limit is set too tight for real students.
 */
const blockedTotals = new Map<string, number>();

export function rateLimitBlockCounts(): Record<string, number> {
  return Object.fromEntries(blockedTotals);
}

/** Test seam. */
export function resetRateLimitBlockCounts() {
  blockedTotals.clear();
}

export function logRateLimitBlock(params: {
  limiter: string;
  identity: string;
  max: number;
  windowMs: number;
  retryAfter: number;
  path: string;
}) {
  const total = (blockedTotals.get(params.limiter) ?? 0) + 1;
  blockedTotals.set(params.limiter, total);
  console.warn(
    JSON.stringify({
      event: "rate_limit_exceeded",
      ...params,
      blockedSinceBoot: total,
    }),
  );
}

export function rateLimitByIdentity({ windowMs, max, name }: RateLimitOptions) {
  const store = new LRUCache<string, { count: number; resetAt: number }>({
    max: 20_000,
    ttl: windowMs,
  });

  return async (c: Context, next: Next) => {
    const key = `${name}:${identify(c)}`;
    const now = Date.now();
    const entry = store.get(key);

    if (!entry || now >= entry.resetAt) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (entry.count >= max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      logRateLimitBlock({
        limiter: name,
        identity: key.slice(name.length + 1),
        max,
        windowMs,
        retryAfter,
        path: c.req.path,
      });
      c.header("Retry-After", String(retryAfter));
      return c.json(
        fail("Du har skickat för många frågor. Vänta en stund och försök igen."),
        429,
      );
    }

    entry.count += 1;
    return next();
  };
}
