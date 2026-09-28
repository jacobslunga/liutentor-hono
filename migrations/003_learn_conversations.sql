-- Learning chats: a conversation that is not tied to an exam.
--
-- The exam panel and the standalone chat (/chatt in the app) each have their
-- own history, so a conversation needs to say which one it belongs to. Every
-- row written before this column existed came from the exam panel, which is
-- what the default backfills.
--
-- Text rather than an enum, matching `skill` and `difficulty`: the app only
-- ever writes the two known values, and an enum would turn the next kind
-- (course spaces, projects) into a migration.
alter table public.conversations
  add column if not exists kind text not null default 'exam';

create index if not exists conversations_user_kind_created_idx
  on public.conversations (user_id, kind, created_at desc);

-- A learning turn has no exam behind it, so its log rows carry no exam id.
alter table public.ai_chat_logs
  alter column exam_id drop not null;
