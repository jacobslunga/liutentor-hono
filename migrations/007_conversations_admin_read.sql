-- Admin read access to chats.
--
-- The admin app reads with the admin's own session. Conversations were only
-- readable by their owner, so the Kurser page (and the user lookup on the chat
-- log page) saw no chats from anyone else. Read-only, same allowlist as 006.
-- Dropped first so the file can be rerun.

drop policy if exists "conversations admin select" on public.conversations;
create policy "conversations admin select" on public.conversations
  for select using ((auth.jwt() ->> 'email') = 'jacobslunga21@yahoo.se');

-- The messages of those chats. An existing admin policy on this table is fine
-- alongside this one: select policies are combined with OR.
drop policy if exists "ai_chat_logs admin select" on public.ai_chat_logs;
create policy "ai_chat_logs admin select" on public.ai_chat_logs
  for select using ((auth.jwt() ->> 'email') = 'jacobslunga21@yahoo.se');
