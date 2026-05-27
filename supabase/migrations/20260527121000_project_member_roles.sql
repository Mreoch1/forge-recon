-- Align project member roles with the current Forge project access model.
-- Drop the legacy CHECK first so existing values can be backfilled.

ALTER TABLE public.job_members
  DROP CONSTRAINT IF EXISTS job_members_role_check;

UPDATE public.job_members
SET role = CASE role
  WHEN 'owner' THEN 'admin'
  WHEN 'manager' THEN 'admin'
  WHEN 'member' THEN 'superintendent'
  WHEN 'contractor' THEN 'superintendent'
  ELSE role
END
WHERE role IN ('owner', 'manager', 'member', 'contractor');

ALTER TABLE public.job_members
  ADD CONSTRAINT job_members_role_check
  CHECK (role IN ('superintendent', 'accountant', 'admin'));
