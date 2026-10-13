# LiUTentor API

Bun and Hono backend for exam chat, learning chat, quiz generation, and study-course material. Supabase stores conversations, generation logs, and course files; Chat models are Claude Haiku 5.5 (Anthropic), Luna (OpenAI), and Gemini 3.1 Flash-Lite (Google); OpenAI also indexes uploaded course material, so learn chats that use that material always answer with Luna.

## Setup

Create a `.env` file with:

```dotenv
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-key
OPENAI_API_KEY=your-openai-api-key
ANTHROPIC_API_KEY=your-anthropic-api-key
GEMINI_API_KEY=your-gemini-api-key
PORT=3001
```

Install dependencies and start development:

```sh
bun install
bun run dev
```

The server defaults to http://localhost:3001. Use `bun run start` to run without hot reload, `bun run build` to bundle the app, and `bun test` to run the test suite. Database migrations are in `migrations/`.

## Endpoints

All paths are prefixed with `/api`.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/v1/chat/completion/:examId` | Chat with an exam and optional solution PDF |
| POST | `/v1/chat/learn` | Learning chat with optional course context and material |
| POST | `/v1/chat/turns/:turnId/cancel` | Cancel a turn owned by the caller |
| POST | `/v1/quiz/multiple-choice/:courseCode` | Generate a quiz from course exams |
| GET | `/v1/study-courses/:courseId/files` | List course files and refresh indexing status |
| POST | `/v1/study-courses/:courseId/files` | Index a PDF uploaded to Supabase storage |
| DELETE | `/v1/study-courses/:courseId/files/:fileId` | Delete a course file |
| DELETE | `/v1/study-courses/:courseId` | Delete a study course and its material |

Chat requests use multipart form data with a JSON `payload` field and optional `files` attachments. Chat accepts PDF, JPEG, PNG, WebP, and GIF attachments, up to five files, 5 MB each, and 20 MB total. Send `Accept: text/event-stream` for chat events; otherwise the response is streamed plain text. Quiz responses use server-sent events.

Authenticated requests use `Authorization: Bearer <token>`. Anonymous chat and quiz requests can provide `x-anonymous-user-id`. Study-course endpoints and private conversations require authentication, as does the `high` effort level.

Rate limits use in-memory counters: 60 requests per minute per IP globally, 12 chat requests per minute per identity, five quiz requests per minute per identity, and 20 course-file additions per minute per identity.

## License

Private project.
