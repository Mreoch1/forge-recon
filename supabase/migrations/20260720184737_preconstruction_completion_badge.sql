alter table public.jobs
  add column if not exists preconstruction_completed_at timestamptz;

comment on column public.jobs.preconstruction_completed_at is
  'Permanent milestone earned when a project leaves pre-construction for in progress.';

-- Existing field and completed projects have already passed the pre-construction
-- handoff, so award the milestone immediately on rollout.
update public.jobs
set preconstruction_completed_at = coalesce(updated_at, now())
where preconstruction_completed_at is null
  and status in ('in_progress', 'complete');
