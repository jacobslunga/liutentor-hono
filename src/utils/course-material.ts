import OpenAI, { toFile } from "openai";
import { HTTPException } from "hono/http-exception";
import { supabase } from "~/db/supabase";

/**
 * Lecture material for study courses: PDFs kept in the `study-materials`
 * bucket and indexed in one OpenAI vector store per course, which chats in the
 * course search with `file_search`.
 */

export const MATERIAL_BUCKET = "study-materials";
/** Total size of all PDFs in one course. */
export const COURSE_QUOTA_BYTES = 100 * 1024 * 1024;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

export interface StudyCourse {
  id: string;
  user_id: string;
  name: string;
  vector_store_id: string | null;
}

export interface CourseFileRow {
  id: string;
  course_id: string;
  name: string;
  size_bytes: number;
  storage_path: string;
  openai_file_id: string | null;
  status: "processing" | "ready" | "failed";
  error: string | null;
  created_at: string;
}

const FILE_COLUMNS =
  "id, course_id, name, size_bytes, storage_path, openai_file_id, status, error, created_at";

/** The course, if it exists and belongs to `userId`; otherwise 404/403. */
export async function getOwnedCourse(
  courseId: string,
  userId: string,
): Promise<StudyCourse> {
  const { data, error } = await supabase
    .from("study_courses")
    .select("id, user_id, name, vector_store_id")
    .eq("id", courseId)
    .maybeSingle();
  if (error) throw new HTTPException(500, { message: error.message });
  if (!data) throw new HTTPException(404, { message: "Kursen finns inte" });
  if (data.user_id !== userId) {
    throw new HTTPException(403, { message: "Inte din kurs" });
  }
  return data;
}

export async function listCourseFiles(
  courseId: string,
): Promise<CourseFileRow[]> {
  const { data, error } = await supabase
    .from("study_course_files")
    .select(FILE_COLUMNS)
    .eq("course_id", courseId)
    .order("created_at", { ascending: false });
  if (error) throw new HTTPException(500, { message: error.message });
  return data ?? [];
}

/** The course's vector store, created on first use. */
async function ensureVectorStore(course: StudyCourse): Promise<string> {
  if (course.vector_store_id) return course.vector_store_id;
  const store = await openai.vectorStores.create({
    name: `study-course:${course.id}`,
    metadata: { course_id: course.id, user_id: course.user_id },
  });
  const { error } = await supabase
    .from("study_courses")
    .update({ vector_store_id: store.id, updated_at: new Date().toISOString() })
    .eq("id", course.id);
  if (error) {
    // Don't leave a store behind that nothing points to.
    await openai.vectorStores.delete(store.id).catch(() => {});
    throw new HTTPException(500, { message: error.message });
  }
  course.vector_store_id = store.id;
  return store.id;
}

/**
 * Indexes a PDF the browser already put in Storage. The row starts as
 * `processing`; `refreshProcessingFiles` moves it on once OpenAI is done.
 */
export async function addCourseFile(
  course: StudyCourse,
  storagePath: string,
  name: string,
): Promise<CourseFileRow> {
  // Paths are <user_id>/<course_id>/<file>.pdf; anything else is not ours to read.
  const [owner, courseFolder] = storagePath.split("/");
  if (owner !== course.user_id || courseFolder !== course.id) {
    throw new HTTPException(403, { message: "Ogiltig filsökväg" });
  }

  const { data: blob, error: downloadError } = await supabase.storage
    .from(MATERIAL_BUCKET)
    .download(storagePath);
  if (downloadError || !blob) {
    throw new HTTPException(400, { message: "Filen hittades inte" });
  }

  const removeUpload = () =>
    supabase.storage.from(MATERIAL_BUCKET).remove([storagePath]);

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const isPdf =
    bytes.length > 4 &&
    String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-";
  if (!isPdf) {
    await removeUpload();
    throw new HTTPException(400, { message: "Bara PDF-filer stöds" });
  }

  const used = (await listCourseFiles(course.id)).reduce(
    (sum, f) => sum + Number(f.size_bytes),
    0,
  );
  if (used + bytes.length > COURSE_QUOTA_BYTES) {
    await removeUpload();
    throw new HTTPException(413, {
      message: "Kursen har inte plats för filen (max 100 MB per kurs)",
    });
  }

  let openaiFileId: string | null = null;
  try {
    const vectorStoreId = await ensureVectorStore(course);
    // The display name doubles as the filename citations carry.
    const file = await openai.files.create({
      file: await toFile(bytes, name, { type: "application/pdf" }),
      purpose: "assistants",
    });
    openaiFileId = file.id;
    await openai.vectorStores.files.create(vectorStoreId, { file_id: file.id });
  } catch (error) {
    if (openaiFileId) await openai.files.delete(openaiFileId).catch(() => {});
    await removeUpload();
    if (error instanceof HTTPException) throw error;
    console.error("Course material indexing error:", error);
    throw new HTTPException(502, { message: "Kunde inte läsa in filen" });
  }

  const { data, error } = await supabase
    .from("study_course_files")
    .insert({
      course_id: course.id,
      user_id: course.user_id,
      name,
      size_bytes: bytes.length,
      storage_path: storagePath,
      openai_file_id: openaiFileId,
      status: "processing",
    })
    .select(FILE_COLUMNS)
    .single();
  if (error) throw new HTTPException(500, { message: error.message });
  return data;
}

