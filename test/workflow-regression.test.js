const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

test('project header starts work orders with project_id', () => {
  const header = read('src/views/jobs/_project_header.ejs');
  assert.match(header, /\/work-orders\/new\?project_id=/);
  assert.doesNotMatch(header, /\/work-orders\/new\?job_id=/);
});

test('bill-created paperwork uses configurable default markup', () => {
  const service = read('src/services/bill-paperwork.js');
  assert.match(service, /default_bill_markup_pct/);
  assert.match(service, /DEFAULT_BILL_MARKUP_PCT/);
});

test('project member form has non-HTMX fallback actions', () => {
  const partial = read('src/views/jobs/_members_list.ejs');
  assert.match(partial, /method="post"\s+action="\/projects\/<%= job\.id %>\/members"/);
  assert.match(partial, /action="\/projects\/<%= job\.id %>\/members\/<%= m\.id %>\/delete"/);
});

test('project subroutes enforce capability checks', () => {
  const routes = read('src/routes/jobs.js');
  assert.match(routes, /requireProjectAccess\(req, res, id, 'billing'\)/);
  assert.match(routes, /requireProjectAccess\(req, res, id, 'operations'\)/);
  assert.match(routes, /requireProjectAccess\(req, res, id, 'manage'\)/);
});

test('managers can access customers but cannot delete them', () => {
  const app = read('src/app.js');
  const customers = read('src/routes/customers.js');
  const header = read('src/views/layouts/header.ejs');

  assert.match(app, /app\.use\('\/customers', requireAuth, requireManager, customersRoutes\)/);
  assert.match(customers, /router\.post\('\/:id\/delete', requireAdmin,/);
  assert.match(header, /_isAdminNav \|\| _isManagerNav[\s\S]*href="\/customers"/);
  assert.match(header, /_isAdminMobile \|\| _isManagerMobile[\s\S]*href="\/customers"/);
});

test('admin navigation starts with dashboard before work orders', () => {
  const header = read('src/views/layouts/header.ejs');
  const desktopNav = header.match(/<div class="hidden lg:flex items-center gap-0" id="desktop-nav">([\s\S]*?)<!-- More dropdown -->/);
  const mobileNav = header.match(/<div class="mobile-menu-heading">Work<\/div>([\s\S]*?)<div class="mobile-menu-heading">Sales<\/div>/);

  assert.ok(desktopNav, 'desktop nav block should exist');
  assert.ok(mobileNav, 'mobile work nav block should exist');
  assert.ok(desktopNav[1].indexOf('>Dashboard</a>') < desktopNav[1].indexOf('>Work Orders</a>'));
  assert.ok(mobileNav[1].indexOf('>Dashboard</a>') < mobileNav[1].indexOf('>Work Orders</a>'));
});

test('managers can manage vendor and contractor records but cannot delete them', () => {
  const app = read('src/app.js');
  const vendors = read('src/routes/vendors.js');
  const contractors = read('src/routes/contractors.js');
  const header = read('src/views/layouts/header.ejs');

  assert.match(app, /app\.use\('\/vendors', requireAuth, requireManager, vendorsRoutes\)/);
  assert.match(app, /app\.use\('\/contractors', requireAuth, requireManager, contractorsRoutes\)/);
  assert.match(vendors, /router\.post\('\/:id\/delete', requireAdmin,/);
  assert.match(contractors, /router\.post\('\/:id\/delete', requireAdmin,/);
  assert.match(header, /_isAdminNav \|\| _isManagerNav[\s\S]*href="\/vendors"/);
  assert.match(header, /_isAdminNav \|\| _isManagerNav[\s\S]*href="\/contractors"/);
  assert.match(header, /_isAdminMobile \|\| _isManagerMobile[\s\S]*href="\/vendors"/);
  assert.match(header, /_isAdminMobile \|\| _isManagerMobile[\s\S]*href="\/contractors"/);
});

test('trade intake has public start form and manager-only directory', () => {
  const app = read('src/app.js');
  const routes = read('src/routes/vendor-intake.js');
  const form = read('src/views/vendor-intake/form.ejs');
  const show = read('src/views/vendor-intake/show.ejs');
  const header = read('src/views/layouts/header.ejs');
  const migration = read('supabase/migrations/20260608110353_contractor_vendor_intake.sql');

  assert.match(app, /const vendorIntakeRoutes = require\('\.\/routes\/vendor-intake'\)/);
  assert.match(app, /app\.use\('\/vendor-intake', vendorIntakeRoutes\)/);
  assert.match(routes, /router\.get\('\/start'/);
  assert.match(routes, /router\.post\('\/start'/);
  assert.match(routes, /router\.get\('\/directory', requireManager,/);
  assert.match(routes, /router\.post\('\/directory\/:id\/notes', requireManager,/);
  assert.match(routes, /router\.post\('\/directory\/:id\/promote', requireManager,/);
  assert.match(routes, /access_token/);
  assert.match(routes, /next_update_due_at/);
  assert.ok(routes.includes('ref_${i}_notes'));
  assert.match(form, /name="ref_<%= i %>_notes"/);
  assert.match(show, /ref\.notes/);
  assert.match(header, /href="\/vendor-intake\/directory"/);
  assert.match(header, /activeNav === 'intake'/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.contractor_vendor_intakes/);
  assert.match(migration, /references_json JSONB NOT NULL DEFAULT '\[\]'::jsonb/);
  assert.match(migration, /ALTER TABLE public\.contractor_vendor_intakes ENABLE ROW LEVEL SECURITY/);
});

test('managers can create and send invoices while admin keeps accounting controls', () => {
  const app = read('src/app.js');
  const estimates = read('src/routes/estimates.js');
  const invoices = read('src/routes/invoices.js');
  const estimateShow = read('src/views/estimates/show.ejs');
  const invoiceShow = read('src/views/invoices/show.ejs');
  const header = read('src/views/layouts/header.ejs');

  assert.match(app, /app\.use\('\/invoices', requireAuth, requireManager, invoicesRoutes\)/);
  assert.match(estimates, /router\.post\('\/:id\/create-invoice', requireManager,/);
  assert.match(estimates, /router\.get\('\/:id\/create-invoice', requireManager,/);
  assert.match(estimates, /router\.post\('\/:id\/generate-invoice', requireManager,/);
  assert.match(estimateShow, /const canManageInvoices = currentUser && \['admin', 'manager'\]\.includes\(currentUser\.role\)/);
  assert.match(estimateShow, /canManageInvoices && !invoice && estimate\.lines\.length > 0/);
  assert.match(invoiceShow, /const isAdmin = currentUser && currentUser\.role === 'admin'/);
  assert.match(invoiceShow, /isAdmin && \(invoice\.status === 'sent' \|\| invoice\.status === 'overdue'\)/);
  assert.match(invoiceShow, /href="\/invoices\/<%= invoice\.id %>\/csv"/);
  assert.match(invoiceShow, /action="\/invoices\/<%= invoice\.id %>\/billing-complete"/);
  assert.match(invoices, /router\.post\('\/:id\/mark-paid', requireAdmin,/);
  assert.match(invoices, /router\.post\('\/:id\/billing-complete', requireAdmin,/);
  assert.match(invoices, /router\.get\('\/:id\/csv'/);
  assert.match(invoices, /router\.post\('\/batch-csv'/);
  assert.doesNotMatch(invoices, /router\.post\('\/:id\/sync-quickbooks'/);
  assert.match(invoices, /router\.post\('\/:id\/reopen-billing', requireAdmin,/);
  assert.match(invoices, /router\.post\('\/:id\/void', requireAdmin,/);
  assert.match(invoices, /router\.post\('\/:id\/delete', requireAdmin,/);
  assert.match(header, /_isAdminNav \|\| _isManagerNav[\s\S]*href="\/invoices"/);
  assert.match(header, /_isAdminMobile \|\| _isManagerMobile[\s\S]*href="\/invoices"/);
});

test('QuickBooks flow uses CSV export instead of live API sync', () => {
  const app = read('src/app.js');
  const accountingIndex = read('src/views/accounting/index.ejs');
  const invoices = read('src/routes/invoices.js');
  const invoiceIndex = read('src/views/invoices/index.ejs');
  const invoiceShow = read('src/views/invoices/show.ejs');

  assert.doesNotMatch(app, /app\.use\('\/quickbooks\/webhook'/);
  assert.doesNotMatch(app, /app\.use\('\/accounting\/quickbooks'/);
  assert.doesNotMatch(accountingIndex, /href: '\/accounting\/quickbooks'/);
  assert.match(invoices, /router\.post\('\/batch-csv'/);
  assert.match(invoices, /router\.get\('\/:id\/csv'/);
  assert.match(invoiceIndex, /formaction="\/invoices\/batch-csv"/);
  assert.match(invoiceShow, /href="\/invoices\/<%= invoice\.id %>\/csv"/);
  assert.match(invoiceShow, /billing-complete/);
});

test('project RFP export loader only selects real project columns', () => {
  const routes = read('src/routes/rfp.js');
  assert.match(routes, /\.from\('jobs'\)\s*\.select\('id, title'\)/);
  assert.doesNotMatch(routes, /\.select\('id, title, name'\)/);
  assert.match(routes, /function exportFilenameBase\(job, fallbackId\)/);
  assert.ok(routes.includes('${exportFilenameBase(data.job, req.params.id)}.pdf'));
  assert.ok(routes.includes('${exportFilenameBase(data.job, req.params.id)}.csv'));
  assert.ok(routes.includes('${exportFilenameBase(data.job, req.params.id)}.xlsx'));
  assert.doesNotMatch(routes, /project-\$\{req\.params\.id\}-rfp/);
});

test('work order row links do not depend on the More menu', () => {
  const header = read('src/views/layouts/header.ejs');
  const workOrderIndex = read('src/views/work-orders/index.ejs');

  const rowLinkScript = header.match(/\(function\(\)\{\s*\/\/ Full-row click for list tables[\s\S]*?\}\)\(\);/);
  assert.ok(rowLinkScript, 'row-link click handler should be in its own script block');
  assert.doesNotMatch(rowLinkScript[0], /moreBtn|moreMenu/);
  assert.match(workOrderIndex, /<a href="\/work-orders\/<%= w\.id %>" class="wol-num/);
  assert.match(workOrderIndex, /<a href="\/work-orders\/<%= w\.id %>" class="wol-customer/);
});

test('managers can edit open work orders and access WO files from show page', () => {
  const show = read('src/views/work-orders/show.ejs');

  assert.match(show, /currentUser && currentUser\.role !== 'worker' && !\['closed', 'complete', 'cancelled'\]\.includes\(wo\.status\)/);
  assert.match(show, /href="\/work-orders\/<%= wo\.id %>\/edit"/);
  assert.match(show, /href="\/files\/work_order\/<%= wo\.id %>"/);
  assert.match(show, /Work order files/);
  assert.match(show, /Open files/);
});

test('RFP edits return users to the open category and line item', () => {
  const routes = read('src/routes/rfp.js');
  const view = read('src/views/jobs/rfp.ejs');

  assert.match(routes, /function rfpRedirect\(jobId, params = \{\}\)/);
  assert.match(routes, /open_rfp: req\.params\.rId/);
  assert.match(routes, /open_item: parent_id \|\| data\?\.id/);
  assert.match(routes, /show_sub_form: parent_id \|\| ''/);
  assert.match(routes, /open_item: item\.parent_line_item_id \|\| req\.params\.itemId/);

  assert.match(view, /id="rfp-row-<%= rfp\.id %>"/);
  assert.match(view, /id="rfp-line-<%= item\.id %>"/);
  assert.match(view, /function restoreRfpPosition\(\)/);
  assert.match(view, /params\.get\('open_rfp'\)/);
  assert.match(view, /params\.get\('open_item'\)/);
  assert.match(view, /params\.get\('show_sub_form'\)/);
});

test('RFP category and parent line-item deletes remove children', () => {
  const routes = read('src/routes/rfp.js');

  assert.match(routes, /from\('rfp_line_items'\)\.delete\(\)\.eq\('rfp_id', req\.params\.rId\)/);
  assert.match(routes, /async function deleteRfpLineItemTree\(itemId, visited = new Set\(\)\)/);
  assert.match(routes, /\.select\('id'\)\s*\.eq\('parent_line_item_id', itemId\)/);
  assert.match(routes, /await deleteRfpLineItemTree\(child\.id, visited\)/);
  assert.match(routes, /\.delete\(\)\s*\.eq\('id', itemId\)/);
  assert.match(routes, /await deleteRfpLineItemTree\(req\.params\.itemId\)/);
});

test('RFP editing autosaves individual fields with conflict checks', () => {
  const routes = read('src/routes/rfp.js');
  const view = read('src/views/jobs/rfp.ejs');
  const migration = read('supabase/migrations/20260609130000_rfp_autosave_updated_at.sql');

  assert.match(routes, /router\.patch\('\/projects\/:id\/rfps\/:rId\/autosave'/);
  assert.match(routes, /router\.patch\('\/projects\/rfps\/items\/:itemId\/autosave'/);
  assert.match(routes, /originalValue/);
  assert.match(routes, /conflict: true/);
  assert.match(routes, /loadRfpItemWithJob\(itemId\)/);

  assert.match(view, /id="rfp-autosave-status"/);
  assert.match(view, /data-rfp-autosave-category/);
  assert.match(view, /data-rfp-autosave-item/);
  assert.match(view, /method: 'PATCH'/);
  assert.doesNotMatch(view, /rfpSaveAll/);
  assert.doesNotMatch(view, /Save All Changes/);
  assert.doesNotMatch(view, /\/projects\/rfps\/items\/bulk-save/);

  assert.match(migration, /ALTER TABLE public\.rfp_line_items\s+ADD COLUMN IF NOT EXISTS updated_at/);
  assert.match(migration, /CREATE TRIGGER set_rfp_line_items_updated_at/);
});

test('customer detail exposes customer projects and project creation path', () => {
  const routes = read('src/routes/customers.js');
  const show = read('src/views/customers/show.ejs');

  assert.match(routes, /\.from\('jobs'\)[\s\S]*\.eq\('customer_id', id\)/);
  assert.match(routes, /projects: projects \|\| \[\]/);
  assert.match(show, /Projects <span[\s\S]*\(projects \|\| \[\]\)\.length/);
  assert.match(show, /href="\/projects\/new\?customer_id=<%= customer\.id %>"/);
  assert.match(show, /data-href="\/projects\/<%= project\.id %>"/);
});

test('new project insert persists all validated project form fields', () => {
  const routes = read('src/routes/jobs.js');

  assert.match(routes, /contract_value: data\.contract_value \?\? 0/);
  assert.match(routes, /total_paid: data\.total_paid \?\? 0/);
});

test('project file upload supports browser-selected folder trees', () => {
  const routes = read('src/routes/files.js');
  const folderView = read('src/views/files/folder.ejs');

  assert.match(routes, /preservePath: true/);
  assert.match(routes, /function normalizeRelativeUploadPath\(filename\)/);
  assert.match(routes, /async function ensureUploadSubfolder\(parentFolder, folderParts, userId\)/);
  assert.match(routes, /const folderParts = parts\.slice\(0, -1\)/);
  assert.match(routes, /const targetFolderId = await ensureUploadSubfolder\(folder, folderParts, req\.session\.userId \|\| null\)/);
  assert.match(routes, /folder_id: targetFolderId/);
  assert.match(routes, /MAX_UPLOAD_BATCH_SIZE/);
  assert.match(folderView, /webkitdirectory/);
  assert.match(folderView, /Choose folder/);
  assert.match(folderView, /Upload folder/);
  assert.match(folderView, /Upload zipped folder/);
  assert.doesNotMatch(folderView, /Folder \(\.zip\)/);
});

test('transactional email defaults to Forge-Recon sender name', () => {
  const emailService = read('src/services/email.js');

  assert.match(emailService, /const DEFAULT_FROM = '"Forge-Recon" <support@reconenterprises\.net>'/);
  assert.match(emailService, /const FROM = process\.env\.EMAIL_FROM \|\| DEFAULT_FROM/);
  assert.doesNotMatch(emailService, /"Recon Office" <support@reconenterprises\.net>/);
});

test('Supabase public API access is locked down in migrations', () => {
  const migration = read('supabase/migrations/20260602144235_lock_down_public_api_access.sql');

  assert.match(migration, /revoke all privileges on all tables in schema public from anon, authenticated/);
  assert.match(migration, /revoke usage on schema public from anon, authenticated/);
  assert.match(migration, /revoke all privileges on all functions in schema public from public/);
  assert.match(migration, /grant all privileges on all tables in schema public to service_role/);
  assert.match(migration, /alter table '\s*\|\|\s*rec\.fqtn\s*\|\|\s*' enable row level security/);
  assert.match(migration, /alter view if exists public\.v_job_financials set \(security_invoker = true\)/);
  assert.match(migration, /alter function public\.set_updated_at_column\(\) set search_path = public/);
});

test('project chat stays inside the project content shell', () => {
  const show = read('src/views/jobs/show.ejs');

  const opsShellStart = show.indexOf('<div class="ops-shell">');
  const chatStart = show.indexOf('<details class="chat-panel card mb-6 overflow-hidden"');
  const opsShellEnd = show.indexOf('</div>  <%# closes ops-shell %>');
  const chatPanelMarkup = show.match(/<details class="chat-panel[\s\S]*?<\/details>/);
  const chatPrefix = show.slice(Math.max(0, chatStart - 80), chatStart);

  assert.ok(opsShellStart >= 0, 'project show should use the ops shell');
  assert.ok(chatStart > opsShellStart, 'project chat should render inside the ops shell');
  assert.ok(chatStart < opsShellEnd, 'project chat should not render after the ops shell closes');
  assert.ok(chatPanelMarkup, 'project chat panel markup should exist');
  assert.doesNotMatch(chatPrefix, /canSeeOperations|canSeeBilling/);
  assert.doesNotMatch(chatPanelMarkup[0], /position\s*:\s*fixed/);
  assert.doesNotMatch(chatPanelMarkup[0], /top\s*:\s*4rem/);
  assert.match(show, /Project communication and internal updates/);
});
