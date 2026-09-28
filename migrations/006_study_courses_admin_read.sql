-- Admin read access to study courses.
--
-- The admin app (admin-liutentor) reads with the anon key and the admin's own
-- session, so it only sees rows a policy lets that session see. Migration 004
-- limited study courses, their files and the lecture PDFs to their owner; this
-- adds read-only access for the admin account, matching the allowlist in
-- admin-liutentor/src/lib/admin.ts. Nothing here allows writes.

create policy "study_courses admin select" on public.study_courses
  for select using ((auth.jwt() ->> 'email') = 'jacobslunga21@yahoo.se');

create policy "study_course_files admin select" on public.study_course_files
  for select using ((auth.jwt() ->> 'email') = 'jacobslunga21@yahoo.se');

-- Lets the admin app open the PDFs through signed links.
create policy "study-materials admin select" on storage.objects
  for select using (
    bucket_id = 'study-materials'
    and (auth.jwt() ->> 'email') = 'jacobslunga21@yahoo.se'
  );
