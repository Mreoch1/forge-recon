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

test('project visibility is assignment scoped for non-admin users', () => {
  const routes = read('src/routes/jobs.js');

  assert.match(routes, /async function visibleProjectIdsForUser/);
  assert.match(routes, /assigned_to_user_id\.eq/);
  assert.match(routes, /project_manager_user_id\.eq/);
  assert.match(routes, /\.from\('job_members'\)\s*\.select\('job_id'\)\s*\.eq\('user_id'/);
  assert.match(routes, /if \(req\.session\.role !== 'admin'\)/);
  assert.match(routes, /query = applyProjectVisibility\(query, visibleProjectIds\)/);
  assert.match(routes, /countQuery = applyProjectVisibility\(countQuery, visibleProjectIds\)/);
  assert.match(routes, /const appFull = appRole === 'admin'/);
  assert.match(routes, /hasAnyProjectAccess\(access\)/);
  assert.match(routes, /You are not assigned to this project/);
  assert.match(routes, /upsert\(\{\s*job_id: newJob\.id,[\s\S]*role: 'admin'/);
});

test('project RFP and materials access follows project assignment for managers', () => {
  const rfp = read('src/routes/rfp.js');
  const materials = read('src/routes/materials.js');

  assert.doesNotMatch(rfp, /appRole === 'admin' \|\| appRole === 'manager'/);
  assert.doesNotMatch(materials, /appRole === 'admin' \|\| appRole === 'manager'/);
  assert.match(rfp, /async function resolveRfpJobId/);
  assert.match(rfp, /const jobId = await resolveRfpJobId\(req\)/);
  assert.match(rfp, /const access = await loadProjectAccess\(req, job\)/);
  assert.match(materials, /async function resolveMaterialsJobId/);
  assert.match(materials, /\.from\('project_material_items'\)\s*\.select\('id, category_id'\)/);
  assert.match(materials, /const access = await loadProjectAccess\(req, job\)/);
});

test('managers can access customers but cannot delete them', () => {
  const app = read('src/app.js');
  const customers = read('src/routes/customers.js');
  const header = read('src/views/layouts/header.ejs');
  const customerIndex = read('src/views/customers/index.ejs');
  const customerImport = read('src/views/customers/import.ejs');

  assert.match(app, /app\.use\('\/customers', requireAuth, requireManager, customersRoutes\)/);
  assert.match(customers, /router\.post\('\/:id\/delete', requireAdmin,/);
  assert.match(customers, /router\.get\('\/import'/);
  assert.match(customers, /router\.post\('\/import', importUpload\.single\('customers_csv'\)/);
  assert.match(customers, /parseMhelpdeskCustomersCsv/);
  assert.match(customers, /mhelpdesk_customer_id/);
  assert.match(customers, /CUSTOMER_SORTS/);
  assert.match(customers, /CUSTOMER_FILTERS/);
  assert.match(customers, /req\.query\.sort/);
  assert.match(customers, /req\.query\.has/);
  assert.match(customerIndex, /customer-toolbar/);
  assert.match(customerIndex, /name="has"/);
  assert.match(customerIndex, /name="sort"/);
  assert.match(customerIndex, /compactPages/);
  assert.match(customerIndex, /Previous/);
  assert.match(customerIndex, /Next/);
  assert.match(customerIndex, /href="\/customers\/import"/);
  assert.match(customerImport, /mHelpDesk customer CSV/);
  assert.match(customerImport, /name="customers_csv"/);
  assert.match(header, /_canManageNav[\s\S]*href="\/customers"/);
  assert.match(header, /_canManageMobile[\s\S]*href="\/customers"/);
});

test('navigation is grouped by workflow and role tier', () => {
  const header = read('src/views/layouts/header.ejs');
  const desktopNav = header.match(/<div class="hidden lg:flex items-center gap-0" id="desktop-nav">([\s\S]*?)<!-- More dropdown -->/);
  const mobileNav = header.match(/<div class="mobile-menu-heading">Work<\/div>([\s\S]*?)<div class="mobile-menu-heading">Sales<\/div>/);
  const desktopMore = header.match(/<div class="more-menu hidden[\s\S]*?<\/div>\s*<\/div>\s*<% } %>\s*<\/div>/);

  assert.ok(desktopNav, 'desktop nav block should exist');
  assert.ok(mobileNav, 'mobile work nav block should exist');
  assert.ok(desktopMore, 'desktop More menu should exist');
  assert.ok(desktopNav[1].indexOf('>Dashboard</a>') < desktopNav[1].indexOf('>Work Orders</a>'));
  assert.ok(desktopNav[1].indexOf('>Work Orders</a>') < desktopNav[1].indexOf('>Schedule</a>'));
  assert.ok(desktopNav[1].indexOf('>Schedule</a>') < desktopNav[1].indexOf('>Projects</a>'));
  assert.ok(desktopNav[1].indexOf('>Projects</a>') < desktopNav[1].indexOf('>Customers</a>'));
  assert.doesNotMatch(desktopNav[1], /href="\/estimates"/);
  assert.doesNotMatch(desktopNav[1], /href="\/invoices"/);
  assert.doesNotMatch(desktopNav[1], /href="\/accounting"/);
  assert.ok(mobileNav[1].indexOf('>Dashboard</a>') < mobileNav[1].indexOf('>Work Orders</a>'));
  assert.match(header, /<div class="more-menu-heading">Sales<\/div>[\s\S]*href="\/estimates"[\s\S]*href="\/invoices"/);
  assert.match(header, /<div class="more-menu-heading">Vendors & costs<\/div>[\s\S]*href="\/vendors"[\s\S]*href="\/contractors"[\s\S]*href="\/vendor-intake\/directory"/);
  assert.match(header, /<% if \(_isAdminNav\) \{ %>[\s\S]*href="\/bills"/);
  assert.match(header, /<% if \(_isAdminNav\) \{ %>[\s\S]*href="\/accounting"[\s\S]*href="\/admin\/users"/);
  assert.match(header, /<% if \(_canManageNav\) \{ %>[\s\S]*id="more-dropdown"/);
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
  assert.match(header, /_canManageNav[\s\S]*href="\/vendors"/);
  assert.match(header, /_canManageNav[\s\S]*href="\/contractors"/);
  assert.match(header, /_canManageMobile[\s\S]*href="\/vendors"/);
  assert.match(header, /_canManageMobile[\s\S]*href="\/contractors"/);
});

test('trade intake has public start form and manager-only directory', () => {
  const app = read('src/app.js');
  const routes = read('src/routes/vendor-intake.js');
  const form = read('src/views/vendor-intake/form.ejs');
  const show = read('src/views/vendor-intake/show.ejs');
  const header = read('src/views/layouts/header.ejs');
  const migration = read('supabase/migrations/20260608110353_contractor_vendor_intake.sql');
  const ackMigration = read('supabase/migrations/20260617140016_vendor_intake_bid_participation_acknowledgment.sql');

  assert.match(app, /const vendorIntakeRoutes = require\('\.\/routes\/vendor-intake'\)/);
  assert.match(app, /app\.use\('\/vendor-intake', vendorIntakeRoutes\)/);
  assert.match(routes, /router\.get\('\/start'/);
  assert.match(routes, /router\.post\('\/start'/);
  assert.match(routes, /router\.get\('\/directory', requireManager,/);
  assert.match(routes, /router\.get\('\/directory\/:id\.pdf', requireManager,/);
  assert.match(routes, /router\.post\('\/directory\/:id\/notes', requireManager,/);
  assert.match(routes, /router\.post\('\/directory\/:id\/promote', requireManager,/);
  assert.match(routes, /generateVendorIntakePDF/);
  assert.match(routes, /access_token/);
  assert.match(routes, /next_update_due_at/);
  assert.match(routes, /bidAcknowledgmentAccepted/);
  assert.ok(routes.includes('ref_${i}_notes'));
  assert.match(form, /name="ref_<%= i %>_notes"/);
  assert.match(form, /ref\.notes/);
  assert.match(form, /Bid Participation Acknowledgment/);
  assert.match(form, /bid_non_circumvention_acknowledged/);
  assert.match(form, /bid_direct_contact_acknowledged/);
  assert.match(form, /bid_future_agreement_acknowledged/);
  assert.match(show, /ref\.notes/);
  assert.match(show, /Bid Participation Acknowledgment/);
  assert.match(show, /window\.print\(\)/);
  assert.match(show, /\/vendor-intake\/directory\/<%= intake\.id %>\.pdf/);
  [
    'dba_name',
    'billing_contact_name',
    'billing_contact_email',
    'billing_contact_phone',
    'mobile_phone',
    'annual_capacity',
    'largest_project_location',
    'largest_project_date',
    'bondable',
    'hud_mshda_notes',
    'section3_notes',
    'certifications',
    'safety_notes',
    'documents_notes',
    'bid_participation_acknowledged',
    'bid_non_circumvention_acknowledged',
    'bid_direct_contact_acknowledged',
    'bid_future_agreement_acknowledged'
  ].forEach(field => assert.match(show, new RegExp(`intake\\.${field}`)));
  assert.match(header, /href="\/vendor-intake\/directory"/);
  assert.match(header, /activeNav === 'intake'/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.contractor_vendor_intakes/);
  assert.match(migration, /references_json JSONB NOT NULL DEFAULT '\[\]'::jsonb/);
  assert.match(migration, /ALTER TABLE public\.contractor_vendor_intakes ENABLE ROW LEVEL SECURITY/);
  assert.match(ackMigration, /bid_participation_acknowledged/);
  assert.match(ackMigration, /bid_non_circumvention_acknowledged/);
  assert.match(ackMigration, /bid_direct_contact_acknowledged/);
  assert.match(ackMigration, /bid_future_agreement_acknowledged/);
});

test('managers can create and send invoices while admin keeps accounting controls', () => {
  const app = read('src/app.js');
  const estimates = read('src/routes/estimates.js');
  const invoices = read('src/routes/invoices.js');
  const estimateShow = read('src/views/estimates/show.ejs');
  const estimateSend = read('src/views/estimates/send-confirm.ejs');
  const invoiceShow = read('src/views/invoices/show.ejs');
  const invoiceSend = read('src/views/invoices/send-confirm.ejs');
  const estimateEmail = read('src/services/estimate-email.js');
  const header = read('src/views/layouts/header.ejs');

  assert.match(app, /app\.use\('\/invoices', requireAuth, requireManager, invoicesRoutes\)/);
  assert.match(estimates, /router\.post\('\/:id\/create-invoice', requireManager,/);
  assert.match(estimates, /router\.get\('\/:id\/create-invoice', requireManager,/);
  assert.match(estimates, /router\.post\('\/:id\/generate-invoice', requireManager,/);
  assert.match(estimateShow, /const canManageInvoices = currentUser && \['admin', 'manager'\]\.includes\(currentUser\.role\)/);
  assert.match(estimateShow, /canManageInvoices && !invoice && estimate\.lines\.length > 0/);
  assert.match(estimateShow, /href="\/estimates\/<%= estimate\.id %>\/send"/);
  assert.match(invoiceShow, /const isAdmin = currentUser && currentUser\.role === 'admin'/);
  assert.match(invoiceShow, /isAdmin && \(invoice\.status === 'sent' \|\| invoice\.status === 'overdue'\)/);
  assert.match(invoiceShow, /href="\/invoices\/<%= invoice\.id %>\/send"/);
  assert.match(invoiceShow, /href="\/invoices\/<%= invoice\.id %>\/csv"/);
  assert.match(invoiceShow, /action="\/invoices\/<%= invoice\.id %>\/mark-sent"/);
  assert.match(invoiceShow, /action="\/invoices\/<%= invoice\.id %>\/status"/);
  assert.match(invoiceShow, /Manual invoice status/);
  assert.match(invoiceShow, /action="\/invoices\/<%= invoice\.id %>\/billing-complete"/);
  assert.match(invoices, /async function refreshPastDueInvoices\(\)/);
  assert.match(invoices, /status_auto_overdue/);
  assert.match(estimates, /router\.get\('\/:id\/send'/);
  assert.match(estimates, /res\.render\('estimates\/send-confirm'/);
  assert.match(estimates, /parseSendRecipients\(req\.body\)/);
  assert.match(invoices, /router\.get\('\/:id\/send'/);
  assert.match(invoices, /res\.render\('invoices\/send-confirm'/);
  assert.match(invoices, /parseSendRecipients\(req\.body\)/);
  assert.match(invoices, /cc: ccEmails/);
  assert.match(estimateEmail, /async function sendEstimateEmail\(estimateId, options = \{\}\)/);
  assert.match(estimateEmail, /to: recipient,[\s\S]*cc,/);
  assert.match(estimateSend, /class="document-shell"/);
  assert.match(estimateSend, /name="to_email"/);
  assert.match(estimateSend, /name="cc_emails"/);
  assert.match(estimateSend, /Confirm send/);
  assert.match(invoiceSend, /class="document-shell"/);
  assert.match(invoiceSend, /name="to_email"/);
  assert.match(invoiceSend, /name="cc_emails"/);
  assert.match(invoiceSend, /Confirm send/);
  assert.match(invoices, /router\.post\('\/:id\/mark-sent'/);
  assert.match(invoices, /router\.post\('\/:id\/status', requireAdmin,/);
  assert.match(invoices, /router\.post\('\/:id\/mark-paid', requireAdmin,/);
  assert.match(invoices, /router\.post\('\/:id\/billing-complete', requireAdmin,/);
  assert.match(invoices, /router\.get\('\/:id\/csv'/);
  assert.match(invoices, /router\.post\('\/batch-csv'/);
  assert.doesNotMatch(invoices, /router\.post\('\/:id\/sync-quickbooks'/);
  assert.match(invoices, /router\.post\('\/:id\/reopen-billing', requireAdmin,/);
  assert.match(invoices, /router\.post\('\/:id\/void', requireAdmin,/);
  assert.match(invoices, /router\.post\('\/:id\/delete', requireAdmin,/);
  assert.match(header, /_canManageNav[\s\S]*href="\/invoices"/);
  assert.match(header, /_canManageMobile[\s\S]*href="\/invoices"/);
});

test('project files open in a Forge viewer with sibling navigation', () => {
  const fileRoutes = read('src/routes/files.js');
  const folderView = read('src/views/files/folder.ejs');
  const viewer = read('src/views/files/viewer.ejs');

  assert.match(fileRoutes, /async function getEntityDisplayContext\(entityType, entityId, requestedEntityType\)/);
  assert.match(fileRoutes, /supabase\.from\('jobs'\)\.select\('id, title'\)/);
  assert.match(fileRoutes, /async function buildFolderDisplay\(folder, requestedEntityType\)/);
  assert.match(fileRoutes, /folderChain\.slice\(1\)\.forEach/);
  assert.match(fileRoutes, /withFolderContext\(`\/files\/folders\/\$\{part\.id\}`/);
  assert.match(fileRoutes, /buildFolderDisplay\(folder, requestedEntityType\)/);
  assert.match(fileRoutes, /buildFolderDisplay\(folder, normalizeFolderContext\(req\.query\.context\)\)/);
  assert.match(fileRoutes, /router\.get\('\/:id\/view'/);
  assert.match(fileRoutes, /router\.get\('\/:id\/raw'/);
  assert.match(fileRoutes, /contentDisposition\('inline', file\)/);
  assert.doesNotMatch(fileRoutes, /return res\.redirect\(signedUrl\)/);
  assert.match(fileRoutes, /filename\*=UTF-8''/);
  assert.match(fileRoutes, /router\.get\('\/:id\/download'/);
  assert.match(fileRoutes, /contentDisposition\('attachment', file\)/);
  assert.match(fileRoutes, /res\.render\('files\/viewer'/);
  assert.match(fileRoutes, /previousFile/);
  assert.match(fileRoutes, /nextFile/);
  assert.match(folderView, /aria-label="Folder path"/);
  assert.match(folderView, /Files and folders/);
  assert.match(folderView, /href="\/files\/folders\/<%= sf\.id %><%= contextQuery %>"/);
  assert.match(folderView, /href="\/files\/<%= f\.id %>\/view<%= contextQuery %>"/);
  assert.doesNotMatch(folderView, /Folder contents/);
  assert.doesNotMatch(folderView, /parentFolderName/);
  assert.match(viewer, /aria-label="Folder path"/);
  assert.match(viewer, /file-viewer-rail/);
  assert.match(viewer, /Folder files/);
  assert.match(viewer, /href="\/files\/<%= sibling\.id %>\/view<%= contextQuery %>"/);
  assert.match(viewer, /ArrowLeft/);
  assert.match(viewer, /ArrowRight/);
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
  assert.match(read('src/services/quickbooks-sync.js'), /saveInvoiceSync\(invoice, connection, qboInvoice, payload, 'billing_complete'\)/);
});

test('bank transactions and account defaults are wired for accounting categorization', () => {
  const accountingRoutes = read('src/routes/accounting.js');
  const accountingIndex = read('src/views/accounting/index.ejs');
  const accountsView = read('src/views/accounting/accounts.ejs');
  const bankView = read('src/views/accounting/bank-transactions.ejs');
  const customers = read('src/routes/customers.js');
  const customerForm = read('src/views/customers/_form.ejs');
  const contractors = read('src/routes/contractors.js');
  const contractorForm = read('src/views/contractors/_form.ejs');
  const vendorForm = read('src/views/vendors/_form.ejs');
  const migration = read('supabase/migrations/20260610120000_bank_transactions_and_account_defaults.sql');
  const header = read('src/views/layouts/header.ejs');

  assert.match(accountingRoutes, /router\.get\('\/bank-transactions'/);
  assert.match(accountingRoutes, /router\.post\('\/bank-transactions\/import'/);
  assert.match(accountingRoutes, /parseBankUpload/);
  assert.match(accountingRoutes, /normalizeImportedBankRows/);
  assert.match(accountingRoutes, /insertBankImportRows/);
  assert.match(accountingRoutes, /\.from\('bank_transactions'\)/);
  assert.match(accountingIndex, /href: '\/accounting\/bank-transactions'/);
  assert.match(accountsView, /class="ops-shell"/);
  assert.match(accountsView, /Filter by name or number/);
  assert.match(accountsView, /name="type"/);
  assert.match(accountsView, /qbo_account_type/);
  assert.match(accountsView, /detail_type/);
  assert.match(accountsView, /View register/);
  assert.match(bankView, /action="\/accounting\/bank-transactions\/import"/);
  assert.match(bankView, /name="bank_file"/);
  assert.match(bankView, /accept="\.csv,\.xlsx/);
  assert.match(bankView, /class="ops-shell"/);
  assert.match(bankView, /Categorize or match/);
  assert.match(bankView, /Chart of accounts/);
  assert.match(customers, /default_income_account_id/);
  assert.match(customers, /loadAccountOptions\('revenue'\)/);
  assert.match(customerForm, /name="default_income_account_id"/);
  assert.match(contractors, /default_expense_account_id/);
  assert.match(contractors, /loadExpenseAccounts\(\)/);
  assert.match(contractorForm, /name="default_expense_account_id"/);
  assert.match(vendorForm, /name="default_expense_account_id"/);
  assert.match(migration, /create table if not exists public\.bank_transactions/);
  assert.match(migration, /alter table public\.bank_transactions enable row level security/);
  assert.match(header, /href="\/accounting\/bank-transactions"/);
});

test('QuickBooks favorite accounting reports are available with filters and exports', () => {
  const accountingRoutes = read('src/routes/accounting.js');
  const accountingIndex = read('src/views/accounting/index.ejs');
  const genericReport = read('src/views/accounting/reports/generic.ejs');
  const migration = read('supabase/migrations/20260611153209_recon_quickbooks_chart_of_accounts.sql');

  [
    'ap-aging-detail',
    'ar-aging-detail',
    'bills-applied-payments',
    'bill-payment-list',
    'deposit-detail',
    'invoices-received-payments',
    'paycheck-history',
    'payroll-summary-by-employee',
    'payroll-details',
    'payroll-summary',
    'payroll-tax-liability',
    'total-payroll-cost',
    'payroll-tax-wage-summary',
    'unpaid-bills',
    'vendor-balance-summary',
    'vendor-balance-detail',
  ].forEach(slug => assert.match(accountingRoutes, new RegExp(`slug: '${slug}'`)));

  assert.match(accountingRoutes, /router\.get\('\/reports\/:slug'/);
  assert.match(accountingRoutes, /router\.get\('\/reports\/:slug\.pdf'/);
  assert.match(accountingRoutes, /accountQueryParams/);
  assert.match(accountingRoutes, /qbo_account_type/);
  assert.match(accountingRoutes, /detail_type/);
  assert.match(accountingRoutes, /function reportDateRange/);
  assert.match(accountingIndex, /favoriteReports/);
  assert.match(accountingIndex, /Favorite reports/);
  assert.match(genericReport, /name="range"/);
  assert.match(genericReport, /name="q"/);
  assert.match(genericReport, /data-sort-key/);
  assert.match(genericReport, /definition\.pdf/);
  assert.match(migration, /recon_accounts\(code, name, type, qbo_account_type, detail_type, sort_order\)/);
  assert.match(migration, /Checking Account/);
  assert.match(migration, /Receivables-Trade/);
});

test('admin payroll employees use QuickBooks-style editable profile workflow', () => {
  const accountingRoutes = read('src/routes/accounting.js');
  const payrollList = read('src/views/accounting/payroll.ejs');
  const payrollForm = read('src/views/accounting/payroll-employee-form.ejs');
  const payrollShow = read('src/views/accounting/payroll-employee-show.ejs');
  const accountingIndex = read('src/views/accounting/index.ejs');
  const migration = read('supabase/migrations/20260612105000_payroll_employee_profile_fields.sql');

  assert.match(accountingRoutes, /router\.get\('\/payroll\/employees\/new'/);
  assert.match(accountingRoutes, /router\.get\('\/payroll\/employees\/:id'/);
  assert.match(accountingRoutes, /router\.post\('\/payroll\/employees\/:id'/);
  assert.match(accountingRoutes, /PAYROLL_EMPLOYEE_SELECT/);
  assert.match(accountingIndex, /name: 'Employees'/);
  assert.match(payrollList, /Search By Name/);
  assert.match(payrollList, /Pay rate/);
  assert.match(payrollList, /Pay method/);
  assert.match(payrollForm, /name="pay_rate_amount"/);
  assert.match(payrollForm, /name="emergency_contact_name"/);
  assert.match(payrollForm, /name="deductions_and_contributions"/);
  assert.match(payrollShow, /Job & pay/);
  assert.match(payrollShow, /Payroll activity/);
  assert.doesNotMatch(payrollShow, /Background check/i);
  assert.match(migration, /additional_pay_types/);
  assert.match(migration, /ALTER TABLE public\.payroll_employees ENABLE ROW LEVEL SECURITY/);
});

test('users can update their password from settings with a one-time login prompt', () => {
  const app = read('src/app.js');
  const auth = read('src/routes/auth.js');
  const middleware = read('src/middleware/auth.js');
  const settings = read('src/routes/settings.js');
  const settingsView = read('src/views/settings/index.ejs');
  const loginView = read('src/views/auth/login.ejs');
  const header = read('src/views/layouts/header.ejs');
  const prompt = read('src/views/layouts/_password_update_prompt_modal.ejs');
  const schema = read('src/db/schema-postgres.sql');
  const migration = read('supabase/migrations/20260612113000_password_update_prompt_seen_at.sql');

  assert.match(app, /DEFAULT_SESSION_MAX_AGE_MS = 8 \* 3600 \* 1000/);
  assert.match(app, /REMEMBER_SESSION_MAX_AGE_MS = 30 \* 24 \* 3600 \* 1000/);
  assert.match(auth, /function wantsPersistentSession\(body\)/);
  assert.match(auth, /function applySessionLifetime\(req, keepLoggedIn\)/);
  assert.match(auth, /req\.sessionOptions\.maxAge = maxAge/);
  assert.match(auth, /req\.session\.cookie\.maxAge = maxAge/);
  assert.match(auth, /applySessionLifetime\(req, keepLoggedIn\)/);
  assert.match(loginView, /name="keep_logged_in"/);
  assert.match(loginView, /Keep me logged in/);
  assert.match(auth, /req\.session\.showPasswordUpdatePrompt = true/);
  assert.match(auth, /delete req\.session\.showPasswordUpdatePrompt/);
  assert.match(auth, /password_update_prompt_seen_at: changedAt/);
  assert.match(middleware, /password_update_prompt_seen_at/);
  assert.match(middleware, /res\.locals\.showPasswordUpdatePrompt/);
  assert.match(settings, /async function markPasswordPromptSeen\(req\)/);
  assert.match(settings, /router\.post\('\/password-prompt\/update'/);
  assert.match(settings, /router\.post\('\/password-prompt\/dismiss'/);
  assert.match(settings, /password_update_prompt_seen_at: changedAt/);
  assert.match(settingsView, /id="change-password"/);
  assert.match(settingsView, /window\.location\.hash !== '#change-password'/);
  assert.match(header, /_password_update_prompt_modal/);
  assert.match(prompt, /showPasswordUpdatePrompt/);
  assert.match(prompt, /action="\/settings\/password-prompt\/update"/);
  assert.match(prompt, /action="\/settings\/password-prompt\/dismiss"/);
  assert.match(schema, /password_update_prompt_seen_at TIMESTAMPTZ/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS password_update_prompt_seen_at TIMESTAMPTZ/);
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
  assert.match(show, /Photos &amp; Files/);
  assert.match(show, /wo-file-row/);
  assert.match(show, /wo-file-row:hover/);
  assert.match(show, /wo-file-link/);
  assert.match(show, /can_preview: !!p\.is_image \|\| mime\.includes\('pdf'\)/);
  assert.match(show, /if \(!item \|\| !item\.can_preview\) return/);
  assert.doesNotMatch(show, /hover:bg-gray-50 group/);
  assert.doesNotMatch(show, /Work order files/);
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
  assert.match(view, /id="rfp-line-editor-<%= item\.id %>"/);
  assert.match(view, /function restoreRfpPosition\(\)/);
  assert.match(view, /function openRfpLineEditor\(itemId\)/);
  assert.match(view, /window\.toggleRfpLineEditor/);
  assert.match(view, /params\.get\('open_rfp'\)/);
  assert.match(view, /params\.get\('open_item'\)/);
  assert.match(view, /params\.get\('show_sub_form'\)/);
  assert.match(view, /document\.getElementById\('rfp-line-' \+ itemId\)/);
  assert.doesNotMatch(view, /if \(itemId\) target = openRfpLineEditor\(itemId\) \|\| target/);
});

test('RFP line items open a pricing editor instead of dropdown sub rows', () => {
  const view = read('src/views/jobs/rfp.ejs');
  const routes = read('src/routes/rfp.js');

  assert.match(view, /class="rfp-line-editor-modal hidden fixed inset-0/);
  assert.doesNotMatch(view, /class="rfp-line-editor-modal hidden fixed inset-0[^"]*\bblock\b/);
  assert.match(view, /role="dialog" aria-modal="true"/);
  assert.match(view, /Vendor \/ contractor pricing/);
  assert.match(view, /Add vendor \/ contractor line/);
  assert.match(view, /Save line item/);
  assert.match(view, /<th class="text-right">Lines<\/th>/);
  assert.match(view, /Approved vendor \/ contractor lines/);
  assert.match(view, /<td class="text-center" onclick="event\.stopPropagation\(\);">/);
  assert.match(view, /data-rfp-summary-total="<%= rfp\.id %>"/);
  assert.match(view, /data-rfp-line-total="<%= liDisplayTotal\.toFixed\(2\) %>"/);
  assert.match(view, /data-rfp-grand-total="<%= rfp\.id %>"/);
  assert.match(view, /function refreshApprovedTotalsFor\(el\)/);
  assert.match(view, /if \(el\.dataset\.field === 'approved'\) refreshApprovedTotalsFor\(el\)/);
  assert.match(view, /onclick="saveRfpLineEditor\('<%= item\.id %>'\)">Save line item/);
  assert.match(view, /id="rfp-add-sub-form-<%= item\.id %>"/);
  assert.match(view, /<input name="approved" type="hidden" value="1">/);
  assert.match(view, /function rfpAddLineFormHasData\(form\)/);
  assert.match(view, /addForm\.requestSubmit\(\)/);
  assert.match(view, /window\.saveRfpLineEditor = saveRfpLineEditor/);
  assert.match(routes, /insertPayload\.approved = approvedInput === undefined \? true/);
  assert.doesNotMatch(view, /<td class="text-right flex gap-1 items-center">/);
  assert.match(view, /type="submit" form="<%= subFid %>" class="btn btn-secondary text-xs">Save/);
  assert.doesNotMatch(view, /class="rfp-sub-row/);
  assert.doesNotMatch(view, /while\s*\(next && next\.classList\.contains\('rfp-sub-row'\)\)/);
  assert.doesNotMatch(view, /form\.addEventListener\('submit', function\(e\) \{ e\.preventDefault\(\); \}\)/);
});

test('RFP page filters categories and approved-only line items client-side', () => {
  const view = read('src/views/jobs/rfp.ejs');

  assert.match(view, /id="rfp-filter-search"/);
  assert.match(view, /id="rfp-filter-status"/);
  assert.match(view, /id="rfp-filter-approved-only"/);
  assert.match(view, /Show approved only/);
  assert.match(view, /data-rfp-category-row/);
  assert.match(view, /data-rfp-status="<%= rfp\.status \|\| 'pending' %>"/);
  assert.match(view, /data-rfp-approved-count="<%= rfpApprovedCounts\[rfp\.id\] %>"/);
  assert.match(view, /data-rfp-line-approved="/);
  assert.match(view, /function approvedRfpCount\(items\)/);
  assert.match(view, /function applyRfpFilters\(\)/);
  assert.match(view, /rowStatus === 'awarded' && approvedCount > 0/);
  assert.match(view, /\(!approvedOnly \|\| lineApproved\) && searchMatch/);
  assert.match(view, /window\.applyRfpFilters = applyRfpFilters/);
  assert.match(view, /categoryRow\.setAttribute\('data-rfp-status', saved \|\| 'pending'\)/);
  assert.match(view, /categoryRow\.setAttribute\('data-rfp-approved-count', String\(approvedCount\)\)/);
});

test('RFP supplier lines sync into project materials', () => {
  const materials = read('src/routes/materials.js');
  const rfpRoutes = read('src/routes/rfp.js');
  const rfpView = read('src/views/jobs/rfp.ejs');
  const materialsView = read('src/views/jobs/materials.ejs');
  const migration = read('supabase/migrations/20260615120000_rfp_material_sync.sql');

  assert.match(migration, /ADD COLUMN IF NOT EXISTS scope_type/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS rfp_line_item_id/);
  assert.match(rfpRoutes, /scope_type/);
  assert.match(rfpView, /Supplier \/ Material/);
  assert.match(materials, /async function syncRfpSupplierLinesToMaterials\(jobId\)/);
  assert.match(materials, /line\.scope_type === 'supplier'/);
  assert.match(materials, /rfp_line_item_id/);
  assert.match(materials, /source: 'rfp'/);
  assert.match(materialsView, /From RFP/);
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

test('RFP parent rows roll up approved sub-lines only', () => {
  const view = read('src/views/jobs/rfp.ejs');

  assert.match(view, /var liRollupChildren = liHasSubs \? apprChildren : \[\]/);
  assert.match(view, /var liDisplayTotal = liHasSubs \? liTotal : \(Number\(item\.total_with_markup\) \|\| 0\)/);
  assert.match(view, /var liDisplayBaseUnit = liHasSubs \? \(liQty > 0 \? liTotalCost \/ liQty : 0\) : \(Number\(item\.unit_cost\) \|\| 0\)/);
  assert.doesNotMatch(view, /apprChildren\.length > 0 \? apprChildren\.reduce[\s\S]*: children\.reduce/);
  assert.doesNotMatch(view, /liTotal \|\| \(Number\(item\.total_with_markup\)/);
});

test('RFP sub-line inserts calculate total from quantity and unit cost', () => {
  const routes = read('src/routes/rfp.js');

  assert.match(routes, /const computed = computeSubLineTotals\(\{ quantity, contractor_cost, vendor_cost, markup_pct, general_requirements_pct: grPct \}\)/);
  assert.match(routes, /unit_cost: parent_id \? \(computedUnit \|\| null\) : \(uCost \|\| computedUnit \|\| null\)/);
  assert.doesNotMatch(routes, /const baseCost = tCost \|\| \(uCost \* qty\) \|\| \(cCost \+ vCost\)/);
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

test('project financials live on a dedicated billing tab', () => {
  const routes = read('src/routes/jobs.js');
  const show = read('src/views/jobs/show.ejs');
  const header = read('src/views/jobs/_project_header.ejs');
  const tabs = read('src/views/jobs/_project_tabs.ejs');
  const financials = read('src/views/jobs/financials.ejs');

  assert.match(routes, /router\.get\('\/:id\/financials'/);
  assert.match(routes, /requireProjectAccess\(req, res, id, 'billing'\)/);
  assert.match(routes, /res\.render\('jobs\/financials'/);

  assert.match(header, /\/projects\/<%= job\.id %>\/financials/);
  assert.match(tabs, /key: 'financials'/);
  assert.match(tabs, /href: '\/projects\/' \+ job\.id \+ '\/financials'/);
  assert.match(show, /include\('_project_tabs', \{ job: job, projectAccess: access, activeProjectTab: 'overview' \}\)/);
  assert.doesNotMatch(show, /include\('_financial_panel'/);
  assert.doesNotMatch(show, /Contractors &amp; Vendors/);

  assert.match(financials, /activeProjectTab: 'financials'/);
  assert.match(financials, /include\('_financial_panel'/);
  assert.match(financials, /Contractors &amp; Vendors/);
  assert.doesNotMatch(financials, /include\('_vendor_invoices_table'/);
  assert.doesNotMatch(financials, /include\('_payments_timeline'/);
  assert.doesNotMatch(financials, /include\('_sov_table'/);
  assert.match(financials, /No project bills or contractor\/vendor commitments are linked to this project yet/);
  assert.match(financials, /<table class="w-full table-fixed text-xs">/);
  assert.match(financials, /<col style="width: 34%;">[\s\S]*<th class="px-4 py-3 text-right">Amount<\/th>/);
});

test('project contractor rollup includes bill-only vendors from Forge bills', () => {
  const service = read('src/services/project-contractor-rollup.js');

  assert.match(service, /\.from\('bills'\)[\s\S]*\.eq\('job_id', jobId\)[\s\S]*\.in\('status', \['draft', 'approved', 'paid'\]\)/);
  assert.match(service, /Bill entered in Forge/);
  assert.doesNotMatch(service, /if \(rfpIds\.length === 0\) return \[\]/);
});

test('bills are entered without a visible approval status step', () => {
  const routes = read('src/routes/bills.js');
  const dashboardRoutes = read('src/routes/dashboard.js');
  const dashboardView = read('src/views/dashboard/v2.ejs');
  const index = read('src/views/bills/index.ejs');
  const show = read('src/views/bills/show.ejs');
  const newView = read('src/views/bills/new.ejs');
  const financials = read('src/views/jobs/financials.ejs');
  const projectFinancials = read('src/services/project-financials.js');
  const postgresSchema = read('src/db/schema-postgres.sql');
  const accountingSchema = read('src/db/schema-accounting.sql');
  const migration = read('supabase/migrations/20260617235208_entered_bills_are_approved.sql');

  assert.match(routes, /await approveBillIfNeeded\(newId, req\.session\.userId\)/);
  assert.match(routes, /status: 'draft'/);
  assert.match(routes, /after: \{ status: 'approved', total: data\.total \}/);
  assert.match(routes, /await approveBillIfNeeded\(id, req\.session\.userId\)/);

  assert.match(newView, /submitLabel: 'Create bill'/);
  assert.doesNotMatch(newView, /Create draft bill/);
  assert.doesNotMatch(index, /All statuses/);
  assert.doesNotMatch(index, /<th>Status<\/th>/);
  assert.doesNotMatch(index, /badge-<%= b\.status %>/);
  assert.doesNotMatch(show, /Approve this bill/);
  assert.doesNotMatch(show, /badge-<%= bill\.status %>/);
  assert.doesNotMatch(financials, /<th>Status<\/th>/);
  assert.doesNotMatch(financials, /b\.status/);
  assert.match(projectFinancials, /\.in\('status', \['draft', 'approved', 'paid'\]\)/);
  assert.match(postgresSchema, /CREATE TABLE IF NOT EXISTS bills \([\s\S]*status TEXT NOT NULL DEFAULT 'approved'/);
  assert.match(accountingSchema, /CREATE TABLE IF NOT EXISTS bills \([\s\S]*status TEXT NOT NULL DEFAULT 'approved'/);
  assert.match(migration, /alter column status set default 'approved'/);
  assert.match(migration, /where status = 'draft'/);
  assert.doesNotMatch(dashboardRoutes, /billsToApprove/);
  assert.doesNotMatch(dashboardRoutes, /dashboard bills draft/);
  assert.doesNotMatch(dashboardView, /Billing awaiting approval/);
  assert.doesNotMatch(dashboardView, /bills awaiting approval/);
});

test('invoice line item totals update with blank labor and zero markup', () => {
  const lineItems = read('public/js/line-items.js');
  const invoiceEdit = read('src/views/invoices/edit.ejs');
  const invoiceRoutes = read('src/routes/invoices.js');

  assert.match(invoiceEdit, /<script src="\/js\/line-items\.js"><\/script>/);
  assert.match(lineItems, /function numberOr\(value, fallback\)/);
  assert.match(lineItems, /const hasInternalCostFields = !!\(laborInput \|\| materialInput\)/);
  assert.match(lineItems, /const labor = numberOr\(laborInput \? laborInput\.value : 0, 0\)/);
  assert.match(lineItems, /const material = numberOr\(materialInput \? materialInput\.value : 0, 0\)/);
  assert.match(lineItems, /const markup = numberOr\(markupInput \? markupInput\.value : 25, 25\)/);
  assert.doesNotMatch(lineItems, /parseFloat\(markupInput \? markupInput\.value : 25\) \|\| 25/);
  assert.match(invoiceRoutes, /const cost = calc\.round2\(labor \+ material\)/);
  assert.match(invoiceRoutes, /const unitPrice = calc\.round2\(cost \* \(1 \+ markup \/ 100\)\)/);
  assert.doesNotMatch(invoiceRoutes, /const unitPrice = parseFloat\(li\.unit_price\)/);
});

test('universal documents page is not exposed in the app', () => {
  const app = read('src/app.js');
  const header = read('src/views/layouts/header.ejs');
  const projectShow = read('src/views/jobs/show.ejs');
  const contractorShow = read('src/views/contractors/show.ejs');

  assert.doesNotMatch(app, /universalDocumentsRoutes/);
  assert.doesNotMatch(app, /\/universal-documents/);
  assert.doesNotMatch(header, /\/universal-documents/);
  assert.doesNotMatch(header, /Universal documents/);
  assert.doesNotMatch(projectShow, /Pre-con docs/);
  assert.doesNotMatch(projectShow, /\/universal-documents/);
  assert.doesNotMatch(contractorShow, /\/universal-documents/);
});
