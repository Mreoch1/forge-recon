CREATE TABLE IF NOT EXISTS public.project_chat_message_reads (
  id BIGSERIAL PRIMARY KEY,
  message_id BIGINT NOT NULL REFERENCES public.project_chat_messages(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(message_id, user_id)
);

ALTER TABLE public.project_chat_message_reads ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_project_chat_message_reads_message
  ON public.project_chat_message_reads(message_id, seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_chat_message_reads_user
  ON public.project_chat_message_reads(user_id, seen_at DESC);
