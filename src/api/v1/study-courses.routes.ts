import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { timeout } from "hono/timeout";
import { z } from "zod";
import { getAuthenticatedUserId } from "~/utils/auth";
import {
  addCourseFile,
  deleteCourse,
  deleteCourseFile,
  getOwnedCourse,
  listCourseFiles,
  refreshProcessingFiles,
  type CourseFileRow,
} from "~/utils/course-material";
import { rateLimitByIdentity } from "~/utils/rate.limit";
import { success } from "~/utils/response";

/**
 * Study courses: the material side. Creating and renaming a course happens in
 * the app through RLS; everything that touches OpenAI or the quota is here.
 */
const courses = new Hono().basePath("/v1/study-courses");

const courseParam = z.object({ courseId: z.uuid() });
const fileParam = z.object({ courseId: z.uuid(), fileId: z.uuid() });
const addFileBody = z.object({
  storagePath: z.string().min(1).max(500),
  name: z.string().trim().min(1).max(200),
});

async function requireUser(c: Context): Promise<string> {
  const userId = await getAuthenticatedUserId(c.req.header("Authorization"));
  if (!userId) {
    throw new HTTPException(401, { message: "Logga in för att använda kurser" });
  }
  return userId;
}

/** What the app sees of a file: no storage or OpenAI internals. */
function toClientFile(file: CourseFileRow) {
  return {
    id: file.id,
    name: file.name,
    sizeBytes: Number(file.size_bytes),
    status: file.status,
    error: file.error,
    createdAt: file.created_at,
  };
}

courses.get(
  "/:courseId/files",
  zValidator("param", courseParam),
  async (c) => {
    const userId = await requireUser(c);
    const course = await getOwnedCourse(c.req.valid("param").courseId, userId);
    const files = await refreshProcessingFiles(
      course,
      await listCourseFiles(course.id),
    );
    return c.json(success(files.map(toClientFile)));
  },
);

courses.post(
  "/:courseId/files",
  rateLimitByIdentity({ windowMs: 60_000, max: 20, name: "course-files" }),
  zValidator("param", courseParam),
  zValidator("json", addFileBody),
  timeout(120_000),
  async (c) => {
    const userId = await requireUser(c);
    const course = await getOwnedCourse(c.req.valid("param").courseId, userId);
    const { storagePath, name } = c.req.valid("json");
    const file = await addCourseFile(course, storagePath, name);
    return c.json(success(toClientFile(file)), 201);
  },
);

courses.delete(
  "/:courseId/files/:fileId",
  zValidator("param", fileParam),
  async (c) => {
    const userId = await requireUser(c);
    const { courseId, fileId } = c.req.valid("param");
    const course = await getOwnedCourse(courseId, userId);
    const file = (await listCourseFiles(course.id)).find((f) => f.id === fileId);
    if (!file) throw new HTTPException(404, { message: "Filen finns inte" });
    await deleteCourseFile(course, file);
    return c.json(success(null));
  },
);

courses.delete(
  "/:courseId",
  zValidator("param", courseParam),
  timeout(120_000),
  async (c) => {
    const userId = await requireUser(c);
    const course = await getOwnedCourse(c.req.valid("param").courseId, userId);
    await deleteCourse(course);
    return c.json(success(null));
  },
);

export default courses;
