-- Migration 006: Add new estimate statuses (new, pending, approved)
-- Changes the CHECK constraint on estimates.status to include:
--   new, draft, sent, pending, approved, accepted, rejected, expired

ALTER TABLE estimates DROP CONSTRAINT IF EXISTS estimates_status_check;

ALTER TABLE estimates ADD CONSTRAINT estimates_status_check
  CHECK (status IN ('new','draft','sent','pending','approved','accepted','rejected','expired'));
