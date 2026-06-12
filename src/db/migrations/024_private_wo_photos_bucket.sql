-- 024: Make work-order attachment storage private
--
-- Work-order photos/files can include customer addresses, signed notices,
-- scope notes, and other operational records. The app serves them through
-- server-generated signed URLs, so the bucket itself should not be public.

UPDATE storage.buckets
SET public = false
WHERE id = 'wo-photos';
