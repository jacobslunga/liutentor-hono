import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import { LRUCache } from "lru-cache";
import { supabaseMiddleware } from "~/db/supabase";
import chat from "~/api/v1/chat.routes";
import quiz from "~/api/v1/quiz.route";
import { fail } from "~/utils/response";

const WINDOW_MS = 60_000; // 1 minute
const MAX_REQUESTS = 60;  // per IP per window

const rateLimitStore = new LRUCache<string, { count: number; resetAt: number }>({
  max: 10_000,
  ttl: WINDOW_MS,
});

const app = new Hono().basePath("/api");

app.use(
  cors({
    origin: ["http://localhost:5173", "http://localhost:3000", "https://liutentor.se"],
  }),
);

app.use(async (c, next) => {
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0].trim() ??
    c.req.header("x-real-ip") ??
    "unknown";

  const now = Date.now();
  const entry = rateLimitStore.get(ip);

  if (!entry || now >= entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return next();
  }

  if (entry.count >= MAX_REQUESTS) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    c.header("Retry-After", String(retryAfter));
    return c.json(fail("Too many requests"), 429);
  }

  entry.count += 1;
  return next();
});

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json(fail(err.message), err.status);
  }

  console.error(err);

  return c.json(fail("Internal server error"), 500);
});

app.use(supabaseMiddleware);

app.route("/", chat);
app.route("/", quiz);

export default {
  port: process.env.PORT || 3000,
  fetch: app.fetch,
  idleTimeout: 120,
};
