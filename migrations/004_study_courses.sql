-- Study courses: free-form spaces in the learning chat (/chatt) where a
-- signed-in student collects lecture PDFs and chats with them as context.
--
-- The PDFs live in the private `study-materials` bucket and are indexed in one
-- OpenAI vector store per course, created on the first upload. The app reads
-- and creates courses directly (RLS below); files are only ever written by the
-- API, which holds the OpenAI key and enforces the per-course quota.

create table if not exists public.study_courses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  vector_store_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists study_courses_user_created_idx
  on public.study_courses (user_id, created_at desc);

alter table public.study_courses enable row level security;

create policy "study_courses owner select" on public.study_courses
  for select using (auth.uid() = user_id);
create policy "study_courses owner insert" on public.study_courses
  for insert with check (auth.uid() = user_id);
create policy "study_courses owner update" on public.study_courses
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "study_courses owner delete" on public.study_courses
  for delete using (auth.uid() = user_id);

-- Status follows the file through indexing: the API inserts it as
-- `processing` once OpenAI has it, and flips it to `ready` or `failed` when the
-- vector store reports back. Text rather than an enum, like `kind`.
create table if not exists public.study_course_files (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.study_courses (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  size_bytes bigint not null check (size_bytes > 0),
  storage_path text not null,
  openai_file_id text,
  status text not null default 'processing',
  error text,
  created_at timestamptz not null default now()
);

create index if not exists study_course_files_course_idx
  on public.study_course_files (course_id, created_at desc);
create index if not exists study_course_files_openai_idx
  on public.study_course_files (openai_file_id);

alter table public.study_course_files enable row level security;

-- Read-only for the owner; every write goes through the API (service role).
create policy "study_course_files owner select" on public.study_course_files
  for select using (auth.uid() = user_id);

-- A chat inside a course. Deleting the course takes its chats with it.
alter table public.conversations
  add column if not exists course_id uuid
    references public.study_courses (id) on delete cascade;

create index if not exists conversations_user_course_created_idx
  on public.conversations (user_id, course_id, created_at desc);

-- The sources an assistant turn cited (web pages or course files), so the
-- chips under an answer survive a reload. Null for turns without sources and
-- for everything logged before this column existed.
alter table public.ai_chat_logs
  add column if not exists sources jsonb;

-- Private bucket for the lecture PDFs, one folder per user:
-- <user_id>/<course_id>/<file>.pdf
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('study-materials', 'study-materials', false, 104857600, array['application/pdf'])
on conflict (id) do nothing;

create policy "study-materials owner insert" on storage.objects
  for insert with check (
    bucket_id = 'study-materials'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "study-materials owner select" on storage.objects
  for select using (
    bucket_id = 'study-materials'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "study-materials owner delete" on storage.objects
  for delete using (
    bucket_id = 'study-materials'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
