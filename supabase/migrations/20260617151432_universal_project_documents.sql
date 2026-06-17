begin;

create table if not exists public.universal_document_templates (
  id bigserial primary key,
  title text not null,
  slug text not null unique,
  category text not null default 'general',
  description text,
  version text not null default '1.0',
  is_active boolean not null default true,
  body text not null default '',
  merge_fields jsonb not null default '[]'::jsonb,
  signature_required boolean not null default false,
  internal_only boolean not null default false,
  contractor_facing boolean not null default true,
  project_facing boolean not null default true,
  created_by bigint references public.users(id) on delete set null,
  updated_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.preconstruction_document_types (
  id bigserial primary key,
  name text not null,
  slug text not null unique,
  description text,
  default_required boolean not null default false,
  default_template_id bigint references public.universal_document_templates(id) on delete set null,
  sort_order integer not null default 100,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.generated_documents (
  id bigserial primary key,
  template_id bigint references public.universal_document_templates(id) on delete set null,
  project_id bigint references public.jobs(id) on delete set null,
  contractor_id bigint references public.contractors(id) on delete set null,
  vendor_id bigint references public.vendors(id) on delete set null,
  project_rfp_id bigint references public.project_rfps(id) on delete set null,
  title text not null,
  status text not null default 'generated',
  scope_name text,
  sent_to_email text,
  body_snapshot text not null default '',
  merge_data jsonb not null default '{}'::jsonb,
  storage_bucket text not null default 'entity-files',
  storage_key text,
  pdf_filename text,
  created_by bigint references public.users(id) on delete set null,
  updated_by bigint references public.users(id) on delete set null,
  sent_at timestamptz,
  viewed_at timestamptz,
  signed_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint generated_documents_status_check check (status in ('draft','generated','sent','viewed','signed','completed','expired','cancelled'))
);

create table if not exists public.preconstruction_document_requirements (
  id bigserial primary key,
  project_id bigint not null references public.jobs(id) on delete cascade,
  contractor_id bigint references public.contractors(id) on delete set null,
  vendor_id bigint references public.vendors(id) on delete set null,
  project_rfp_id bigint references public.project_rfps(id) on delete cascade,
  document_type_id bigint references public.preconstruction_document_types(id) on delete set null,
  generated_document_id bigint references public.generated_documents(id) on delete set null,
  scope_name text,
  trade text,
  status text not null default 'required',
  due_date date,
  sent_at timestamptz,
  returned_at timestamptz,
  uploaded_at timestamptz,
  completed_at timestamptz,
  waived_at timestamptz,
  waiver_reason text,
  rejection_reason text,
  notes text,
  created_by bigint references public.users(id) on delete set null,
  updated_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint preconstruction_document_requirements_status_check check (status in ('not_started','required','generated','sent','returned','uploaded','complete','rejected','expired','waived'))
);

create table if not exists public.document_events (
  id bigserial primary key,
  generated_document_id bigint references public.generated_documents(id) on delete cascade,
  requirement_id bigint references public.preconstruction_document_requirements(id) on delete cascade,
  event_type text not null,
  note text,
  metadata jsonb not null default '{}'::jsonb,
  created_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.document_attachments (
  id bigserial primary key,
  generated_document_id bigint references public.generated_documents(id) on delete cascade,
  requirement_id bigint references public.preconstruction_document_requirements(id) on delete cascade,
  project_id bigint references public.jobs(id) on delete cascade,
  contractor_id bigint references public.contractors(id) on delete set null,
  vendor_id bigint references public.vendors(id) on delete set null,
  storage_bucket text not null default 'entity-files',
  storage_key text not null,
  filename text not null,
  mime_type text,
  size_bytes bigint,
  attachment_type text not null default 'signed_document',
  uploaded_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.scope_release_logs (
  id bigserial primary key,
  project_id bigint not null references public.jobs(id) on delete cascade,
  contractor_id bigint references public.contractors(id) on delete set null,
  vendor_id bigint references public.vendors(id) on delete set null,
  project_rfp_id bigint references public.project_rfps(id) on delete set null,
  status text not null,
  note text,
  missing_requirements jsonb not null default '[]'::jsonb,
  created_by bigint references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint scope_release_logs_status_check check (status in ('blocked','released'))
);

create index if not exists universal_document_templates_category_idx on public.universal_document_templates(category);
create index if not exists generated_documents_project_idx on public.generated_documents(project_id);
create index if not exists generated_documents_contractor_idx on public.generated_documents(contractor_id);
create index if not exists generated_documents_vendor_idx on public.generated_documents(vendor_id);
create index if not exists generated_documents_status_idx on public.generated_documents(status);
create index if not exists preconstruction_requirements_project_idx on public.preconstruction_document_requirements(project_id);
create index if not exists preconstruction_requirements_contractor_idx on public.preconstruction_document_requirements(contractor_id);
create index if not exists preconstruction_requirements_vendor_idx on public.preconstruction_document_requirements(vendor_id);
create index if not exists preconstruction_requirements_rfp_idx on public.preconstruction_document_requirements(project_rfp_id);
create index if not exists document_events_generated_document_idx on public.document_events(generated_document_id);
create index if not exists document_events_requirement_idx on public.document_events(requirement_id);
create index if not exists document_attachments_generated_document_idx on public.document_attachments(generated_document_id);
create index if not exists document_attachments_requirement_idx on public.document_attachments(requirement_id);
create index if not exists scope_release_logs_project_idx on public.scope_release_logs(project_id);

alter table public.universal_document_templates enable row level security;
alter table public.preconstruction_document_types enable row level security;
alter table public.generated_documents enable row level security;
alter table public.preconstruction_document_requirements enable row level security;
alter table public.document_events enable row level security;
alter table public.document_attachments enable row level security;
alter table public.scope_release_logs enable row level security;

drop policy if exists "universal_document_templates service role all" on public.universal_document_templates;
create policy "universal_document_templates service role all" on public.universal_document_templates for all to service_role using (true) with check (true);
drop policy if exists "preconstruction_document_types service role all" on public.preconstruction_document_types;
create policy "preconstruction_document_types service role all" on public.preconstruction_document_types for all to service_role using (true) with check (true);
drop policy if exists "generated_documents service role all" on public.generated_documents;
create policy "generated_documents service role all" on public.generated_documents for all to service_role using (true) with check (true);
drop policy if exists "preconstruction_document_requirements service role all" on public.preconstruction_document_requirements;
create policy "preconstruction_document_requirements service role all" on public.preconstruction_document_requirements for all to service_role using (true) with check (true);
drop policy if exists "document_events service role all" on public.document_events;
create policy "document_events service role all" on public.document_events for all to service_role using (true) with check (true);
drop policy if exists "document_attachments service role all" on public.document_attachments;
create policy "document_attachments service role all" on public.document_attachments for all to service_role using (true) with check (true);
drop policy if exists "scope_release_logs service role all" on public.scope_release_logs;
create policy "scope_release_logs service role all" on public.scope_release_logs for all to service_role using (true) with check (true);

revoke all privileges on table public.universal_document_templates from anon, authenticated;
revoke all privileges on table public.preconstruction_document_types from anon, authenticated;
revoke all privileges on table public.generated_documents from anon, authenticated;
revoke all privileges on table public.preconstruction_document_requirements from anon, authenticated;
revoke all privileges on table public.document_events from anon, authenticated;
revoke all privileges on table public.document_attachments from anon, authenticated;
revoke all privileges on table public.scope_release_logs from anon, authenticated;
grant all privileges on table public.universal_document_templates to service_role;
grant all privileges on table public.preconstruction_document_types to service_role;
grant all privileges on table public.generated_documents to service_role;
grant all privileges on table public.preconstruction_document_requirements to service_role;
grant all privileges on table public.document_events to service_role;
grant all privileges on table public.document_attachments to service_role;
grant all privileges on table public.scope_release_logs to service_role;
grant all privileges on all sequences in schema public to service_role;

insert into public.universal_document_templates
  (title, slug, category, description, version, body, merge_fields, signature_required, contractor_facing, project_facing)
values
  (
    'Subcontractor Bid Participation and Non-Circumvention Agreement',
    'subcontractor-bid-participation-non-circumvention',
    'preconstruction',
    'Required acknowledgment before Recon releases sensitive bid packages, contacts, scope, or drawings.',
    '1.0',
    'This Subcontractor Bid Participation and Non-Circumvention Agreement is entered into between Recon Enterprises Inc. and {{ contractor.name }} for {{ project.title }}.\n\nRecon may provide project opportunities, bid packages, scopes of work, drawings, specifications, walkthrough information, schedules, GC contacts, owner contacts, pricing requests, and related project information. Contractor agrees all such information is confidential and may only be used for bidding or performing work through Recon Enterprises Inc.\n\nContractor agrees not to bypass Recon Enterprises Inc., submit direct pricing, or accept direct award for the same project or scope from any owner, GC, construction manager, property manager, or project contact introduced through Recon without Recon''s prior written approval.\n\nIf contacted directly regarding a Recon-introduced project, Contractor agrees to notify Recon and route all pricing, revisions, questions, and project communication back through Recon.\n\nContractor understands that Recon may require a signed Subcontractor Bid Participation and Non-Circumvention Agreement before releasing future bid packages, drawings, scopes, or project details.\n\nProject: {{ project.title }}\nScope / Trade: {{ scope.name }}\nContractor: {{ contractor.name }}\nDate: {{ current.date }}\n\nContractor signature: ________________________________  Date: ________________\nRecon signature: _____________________________________  Date: ________________',
    '["contractor.name","project.title","scope.name","current.date"]'::jsonb,
    true,
    true,
    true
  ),
  (
    'Vendor Intake Form',
    'vendor-intake-form',
    'intake',
    'Simple contractor/vendor profile used to qualify trades and suppliers.',
    '1.0',
    'Company: {{ contractor.name }}\nPrimary contact: {{ contractor.email }} {{ contractor.phone }}\nTrade / service type: {{ contractor.trade }}\nService area: {{ contractor.service_area }}\n\nPlease provide company ownership, mailing address, insurance status, licensing, bonding capacity, employee count, union/non-union status, prevailing wage experience, Section 3 / HUD / MSHDA experience, occupied multifamily renovation experience, largest completed projects, and references with notes.\n\nRecon internal notes: {{ internal.notes }}',
    '["contractor.name","contractor.email","contractor.phone","contractor.trade","contractor.service_area","internal.notes"]'::jsonb,
    false,
    true,
    false
  ),
  (
    'Insurance Requirements Sheet',
    'insurance-requirements-sheet',
    'preconstruction',
    'Insurance requirements for subcontractors and vendors.',
    '1.0',
    'Project: {{ project.title }}\nContractor: {{ contractor.name }}\n\nBefore work starts, provide current certificates for general liability, workers compensation, automobile liability, umbrella/excess liability when required, and any project-specific endorsements. Recon Enterprises Inc. and project-required entities must be listed as additional insured where required. Certificates must remain current through the full scope of work.\n\nSubmit updated certificates before expiration. Work may be held until compliant insurance documents are received and approved.',
    '["project.title","contractor.name"]'::jsonb,
    false,
    true,
    true
  ),
  (
    'Bid Instructions to Subcontractors',
    'bid-instructions-to-subcontractors',
    'bid',
    'Instructions for bid pricing, RFIs, addenda, inclusions, and exclusions.',
    '1.0',
    'Project: {{ project.title }}\nScope / Trade: {{ scope.name }}\n\nReview all provided drawings, specifications, addenda, site notes, alternates, schedules, and scope descriptions before pricing. Include labor, materials, equipment, supervision, layout, cleanup, protection, permits if assigned, freight, taxes, and all work reasonably required for a complete scope unless clearly excluded.\n\nSubmit RFIs through Recon. Do not contact the GC, owner, property manager, residents, or project contacts directly unless Recon authorizes it in writing.\n\nBids must identify exclusions, clarifications, alternates, unit prices, lead times, and schedule concerns.',
    '["project.title","scope.name"]'::jsonb,
    false,
    true,
    true
  ),
  (
    'Subcontractor Bid Proposal Template',
    'subcontractor-bid-proposal-template',
    'bid',
    'Bid proposal template for subcontractor pricing.',
    '1.0',
    'Project: {{ project.title }}\nContractor: {{ contractor.name }}\nScope / Trade: {{ scope.name }}\n\nBase bid amount: ____________________\nIncluded scope:\n- \n\nExcluded scope:\n- \n\nAlternates / unit prices:\n- \n\nLead time / schedule notes:\n- \n\nWarranty / closeout notes:\n- \n\nSubmitted by: ____________________ Date: ________________',
    '["project.title","contractor.name","scope.name"]'::jsonb,
    true,
    true,
    true
  ),
  (
    'Subcontract Agreement Template',
    'subcontract-agreement-template',
    'contract',
    'Short-form subcontract agreement shell for awarded work.',
    '1.0',
    'This Subcontract Agreement is between Recon Enterprises Inc. and {{ contractor.name }} for {{ project.title }}.\n\nScope: {{ scope.name }}\nContract amount: {{ contract.amount }}\nSchedule: {{ project.schedule }}\n\nContractor shall furnish all labor, materials, equipment, supervision, insurance, safety compliance, cleanup, and closeout required for the assigned scope. Changes must be authorized in writing before proceeding. Payment is conditioned upon approved work, proper invoices, lien waivers, and required closeout documents.\n\nContractor signature: ________________________________ Date: ________________\nRecon signature: _____________________________________ Date: ________________',
    '["contractor.name","project.title","scope.name","contract.amount","project.schedule"]'::jsonb,
    true,
    true,
    true
  ),
  (
    'Change Order Request Form',
    'change-order-request-form',
    'field',
    'Contractor request form for scope, cost, or schedule changes.',
    '1.0',
    'Project: {{ project.title }}\nContractor: {{ contractor.name }}\nCOR #: __________\nDate: {{ current.date }}\n\nDescription of change:\n\nReason / source:\n\nLabor: __________\nMaterials: __________\nEquipment: __________\nSubcontractor cost: __________\nRequested time extension: __________ days\n\nNo work is authorized until Recon issues written approval.',
    '["project.title","contractor.name","current.date"]'::jsonb,
    true,
    true,
    true
  ),
  (
    'Lien Waiver Template',
    'lien-waiver-template',
    'payment',
    'Conditional lien waiver template tied to payment.',
    '1.0',
    'Project: {{ project.title }}\nContractor: {{ contractor.name }}\nPayment amount: {{ payment.amount }}\nThrough date: {{ payment.through_date }}\n\nUpon receipt and clearance of the payment described above, Contractor waives lien rights for labor, materials, equipment, and services furnished through the through date, except for unpaid retention, pending change orders, or disputed amounts listed here:\n\nExceptions: ___________________________________________\n\nAuthorized signature: ________________________________ Date: ________________',
    '["project.title","contractor.name","payment.amount","payment.through_date"]'::jsonb,
    true,
    true,
    true
  ),
  (
    'Site Rules and Conduct Policy',
    'site-rules-and-conduct-policy',
    'field',
    'Occupied multifamily site conduct, safety, communication, and cleanup requirements.',
    '1.0',
    'Project: {{ project.title }}\nContractor: {{ contractor.name }}\n\nWorkers must follow project hours, check-in requirements, PPE rules, resident interaction rules, parking/loading restrictions, daily cleanup expectations, smoking/substance restrictions, access control, noise limits, and safety requirements. Direct tenant, owner, GC, or property staff communication is not allowed unless authorized by Recon.\n\nViolations may result in removal from the site or termination of work authorization.\n\nAcknowledged by: ________________________________ Date: ________________',
    '["project.title","contractor.name"]'::jsonb,
    true,
    true,
    true
  ),
  (
    'Subcontractor Startup Checklist',
    'subcontractor-startup-checklist',
    'preconstruction',
    'Checklist for startup documents, insurance, contacts, schedule, submittals, and manpower.',
    '1.0',
    'Project: {{ project.title }}\nContractor: {{ contractor.name }}\nScope / Trade: {{ scope.name }}\n\nStartup checklist:\n[ ] Signed agreement / bid participation documents\n[ ] W-9\n[ ] Certificate of insurance\n[ ] License / certifications when required\n[ ] Project contact list\n[ ] Schedule and manpower plan\n[ ] Submittals / product data\n[ ] Safety plan / site rules acknowledged\n[ ] Closeout expectations reviewed\n[ ] First day access and parking confirmed',
    '["project.title","contractor.name","scope.name"]'::jsonb,
    false,
    true,
    true
  )
on conflict (slug) do update set
  title = excluded.title,
  category = excluded.category,
  description = excluded.description,
  body = excluded.body,
  merge_fields = excluded.merge_fields,
  signature_required = excluded.signature_required,
  contractor_facing = excluded.contractor_facing,
  project_facing = excluded.project_facing,
  updated_at = now();

insert into public.universal_document_templates (title, slug, category, description, version, body, merge_fields, signature_required, contractor_facing, project_facing)
values
  ('Confidentiality Agreement','confidentiality-agreement','preconstruction','Optional confidentiality document before releasing sensitive information.','1.0','Confidentiality agreement for {{ project.title }} and {{ contractor.name }}. Details to be completed by Recon before release.','["project.title","contractor.name"]'::jsonb,true,true,true),
  ('W-9 Request','w-9-request','preconstruction','Request for contractor/vendor W-9.','1.0','Please provide a current W-9 for {{ contractor.name }} before payment setup.','["contractor.name"]'::jsonb,false,true,false),
  ('Certificate of Insurance Request','certificate-of-insurance-request','preconstruction','Request for current COI.','1.0','Please provide a current certificate of insurance for {{ contractor.name }} and {{ project.title }}.','["contractor.name","project.title"]'::jsonb,false,true,true),
  ('License Request','license-request','preconstruction','Request for trade license or registration.','1.0','Please provide applicable licenses or registrations for {{ contractor.name }}.','["contractor.name"]'::jsonb,false,true,false),
  ('Prequalification Form','prequalification-form','preconstruction','Contractor prequalification form.','1.0','Prequalification form for {{ contractor.name }}. Recon will review capacity, references, safety, insurance, and experience.','["contractor.name"]'::jsonb,false,true,false),
  ('Scope Clarification Log','scope-clarification-log','bid','Scope clarification tracker.','1.0','Project: {{ project.title }}\nScope: {{ scope.name }}\nClarifications and exclusions:', '["project.title","scope.name"]'::jsonb,false,true,true),
  ('RFI Cover Sheet','rfi-cover-sheet','bid','RFI cover sheet.','1.0','Project: {{ project.title }}\nRFI questions for {{ scope.name }}:', '["project.title","scope.name"]'::jsonb,false,true,true),
  ('Submittal Cover Sheet','submittal-cover-sheet','field','Submittal cover sheet.','1.0','Project: {{ project.title }}\nContractor: {{ contractor.name }}\nSubmittal package:', '["project.title","contractor.name"]'::jsonb,false,true,true),
  ('Daily Work Authorization','daily-work-authorization','field','Daily work authorization form.','1.0','Project: {{ project.title }}\nAuthorized work/date/manpower:', '["project.title"]'::jsonb,true,true,true),
  ('Punch List Form','punch-list-form','closeout','Punch list tracker.','1.0','Project: {{ project.title }}\nContractor: {{ contractor.name }}\nPunch items:', '["project.title","contractor.name"]'::jsonb,false,true,true),
  ('Closeout Checklist','closeout-checklist','closeout','Closeout checklist.','1.0','Project: {{ project.title }}\nContractor closeout items for {{ contractor.name }}:', '["project.title","contractor.name"]'::jsonb,false,true,true),
  ('Warranty Letter Template','warranty-letter-template','closeout','Warranty letter template.','1.0','Warranty letter for {{ project.title }} and {{ contractor.name }}.', '["project.title","contractor.name"]'::jsonb,true,true,true),
  ('Material Submittal Request','material-submittal-request','materials','Material submittal request.','1.0','Please submit material data for {{ scope.name }} on {{ project.title }}.', '["scope.name","project.title"]'::jsonb,false,true,true),
  ('Material Delivery Notice','material-delivery-notice','materials','Material delivery notice.','1.0','Delivery notice for {{ project.title }}.', '["project.title"]'::jsonb,false,true,true),
  ('Safety Acknowledgment','safety-acknowledgment','field','Safety acknowledgment.','1.0','Contractor acknowledges project safety requirements for {{ project.title }}.', '["project.title"]'::jsonb,true,true,true),
  ('Resident Notification Template','resident-notification-template','field','Resident notification draft.','1.0','Resident notice for scheduled work at {{ project.title }}.', '["project.title"]'::jsonb,false,false,true),
  ('Access Request Form','access-request-form','field','Access request form.','1.0','Access request for {{ project.title }}.', '["project.title"]'::jsonb,false,true,true),
  ('Schedule Commitment Form','schedule-commitment-form','field','Schedule commitment form.','1.0','Contractor schedule commitment for {{ project.title }}.', '["project.title"]'::jsonb,true,true,true),
  ('Manpower Plan','manpower-plan','field','Manpower plan form.','1.0','Manpower plan for {{ contractor.name }} on {{ project.title }}.', '["contractor.name","project.title"]'::jsonb,false,true,true),
  ('Meeting Sign-In Sheet','meeting-sign-in-sheet','field','Meeting sign-in sheet.','1.0','Meeting sign-in for {{ project.title }}.', '["project.title"]'::jsonb,false,true,true),
  ('Notice to Proceed','notice-to-proceed','contract','Notice to proceed.','1.0','Recon authorizes {{ contractor.name }} to proceed on {{ project.title }} subject to signed contract requirements.', '["contractor.name","project.title"]'::jsonb,true,true,true),
  ('Payment Application Cover','payment-application-cover','payment','Payment application cover sheet.','1.0','Payment application cover for {{ contractor.name }} on {{ project.title }}.', '["contractor.name","project.title"]'::jsonb,false,true,true),
  ('Stored Materials Affidavit','stored-materials-affidavit','payment','Stored materials affidavit.','1.0','Stored materials affidavit for {{ project.title }}.', '["project.title"]'::jsonb,true,true,true),
  ('Final Waiver Request','final-waiver-request','payment','Final waiver request.','1.0','Final waiver request for {{ contractor.name }} on {{ project.title }}.', '["contractor.name","project.title"]'::jsonb,true,true,true),
  ('Contractor Evaluation Form','contractor-evaluation-form','closeout','Internal contractor evaluation.','1.0','Internal evaluation for {{ contractor.name }} on {{ project.title }}.', '["contractor.name","project.title"]'::jsonb,false,false,true)
on conflict (slug) do nothing;

insert into public.preconstruction_document_types (name, slug, description, default_required, default_template_id, sort_order)
select 'Subcontractor Bid Participation and Non-Circumvention Agreement',
       'bid-participation-non-circumvention',
       'Required before releasing scope, drawings, contacts, or sensitive bid information.',
       true,
       id,
       10
from public.universal_document_templates
where slug = 'subcontractor-bid-participation-non-circumvention'
on conflict (slug) do update set
  default_required = excluded.default_required,
  default_template_id = excluded.default_template_id,
  description = excluded.description,
  sort_order = excluded.sort_order,
  updated_at = now();

insert into public.preconstruction_document_types (name, slug, description, default_required, default_template_id, sort_order)
select values_table.name, values_table.slug, values_table.description, values_table.default_required, t.id, values_table.sort_order
from (
  values
    ('Confidentiality Agreement','confidentiality-agreement','Optional confidentiality agreement.',false,'confidentiality-agreement',20),
    ('Insurance Requirements Acknowledgment','insurance-requirements-acknowledgment','Insurance requirements acknowledgment.',false,'insurance-requirements-sheet',30),
    ('W-9','w-9','Current W-9 on file.',false,'w-9-request',40),
    ('Certificate of Insurance','certificate-of-insurance','Current certificate of insurance on file.',false,'certificate-of-insurance-request',50),
    ('License','license','Trade license or registration on file.',false,'license-request',60),
    ('Prequalification','prequalification','Prequalification information complete.',false,'prequalification-form',70)
) as values_table(name, slug, description, default_required, template_slug, sort_order)
left join public.universal_document_templates t on t.slug = values_table.template_slug
on conflict (slug) do update set
  name = excluded.name,
  description = excluded.description,
  default_required = excluded.default_required,
  default_template_id = excluded.default_template_id,
  sort_order = excluded.sort_order,
  updated_at = now();

commit;
