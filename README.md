# LiUTentor API

A REST API built with Bun and Hono for serving exam data from Swedish universities. The API provides endpoints to fetch exams, solutions, and statistics for university courses.

## Architecture

```
liutentor-api/
├── src/
│   ├── app.ts                      # Application entry point and middleware setup
│   ├── api/
│   │   ├── v1/
│   │   │   └── exams.routes.ts     # Route handlers for exam endpoints
│   │   └── services/
│   │       └── exams.service.ts    # Business logic for exam operations
│   ├── db/
│   │   └── supabase.ts             # Supabase client and middleware
│   ├── middleware/
│   │   └── ratelimit.ts            # IP-based rate limiting middleware
│   └── utils/
│       ├── ratelimit.ts            # Upstash Redis rate limiter configuration
│       └── response.ts             # Standardized API response helpers
├── types/
│   ├── api.ts                      # API response type definitions
│   ├── exams.ts                    # Exam-related type definitions
│   └── hono.d.ts                   # Hono context type augmentation
├── tests/
│   ├── exams.service.test.ts       # Unit tests for exam service
│   └── routes.test.ts              # Integration tests for routes
├── package.json
└── tsconfig.json
```

### Components

**Hono Framework**: Lightweight web framework optimized for edge computing and serverless environments.

**Supabase**: PostgreSQL database backend. The API uses three main tables:

- `exams`: Stores exam metadata (course code, date, PDF URL, university)
- `solutions`: Stores exam solutions linked to exams
- `exam_stats`: Stores statistics like pass rates per exam date

**Upstash Redis**: Serverless Redis used for rate limiting. Configured with a sliding window algorithm allowing 200 requests per minute per IP address.

### Request Flow

1. Request arrives at Hono router
2. Supabase middleware injects database client into context
3. Rate limiting middleware checks request count for IP (applies to `/v1/exams/*` routes)
4. Route handler processes request using service layer
5. Service layer queries Supabase and returns data
6. Response is formatted using standardized response helpers

### Error Handling

All errors are caught by a global error handler that returns consistent JSON responses:

```json
{
  "success": false,
  "message": "Error description",
  "payload": null
}
```

HTTP exceptions return their appropriate status codes. Unknown errors return 500 Internal Server Error.

## Prerequisites

- [Bun](https://bun.sh) runtime (v1.0 or later)
- Supabase account with configured database
- Upstash Redis account for rate limiting

## Environment Variables

Create a `.env` file in the project root:

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-key
UPSTASH_REDIS_REST_URL=https://your-redis.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-redis-token
OPENAI_API_KEY=your-openai-api-key
```

## Installation

```sh
bun install
```

## Running the Server

Development mode with hot reload:

```sh
bun run dev
```

The server starts on http://localhost:3000 by default.

## Running Tests

```sh
bun test
```

Tests use Bun's built-in test runner with mocked Supabase clients to avoid external dependencies.

## API Endpoints

All endpoints are prefixed with `/api`.

### Get Exams for Course

```
GET /api/v1/exams/:university/:courseCode
```

Returns all exams for a specific course at a university.

**Parameters:**

- `university`: One of `LIU`, `KTH`, `CTH`, `LTH`
- `courseCode`: Course code (e.g., `TDDD27`)

**Response:**

```json
{
  "success": true,
  "message": "Exams fetched successfully",
  "payload": {
    "courseCode": "TDDD27",
    "courseName": "Webprogrammering",
    "exams": [
      {
        "id": 1,
        "course_code": "TDDD27",
        "exam_date": "2023-01-15",
        "pdf_url": "https://example.com/exam.pdf",
        "exam_name": "Tenta 2023-01",
        "has_solution": true,
        "statistics": { "mean": 15.5 },
        "pass_rate": 0.72
      }
    ]
  }
}
```

Note: If statistics cannot be fetched, exams are still returned without statistics data.

### Get Single Exam

```
GET /api/v1/exams/:examId
```

Returns a single exam by ID with its solution if available.

**Parameters:**

- `examId`: Numeric exam ID

**Response:**

```json
{
  "success": true,
  "message": "Exam fetched successfully",
  "payload": {
    "exam": {
      "id": 1,
      "course_code": "TDDD27",
      "exam_date": "2023-01-15",
      "pdf_url": "https://example.com/exam.pdf"
    },
    "solution": {
      "id": 1,
      "exam_id": 1,
      "solution_url": "https://example.com/solution.pdf"
    }
  }
}
```

## Error Responses

**400 Bad Request**: Invalid parameters (missing course code, invalid university, non-numeric exam ID)

**404 Not Found**: No exams found for the course or exam ID does not exist

**429 Too Many Requests**: Rate limit exceeded (200 requests per minute per IP)

**500 Internal Server Error**: Database or server error

## Database Schema

### exams table

| Column      | Type    | Description                     |
| ----------- | ------- | ------------------------------- |
| id          | integer | Primary key                     |
| course_code | text    | Course code (e.g., TDDD27)      |
| university  | text    | University code (LIU, KTH, etc) |
| exam_date   | date    | Date of the exam                |
| pdf_url     | text    | URL to exam PDF                 |
| exam_name   | text    | Display name for the exam       |

### solutions table

| Column       | Type    | Description          |
| ------------ | ------- | -------------------- |
| id           | integer | Primary key          |
| exam_id      | integer | Foreign key to exams |
| pdf_url | text    | URL to solution PDF  |

### exam_stats table

| Column          | Type    | Description                 |
| --------------- | ------- | --------------------------- |
| course_code     | text    | Course code                 |
| exam_date       | date    | Exam date                   |
| statistics      | jsonb   | Statistics data (mean, etc) |
| pass_rate       | decimal | Pass rate (0.0 - 1.0)       |
| course_name_swe | text    | Swedish course name         |

## License

Private project.
