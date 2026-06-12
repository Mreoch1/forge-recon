ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS password_update_prompt_seen_at TIMESTAMPTZ;
