-- 017: Add file metadata columns to wo_photos to support general file uploads (not just photos)
-- Adds mime_type, size_bytes, and original_filename for non-image file support.

ALTER TABLE wo_photos ADD COLUMN IF NOT EXISTS mime_type TEXT;
ALTER TABLE wo_photos ADD COLUMN IF NOT EXISTS size_bytes BIGINT;
ALTER TABLE wo_photos ADD COLUMN IF NOT EXISTS original_filename TEXT;
