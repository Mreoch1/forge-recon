ALTER TABLE public.wo_photos
  ADD COLUMN IF NOT EXISTS document_type TEXT NOT NULL DEFAULT 'field_attachment';

ALTER TABLE public.wo_photos
  DROP CONSTRAINT IF EXISTS wo_photos_document_type_check;

ALTER TABLE public.wo_photos
  ADD CONSTRAINT wo_photos_document_type_check
  CHECK (document_type IN ('field_attachment', 'signed_proposal'));

CREATE INDEX IF NOT EXISTS idx_wo_photos_signed_proposals
  ON public.wo_photos (work_order_id, created_at DESC)
  WHERE document_type = 'signed_proposal';

COMMENT ON COLUMN public.wo_photos.document_type IS
  'field_attachment is visible to assigned workers; signed_proposal is restricted to Forge admins by server routes.';