/** Asks OpenAI about files still indexing and records the outcome. */
export async function refreshProcessingFiles(
  course: StudyCourse,
  files: CourseFileRow[],
): Promise<CourseFileRow[]> {
  const vectorStoreId = course.vector_store_id;
  if (!vectorStoreId) return files;

  return Promise.all(
    files.map(async (file) => {
      if (file.status !== "processing" || !file.openai_file_id) return file;
      try {
        const indexed = await openai.vectorStores.files.retrieve(
          file.openai_file_id,
          { vector_store_id: vectorStoreId },
        );
        if (indexed.status === "in_progress") return file;
        const status = indexed.status === "completed" ? "ready" : "failed";
        const error =
          status === "failed"
            ? indexed.last_error?.message || "Kunde inte läsa in filen"
            : null;
        await supabase
          .from("study_course_files")
          .update({ status, error })
          .eq("id", file.id);
        return { ...file, status, error };
      } catch (error) {
        console.error("Course material status error:", error);
        return file;
      }
    }),
  );
}

/** Removes one file everywhere it lives. Missing pieces are not an error. */
export async function deleteCourseFile(
  course: StudyCourse,
  file: CourseFileRow,
): Promise<void> {
  if (file.openai_file_id) {
    if (course.vector_store_id) {
      await openai.vectorStores.files
        .delete(file.openai_file_id, { vector_store_id: course.vector_store_id })
        .catch(() => {});
    }
    await openai.files.delete(file.openai_file_id).catch(() => {});
  }
  await supabase.storage.from(MATERIAL_BUCKET).remove([file.storage_path]);
  const { error } = await supabase
    .from("study_course_files")
    .delete()
    .eq("id", file.id);
  if (error) throw new HTTPException(500, { message: error.message });
}

/**
 * Deletes a course with everything hanging off it: material, vector store,
 * chats and their logs.
 */
export async function deleteCourse(course: StudyCourse): Promise<void> {
  const files = await listCourseFiles(course.id);
  for (const file of files) await deleteCourseFile(course, file);
  if (course.vector_store_id) {
    await openai.vectorStores.delete(course.vector_store_id).catch(() => {});
  }

  const { data: chats } = await supabase
    .from("conversations")
    .select("id")
    .eq("course_id", course.id);
  const chatIds = (chats ?? []).map((c) => c.id);
  if (chatIds.length) {
    const { error } = await supabase
      .from("ai_chat_logs")
      .delete()
      .in("conversation_id", chatIds);
    if (error) throw new HTTPException(500, { message: error.message });
  }

  // Conversations go with the course (on delete cascade).
  const { error } = await supabase
    .from("study_courses")
    .delete()
    .eq("id", course.id);
  if (error) throw new HTTPException(500, { message: error.message });
}

/** What a chat inside the course may search. */
export async function courseChatContext(
  courseId: string,
  userId: string,
): Promise<{ name: string; vectorStoreId: string | null }> {
  const course = await getOwnedCourse(courseId, userId);
  if (!course.vector_store_id) return { name: course.name, vectorStoreId: null };
  // Files still indexing count too: the store only ever returns what is done.
  const { count } = await supabase
    .from("study_course_files")
    .select("id", { count: "exact", head: true })
    .eq("course_id", courseId)
    .neq("status", "failed");
  return {
    name: course.name,
    vectorStoreId: count ? course.vector_store_id : null,
  };
}
