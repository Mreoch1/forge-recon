ALTER TABLE public.project_chat_messages
  ADD COLUMN IF NOT EXISTS attachment_bucket TEXT,
  ADD COLUMN IF NOT EXISTS attachment_key TEXT,
  ADD COLUMN IF NOT EXISTS attachment_mime_type TEXT,
  ADD COLUMN IF NOT EXISTS attachment_original_name TEXT,
  ADD COLUMN IF NOT EXISTS attachment_size_bytes BIGINT;
