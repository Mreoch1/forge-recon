const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const reconEstimate = require('../src/services/rfp-recon-estimate');

test('approved RFP labor and material children become one Recon estimate scope line', () => {
  const parents = [{
    id: 10,
    description: 'Replace apartment lighting',
    quantity: 10,
    sort_order: 1,
    approved: false,
  }];
  const subItemsMap = {
    10: [
      {
        id: 11,
        parent_line_item_id: 10,
        quantity: 10,
        contractor_cost: 30,
        vendor_cost: 0,
        markup_pct: 16,
        general_requirements_pct: 4,
        scope_type: 'contractor',
        approved: true,
      },
      {
        id: 12,
        parent_line_item_id: 10,
        quantity: 10,
        contractor_cost: 0,
        vendor_cost: 20,
        markup_pct: 16,
        general_requirements_pct: 4,
        scope_type: 'supplier',
        approved: true,
      },
    ],
  };

  const lines = reconEstimate.buildReconEstimateLines(parents, subItemsMap);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].description, 'Replace apartment lighting');
  assert.equal(lines[0].quantity, 10);
  assert.equal(lines[0].labor_cost, 30);
  assert.equal(lines[0].material_cost, 20);
  assert.equal(lines[0].cost, 50);
  assert.equal(lines[0].markup_pct, 20);
  assert.equal(lines[0].unit_price, 60);
  assert.equal(lines[0].line_total, 600);
});

test('unapproved child pricing is excluded without double-counting the parent', () => {
  const parents = [{ id: 20, description: 'Cabinets', quantity: 5, approved: true }];
  const subItemsMap = {
    20: [
      { id: 21, parent_line_item_id: 20, quantity: 5, vendor_cost: 100, markup_pct: 10, general_requirements_pct: 5, scope_type: 'supplier', approved: true },
      { id: 22, parent_line_item_id: 20, quantity: 5, vendor_cost: 900, markup_pct: 10, general_requirements_pct: 5, scope_type: 'supplier', approved: false },
    ],
  };

  const [line] = reconEstimate.buildReconEstimateLines(parents, subItemsMap);
  assert.equal(line.cost, 100);
  assert.equal(line.material_cost, 100);
  assert.equal(line.unit_price, 115);
  assert.equal(line.line_total, 575);
});

test('standalone approved item preserves its stored Recon totals', () => {
  const parents = [{
    id: 30,
    description: 'Permit allowance',
    quantity: 1,
    unit_cost: 1000,
    total_cost: 1000,
    total_with_markup: 1120,
    scope_type: 'contractor',
    approved: true,
  }];

  const [line] = reconEstimate.buildReconEstimateLines(parents, {});
  assert.equal(line.labor_cost, 1000);
  assert.equal(line.material_cost, 0);
  assert.equal(line.markup_pct, 12);
  assert.equal(line.line_total, 1120);
});

test('unapproved standalone items do not create estimate lines', () => {
  const parents = [{ id: 40, description: 'Not selected', quantity: 1, total_cost: 100, total_with_markup: 120, approved: false }];
  assert.deepEqual(reconEstimate.buildReconEstimateLines(parents, {}), []);
});

test('estimate totals and work-order lines retain Recon sell and cost values', () => {
  const lines = [
    { description: 'One', quantity: 2, unit: 'ea', unit_price: 60, cost: 50, line_total: 120, sort_order: 0 },
    { description: 'Two', quantity: 1, unit: 'ea', unit_price: 230, cost: 200, line_total: 230, sort_order: 1 },
  ];

  assert.deepEqual(reconEstimate.totalsForReconEstimate(lines, 6), {
    subtotal: 350,
    costTotal: 300,
    taxRate: 6,
    taxAmount: 21,
    total: 371,
  });
  assert.deepEqual(reconEstimate.workOrderLinesFromEstimateLines(lines), [
    { description: 'One', quantity: 2, unit: 'ea', unit_price: 60, cost: 50, line_total: 120, completed: 0, sort_order: 0 },
    { description: 'Two', quantity: 1, unit: 'ea', unit_price: 230, cost: 200, line_total: 230, completed: 0, sort_order: 1 },
  ]);
});

test('Recon action is manager-only, category-scoped, atomic, and visible beside Ginosko', () => {
  const root = path.join(__dirname, '..');
  const routes = fs.readFileSync(path.join(root, 'src/routes/rfp.js'), 'utf8');
  const view = fs.readFileSync(path.join(root, 'src/views/jobs/rfp.ejs'), 'utf8');
  const migration = fs.readFileSync(
    path.join(root, 'supabase/migrations/20260717144555_rfp_recon_estimate_conversion.sql'),
    'utf8'
  );

  assert.match(routes, /create-recon-estimate', requireManager, requireRfpAccess/);
  assert.match(routes, /rpc\('create_recon_estimate_from_rfp'/);
  assert.match(routes, /res\.redirect\(`\/estimates\/\$\{conversion\.estimate_id\}\/edit`\)/);
  assert.match(view, /export-ginosko\.xlsx[\s\S]*create-recon-estimate[\s\S]*>Recon<\/button>/);
  assert.match(migration, /create unique index if not exists estimates_source_rfp_id_unique/);
  assert.match(migration, /security invoker/);
  assert.match(migration, /revoke execute on function public\.create_recon_estimate_from_rfp\(jsonb\) from public, anon, authenticated/);
});
