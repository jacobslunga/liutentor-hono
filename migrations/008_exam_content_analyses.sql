-- Server-only cache of public exam question outlines. No client can write or
-- read directly; course-wide chat access is explicitly enabled per message.
create table if not exists public.exam_content_analyses (
  exam_id bigint primary key references public.exams (id) on delete cascade,
  pdf_url text not null,
  version integer not null,
  analysis jsonb not null,
  model text not null,
  analysed_at timestamptz not null default now()
);
alter table public.exam_content_analyses enable row level security;
revoke all on public.exam_content_analyses from anon, authenticated;
grant all on public.exam_content_analyses to service_role;

alter table public.ai_chat_logs
  add column if not exists course_exams_requested boolean not null default false,
  add column if not exists course_exam_context jsonb;
