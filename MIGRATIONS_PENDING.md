# Pending migrations — apply via Supabase SQL editor (or MCP)

## d174_other_trade_fields — custom trade name/desc on intake form (2026-06-09)

```sql
-- D-174: Custom "other" trade name and description on the contractor/vendor intake form.
-- When "other" is selected from the trade checkboxes, the user can type their own
-- trade/service type and optionally add a description.

ALTER TABLE contractor_vendor_intakes
  ADD COLUMN IF NOT EXISTS other_trade_name TEXT,
  ADD COLUMN IF NOT EXISTS other_trade_description TEXT;
```

## 006-estimate-statuses — estimate status CHECK constraint (2026-05-21)

**Status:** Code deployed; DB constraint still needs applying on `zquzmavbpiaboouffqhm`.

Also wired into PG boot migrations in `src/app.js` (runs on prod cold start when `POSTGRES_*` env vars are set).
One-shot script: `node scripts/migrate-estimate-statuses.js` (requires `POSTGRES_PASSWORD`).

```sql
ALTER TABLE estimates DROP CONSTRAINT IF EXISTS estimates_status_check;
ALTER TABLE estimates ADD CONSTRAINT estimates_status_check
  CHECK (status IN ('new','draft','sent','pending','approved','accepted','rejected','expired'));
```

## d069_wo_status — WO status field OPEN/SCHEDULED/CLOSED (2026-05-14)

```sql
-- D-069 Phase 1: Work Order status field with OPEN, SCHEDULED, CLOSED values.
-- The `status` column already exists. This migration updates the CHECK constraint
-- to include the new values and sets a sensible default.

-- 1. Drop existing CHECK constraint (name varies — find it first)
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT con.conname INTO constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'work_orders'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) LIKE '%status%';
  
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE work_orders DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

-- 2. Add new CHECK with OPEN/SCHEDULED/CLOSED + existing values
ALTER TABLE work_orders ADD CONSTRAINT work_orders_status_check
  CHECK (status = ANY (ARRAY['open', 'scheduled', 'in_progress', 'closed', 'complete', 'cancelled', 'on_hold', 'estimating']));

-- 3. Set default to OPEN for new WOs
ALTER TABLE work_orders ALTER COLUMN status SET DEFAULT 'open';

-- 4. Backfill any NULL statuses to 'open'
UPDATE work_orders SET status = 'open' WHERE status IS NULL;
```

## d066_tutorial_session — tutorial sessions persistence table (2026-05-14)

```sql
-- D-066: Tutorial session state persistence.
-- Server-side state machine stores per-session progress here.

CREATE TABLE IF NOT EXISTS tutorial_sessions (
  id text PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state_json jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tutorial_sessions_user_id ON tutorial_sessions(user_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS completed_tutorial_at timestamptz;

ALTER TABLE customers ADD COLUMN IF NOT EXISTS tutorial_session_id text REFERENCES tutorial_sessions(id) ON DELETE SET NULL;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS tutorial_session_id text REFERENCES tutorial_sessions(id) ON DELETE SET NULL;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS tutorial_session_id text REFERENCES tutorial_sessions(id) ON DELETE SET NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tutorial_session_id text REFERENCES tutorial_sessions(id) ON DELETE SET NULL;
ALTER TABLE project_payments ADD COLUMN IF NOT EXISTS tutorial_session_id text REFERENCES tutorial_sessions(id) ON DELETE SET NULL;
```

## d066_tutorial_events — telemetry table for tutorial funnels (2026-05-14)

```sql
-- D-066: Tutorial telemetry events for funnel analysis.
-- Tracks: tutorial_started, chapter_started, chapter_completed, etc.

CREATE TABLE IF NOT EXISTS tutorial_events (
  id bigserial PRIMARY KEY,
  tutorial_session_id text NOT NULL REFERENCES tutorial_sessions(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN (
    'tutorial_started', 'chapter_started', 'chapter_completed',
    'chapter_skipped', 'exit_at_chapter', 'quiz_submitted',
    'quiz_score', 'cleanup_chosen', 'keep_chosen', 'total_duration_seconds'
  )),
  event_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tutorial_events_session ON tutorial_events(tutorial_session_id);
CREATE INDEX IF NOT EXISTS idx_tutorial_events_type ON tutorial_events(event_type);

-- D-066: Weak spots column on users for targeted remediation hints
ALTER TABLE users ADD COLUMN IF NOT EXISTS tutorial_completion_weak_spots jsonb;
```

## d125_unit_number — unit/apt number on estimates (2026-05-15)

```sql
-- D-125: Add unit_number column to estimates for unit/apt number display on
-- estimate PDFs and show pages. Backfill from the linked work order.
-- After applying this migration, run the backfill below to populate existing records.

ALTER TABLE estimates ADD COLUMN unit_number text;

-- Backfill: Copy unit_number from the linked work_order where estimate.unit_number IS NULL
UPDATE estimates e
SET unit_number = wo.unit_number
FROM work_orders wo
WHERE e.wo_id = wo.id
  AND e.unit_number IS NULL
  AND wo.unit_number IS NOT NULL;
```
