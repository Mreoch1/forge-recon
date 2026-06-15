ALTER TABLE public.rfp_line_items
  ADD COLUMN IF NOT EXISTS scope_type TEXT NOT NULL DEFAULT 'contractor';

ALTER TABLE public.rfp_line_items
  DROP CONSTRAINT IF EXISTS rfp_line_items_scope_type_check;

ALTER TABLE public.rfp_line_items
  ADD CONSTRAINT rfp_line_items_scope_type_check
  CHECK (scope_type IN ('contractor', 'supplier'));

ALTER TABLE public.project_material_items
  ADD COLUMN IF NOT EXISTS rfp_line_item_id BIGINT REFERENCES public.rfp_line_items(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS rfp_parent_line_item_id BIGINT REFERENCES public.rfp_line_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS unit TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS needed_by DATE,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'planned';

ALTER TABLE public.project_material_items
  DROP CONSTRAINT IF EXISTS project_material_items_source_check;

ALTER TABLE public.project_material_items
  ADD CONSTRAINT project_material_items_source_check
  CHECK (source IN ('manual', 'rfp'));

ALTER TABLE public.project_material_items
  DROP CONSTRAINT IF EXISTS project_material_items_status_check;

ALTER TABLE public.project_material_items
  ADD CONSTRAINT project_material_items_status_check
  CHECK (status IN ('planned', 'quoted', 'ordered', 'received', 'cancelled'));

CREATE INDEX IF NOT EXISTS rfp_line_items_scope_type_idx
  ON public.rfp_line_items(scope_type);

CREATE INDEX IF NOT EXISTS project_material_items_rfp_line_item_id_idx
  ON public.project_material_items(rfp_line_item_id);

CREATE UNIQUE INDEX IF NOT EXISTS project_material_items_rfp_line_item_id_key
  ON public.project_material_items(rfp_line_item_id)
  WHERE rfp_line_item_id IS NOT NULL;
