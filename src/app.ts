import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { cors } from "hono/cors";
import { supabaseMiddleware } from "~/db/supabase";
import chat from "~/api/v1/chat.routes";
import quiz from "~/api/v1/quiz.route";
import { fail } from "~/utils/response";

const app = new Hono().basePath("/api");

app.use(
  cors({
    origin: ["http://localhost:5173", "http://localhost:3000", "https://liutentor.se"],
  }),
);

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
