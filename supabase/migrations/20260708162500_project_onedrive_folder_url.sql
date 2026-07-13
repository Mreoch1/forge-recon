ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS onedrive_folder_url TEXT;
