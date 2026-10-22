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

Chat requests use multipart form data with a JSON `payload` field and optional `files` attachments. Chat accepts PDF, JPEG, PNG, WebP, and GIF attachments, up to five files, 5 MB each, and 20 MB total. Send `Accept: text/event-stream` for chat events; otherwise the response is streamed plain text. Quiz responses use server-sent events. Quiz generation uses Gemini 3.1 Flash-Lite with medium thinking and the existing `GEMINI_API_KEY`.

Authenticated requests use `Authorization: Bearer <token>`. Anonymous chat and quiz requests can provide `x-anonymous-user-id`. Study-course endpoints and private conversations require authentication, as does the `high` effort level.

Rate limits use in-memory counters: 60 requests per minute per IP globally, 12 chat requests per minute per identity, five quiz requests per minute per identity, and 20 course-file additions per minute per identity.

## Course-wide exam context

Apply `migrations/008_exam_content_analyses.sql` before enabling the updated frontend. It adds a server-only cache and chat usage fields. The exam chat accepts `courseExams: true` in its payload. Omitted or false means no course lookup, extraction, or course context is added. The React checkbox applies to the next manually sent message and resets after sending; quoted-question shortcuts remain ordinary exam questions. Earlier answers remain in conversation history, but subsequent ordinary turns do not refresh course-wide evidence.

This is a deterministic opt-in context loader, rather than a model-selected function call: when enabled, the server retrieves all distinct public LiU exam PDFs for the supplied course code. It reuses persisted question outlines, analyses at most four missing PDFs per message with two concurrent workers and a 30-second deadline per PDF, then gives the selected chat model the outlines and topic evidence. All three chat providers use this path. No background extraction happens on ordinary messages. A changed PDF URL or analysis format version invalidates the cached outline; replacing a PDF at the same URL requires removing its cache row to reanalyse it.

Cold courses therefore have partial coverage until indexed. The answer must disclose the number included, missing exams, and any records omitted by the 120,000-character evidence budget (including topic counts). PDF downloads are limited to 10 MB. Unreadable, oversized, timed-out, and invalid extraction results are excluded. Failures are cached for 15 minutes before retrying, so broken PDFs do not repeatedly consume the budget and prevent older exams from being processed. Frequencies count distinct exam IDs; classifications are AI-generated and are not verified syllabus coverage or predictions. Identical PDF URLs are counted once. Solutions are not indexed, so they cannot double the exam count.

Prewarm a course before releasing the feature for it (this makes paid model calls for uncached PDFs):

```sh
bun run analyse-course-exams TATA41
# Optional model ID: uses that provider's configured API key.
bun run analyse-course-exams TATA41 gemini-3.1-flash-lite
```

The command processes all missing exams with two workers, allows 120 seconds per PDF, and exits with status 1 if any remain unanalysed. Re-running resumes from successful cache entries, respecting the 15-minute failure backoff. No new environment variables are required. Run it again after new exams are imported; the chat can also incrementally fill the cache on opted-in messages.

`ai_chat_logs.course_exams_requested` records opt-ins on both user and assistant rows. Assistant `course_exam_context` records the total, analysed count, included exam IDs, missing IDs, and extraction version (or `error: unavailable`). API logs also emit the coverage. If retrieval fails, normal selected-exam chat still works and the model is instructed to report course analysis as unavailable.

## License

Private project.
