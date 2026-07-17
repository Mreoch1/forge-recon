create index if not exists idx_project_submittal_packets_created_by
  on public.project_submittal_packets(created_by_user_id);

create index if not exists idx_project_submittal_packets_updated_by
  on public.project_submittal_packets(updated_by_user_id);

create index if not exists idx_project_submittal_items_created_by
  on public.project_submittal_items(created_by_user_id);

create index if not exists idx_project_submittal_files_created_by
  on public.project_submittal_files(created_by_user_id);
