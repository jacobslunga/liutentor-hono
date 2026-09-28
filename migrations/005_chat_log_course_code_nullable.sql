-- Learning-chat turns without a course.
--
-- A turn in the learning chat (/chatt) only has a course code when the student
-- mentioned one ("@TATA41"). With course_code NOT NULL, every other turn failed
-- to log: neither the question nor the answer was saved, so reopening the chat
-- showed it empty. Exam turns always carry a code and are unaffected.
alter table public.ai_chat_logs
  alter column course_code drop not null;
