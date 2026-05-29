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

test('project RFP export loader only selects real project columns', () => {
  const routes = read('src/routes/rfp.js');
  assert.match(routes, /\.from\('jobs'\)\s*\.select\('id, title'\)/);
  assert.doesNotMatch(routes, /\.select\('id, title, name'\)/);
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
