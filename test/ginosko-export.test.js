const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

const ginoskoExport = require('../src/services/ginosko-export');
const { buildGinoskoExport, TEMPLATE_PATH } = ginoskoExport;

function baseJob(overrides) {
  return Object.assign({ id: 42, title: 'Midway Square', address: '123 Main St', city: 'Livonia', state: 'MI', zip: '48150' }, overrides || {});
}

async function loadSheet(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb.getWorksheet('Construction Bid Sheet');
}

test('approved supplier child exports to Materials, not Labor', async () => {
  const job = baseJob();
  const rfps = [{ id: 1, contractor_name: '06-41 - Millwork & Finish Carpentry' }];
  const itemsByRfp = {
    1: {
      items: [{ id: 10, parent_line_item_id: null, description: 'Supply Cabinets', quantity: 0, total_cost: 0, total_with_markup: 0, approved: false, scope_type: 'supplier' }],
      subItemsMap: {
        10: [{ id: 11, parent_line_item_id: 10, vendor: 'Ferguson', description: 'Supply Cabinets - Ferguson bid', quantity: 10, contractor_cost: 0, vendor_cost: 120, markup_pct: 16, general_requirements_pct: 4, approved: true, scope_type: 'supplier' }],
      },
    },
  };

  const result = await buildGinoskoExport(job, rfps, itemsByRfp);
  assert.equal(result.materialsCount, 1);
  assert.equal(result.laborCount, 0);

  const sheet = await loadSheet(result.buffer);
  assert.equal(sheet.getCell('C31').value, 'Supply Cabinets - Ferguson bid');
  assert.equal(sheet.getCell('B31').value, 10);
  assert.equal(sheet.getCell('D31').value, 144); // 120 * 1.20 markup+GR
});

test('approved contractor child exports to Labor with hours = FORGE quantity', async () => {
  const job = baseJob();
  const rfps = [{ id: 2, contractor_name: 'Electrical' }];
  const itemsByRfp = {
    2: {
      items: [{ id: 20, parent_line_item_id: null, description: 'Install Panel', quantity: 0, total_cost: 0, total_with_markup: 0, approved: false, scope_type: 'contractor' }],
      subItemsMap: {
        20: [{ id: 21, parent_line_item_id: 20, vendor: 'Electric Doctor', description: 'Install Panel - labor', quantity: 24, contractor_cost: 65, vendor_cost: 0, markup_pct: 16, general_requirements_pct: 4, approved: true, scope_type: 'contractor' }],
      },
    },
  };

  const result = await buildGinoskoExport(job, rfps, itemsByRfp);
  assert.equal(result.laborCount, 1);
  assert.equal(result.materialsCount, 0);

  const sheet = await loadSheet(result.buffer);
  assert.equal(sheet.getCell('B53').value, 'Install Panel - labor');
  assert.equal(sheet.getCell('C53').value, 24); // hours = FORGE quantity
  assert.equal(sheet.getCell('D53').value, 78); // 65 * 1.20 markup+GR = marked-up rate; 24 * 78 = 1872 = total_with_markup
});

test('unapproved child is excluded from the export', async () => {
  const job = baseJob();
  const rfps = [{ id: 3, contractor_name: 'Flooring' }];
  const itemsByRfp = {
    3: {
      items: [{ id: 30, parent_line_item_id: null, description: 'Supply Flooring', quantity: 0, total_cost: 0, total_with_markup: 0, approved: false, scope_type: 'supplier' }],
      subItemsMap: {
        30: [
          { id: 31, parent_line_item_id: 30, description: 'Approved bid', quantity: 5, vendor_cost: 20, contractor_cost: 0, markup_pct: 10, general_requirements_pct: 5, approved: true, scope_type: 'supplier' },
          { id: 32, parent_line_item_id: 30, description: 'Rejected alt bid', quantity: 5, vendor_cost: 18, contractor_cost: 0, markup_pct: 10, general_requirements_pct: 5, approved: false, scope_type: 'supplier' },
        ],
      },
    },
  };

  const result = await buildGinoskoExport(job, rfps, itemsByRfp);
  assert.equal(result.materialsCount, 1, 'only the approved bid should be exported');

  const sheet = await loadSheet(result.buffer);
  assert.equal(sheet.getCell('C31').value, 'Approved bid');
  assert.notEqual(sheet.getCell('C32').value, 'Rejected alt bid');
});

test('parent plus children are not double-counted', async () => {
  const job = baseJob();
  const rfps = [{ id: 4, contractor_name: 'Painting' }];
  const itemsByRfp = {
    4: {
      items: [{ id: 40, parent_line_item_id: null, description: 'Paint Job (rollup)', quantity: 999, total_cost: 999999, total_with_markup: 999999, approved: true, scope_type: 'contractor' }],
      subItemsMap: {
        40: [{ id: 41, parent_line_item_id: 40, description: 'Paint labor', quantity: 8, contractor_cost: 40, vendor_cost: 0, markup_pct: 16, general_requirements_pct: 4, approved: true, scope_type: 'contractor' }],
      },
    },
  };

  const result = await buildGinoskoExport(job, rfps, itemsByRfp);
  assert.equal(result.laborCount, 1);
  assert.equal(result.workbookTotal, 8 * 40 * 1.20);

  const sheet = await loadSheet(result.buffer);
  assert.equal(sheet.getCell('B53').value, 'Paint labor');
  assert.notEqual(sheet.getCell('B54').value, 'Paint Job (rollup)');
});

test('standalone approved parent (no children) is included', async () => {
  const job = baseJob();
  const rfps = [{ id: 5, contractor_name: 'Demo' }];
  const itemsByRfp = {
    5: {
      items: [{ id: 50, parent_line_item_id: null, description: 'Standalone demo supply', quantity: 3, contractor_cost: 0, vendor_cost: 50, total_cost: 150, markup_pct: 16, general_requirements_pct: 4, total_with_markup: 180, approved: true, scope_type: 'supplier' }],
      subItemsMap: {},
    },
  };

  const result = await buildGinoskoExport(job, rfps, itemsByRfp);
  assert.equal(result.materialsCount, 1);
  assert.equal(result.workbookTotal, 180);

  const sheet = await loadSheet(result.buffer);
  assert.equal(sheet.getCell('C31').value, 'Standalone demo supply');
  assert.equal(sheet.getCell('B31').value, 3);
  assert.equal(sheet.getCell('D31').value, 60); // 180 / 3
});

test('mixed markup and GR child lines reconcile to the penny', async () => {
  const job = baseJob();
  const rfps = [{ id: 6, contractor_name: 'Mixed Trades' }];
  const itemsByRfp = {
    6: {
      items: [
        { id: 60, parent_line_item_id: null, description: 'Supply parent', quantity: 0, total_cost: 0, total_with_markup: 0, approved: false, scope_type: 'supplier' },
        { id: 61, parent_line_item_id: null, description: 'Labor parent', quantity: 0, total_cost: 0, total_with_markup: 0, approved: false, scope_type: 'contractor' },
      ],
      subItemsMap: {
        60: [
          { id: 601, parent_line_item_id: 60, description: 'Supply A', quantity: 7, vendor_cost: 13.33, contractor_cost: 0, markup_pct: 22, general_requirements_pct: 3.5, approved: true, scope_type: 'supplier' },
          { id: 602, parent_line_item_id: 60, description: 'Supply B', quantity: 2, vendor_cost: 401.11, contractor_cost: 0, markup_pct: 0, general_requirements_pct: 0, approved: true, scope_type: 'supplier' },
        ],
        61: [
          { id: 611, parent_line_item_id: 61, description: 'Labor A', quantity: 15.5, contractor_cost: 47.25, vendor_cost: 0, markup_pct: 18, general_requirements_pct: 6, approved: true, scope_type: 'contractor' },
        ],
      },
    },
  };

  const result = await buildGinoskoExport(job, rfps, itemsByRfp);
  assert.ok(Math.abs(result.forgeTotal - result.workbookTotal) <= 0.01);
});

test('exported calculated total equals the FORGE approved total across multiple categories', async () => {
  const job = baseJob();
  const rfps = [
    { id: 7, contractor_name: 'Plumbing' },
    { id: 8, contractor_name: 'HVAC' },
  ];
  const itemsByRfp = {
    7: {
      items: [{ id: 70, parent_line_item_id: null, description: 'Plumbing supply parent', quantity: 0, total_cost: 0, total_with_markup: 0, approved: false, scope_type: 'supplier' }],
      subItemsMap: { 70: [{ id: 701, parent_line_item_id: 70, description: 'Fixtures', quantity: 4, vendor_cost: 88, contractor_cost: 0, markup_pct: 16, general_requirements_pct: 4, approved: true, scope_type: 'supplier' }] },
    },
    8: {
      items: [{ id: 80, parent_line_item_id: null, description: 'HVAC standalone', quantity: 1, contractor_cost: 500, vendor_cost: 0, total_cost: 500, markup_pct: 16, general_requirements_pct: 4, total_with_markup: 600, approved: true, scope_type: 'contractor' }],
      subItemsMap: {},
    },
  };

  const result = await buildGinoskoExport(job, rfps, itemsByRfp);
  assert.equal(result.forgeTotal, result.workbookTotal);
  function round2(n) { return Math.round(n * 100) / 100; }
  assert.equal(result.forgeTotal, round2(4 * 88 * 1.20) + 600);
});

test('extra rows are inserted when a template section is full, and formulas are re-ranged', async () => {
  const job = baseJob();
  const rfps = [{ id: 9, contractor_name: 'Overflow' }];
  const materialsChildren = Array.from({ length: 25 }, (_, i) => ({
    id: 9000 + i, parent_line_item_id: 900, description: 'Material ' + i, quantity: 2, vendor_cost: 10, contractor_cost: 0, markup_pct: 10, general_requirements_pct: 5, approved: true, scope_type: 'supplier',
  }));
  const laborChildren = Array.from({ length: 12 }, (_, i) => ({
    id: 9100 + i, parent_line_item_id: 901, description: 'Labor ' + i, quantity: 4, contractor_cost: 20, vendor_cost: 0, markup_pct: 10, general_requirements_pct: 5, approved: true, scope_type: 'contractor',
  }));
  const itemsByRfp = {
    9: {
      items: [
        { id: 900, parent_line_item_id: null, description: 'Materials parent', quantity: 0, total_cost: 0, total_with_markup: 0, approved: false, scope_type: 'supplier' },
        { id: 901, parent_line_item_id: null, description: 'Labor parent', quantity: 0, total_cost: 0, total_with_markup: 0, approved: false, scope_type: 'contractor' },
      ],
      subItemsMap: { 900: materialsChildren, 901: laborChildren },
    },
  };

  const result = await buildGinoskoExport(job, rfps, itemsByRfp);
  assert.equal(result.matExtra, 6);
  assert.equal(result.laborExtra, 3);
  assert.ok(Math.abs(result.forgeTotal - result.workbookTotal) <= 0.01, 'never silently omit an approved line — totals must still reconcile');

  const sheet = await loadSheet(result.buffer);
  assert.deepEqual(sheet.getCell('E56').value, { formula: 'SUM(E31:E55)' });
  assert.equal(sheet.getCell('C55').value, 'Material 24');
  assert.deepEqual(sheet.getCell('E71').value, { formula: 'SUM(E59:E70)' });
  assert.equal(sheet.getCell('B70').value, 'Labor 11');
});

test('original template file on disk is never modified', async () => {
  const before = fs.readFileSync(TEMPLATE_PATH);
  const beforeStat = fs.statSync(TEMPLATE_PATH);

  const job = baseJob();
  const rfps = [{ id: 1, contractor_name: 'Any' }];
  const itemsByRfp = { 1: { items: [{ id: 1, parent_line_item_id: null, description: 'x', quantity: 1, total_cost: 10, total_with_markup: 12, approved: true, scope_type: 'supplier' }], subItemsMap: {} } };
  await buildGinoskoExport(job, rfps, itemsByRfp);

  const after = fs.readFileSync(TEMPLATE_PATH);
  const afterStat = fs.statSync(TEMPLATE_PATH);
  assert.ok(before.equals(after), 'template bytes must be identical after export');
  assert.equal(beforeStat.mtimeMs, afterStat.mtimeMs, 'template mtime must be untouched');
});

test('reconciliation mismatch throws instead of silently shipping a bad workbook', async () => {
  delete require.cache[require.resolve('../src/services/rfp-export')];
  delete require.cache[require.resolve('../src/services/ginosko-export')];
  const rfpExportModule = require('../src/services/rfp-export');
  const originalFn = rfpExportModule._internal.computeProjectGrandTotal;
  rfpExportModule._internal.computeProjectGrandTotal = () => 999999.99;

  const freshGinoskoExport = require('../src/services/ginosko-export');

  try {
    const job = baseJob();
    const rfps = [{ id: 1, contractor_name: 'Any' }];
    const itemsByRfp = { 1: { items: [{ id: 1, parent_line_item_id: null, description: 'x', quantity: 1, total_cost: 10, total_with_markup: 12, approved: true, scope_type: 'supplier' }], subItemsMap: {} } };

    await assert.rejects(
      () => freshGinoskoExport.buildGinoskoExport(job, rfps, itemsByRfp),
      err => {
        assert.ok(err instanceof freshGinoskoExport.GinoskoReconciliationError);
        assert.equal(err.details.forgeTotal, 999999.99);
        assert.equal(err.details.workbookTotal, 12);
        assert.ok(err.details.diff > 0.01);
        return true;
      }
    );
  } finally {
    rfpExportModule._internal.computeProjectGrandTotal = originalFn;
    delete require.cache[require.resolve('../src/services/rfp-export')];
    delete require.cache[require.resolve('../src/services/ginosko-export')];
  }
});

test('route wiring: Ginosko exports (project-level and per-category) are registered under the same project access control as the other RFP exports', () => {
  const routesSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'rfp.js'), 'utf8');
  assert.match(
    routesSrc,
    /router\.get\('\/projects\/:id\/rfp\/export-ginosko\.xlsx',\s*requireRfpAccess,/,
    'whole-project export-ginosko.xlsx route must be mounted with requireRfpAccess, same as export.pdf/csv/xlsx'
  );
  assert.match(
    routesSrc,
    /router\.get\('\/projects\/:id\/rfps\/:rId\/export-ginosko\.xlsx',\s*requireRfpAccess,/,
    'per-category export-ginosko.xlsx route must be mounted with requireRfpAccess, same as the sibling per-category exports'
  );
  // The per-category route must verify the requested rfp actually belongs
  // to the project in the URL, since requireRfpAccess only checks :id, not
  // :rId — without this a user could pull another project's category data.
  assert.match(routesSrc, /String\(rfp\.job_id\)\s*!==\s*String\(req\.params\.id\)/);
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
  assert.match(appSrc, /app\.use\('\/',\s*requireAuth,\s*rfpRoutes\)/);
});

test('per-category build only includes the selected category, matching what the per-category route passes in', async () => {
  // Mirrors exactly what GET /projects/:id/rfps/:rId/export-ginosko.xlsx
  // does: a single rfp + only that rfp's items, never the whole project.
  const job = baseJob();
  const targetRfp = { id: 100, contractor_name: 'Selected Category', job_id: 42 };
  const otherRfpItems = { items: [{ id: 900, parent_line_item_id: null, description: 'Other category item', quantity: 1, contractor_cost: 0, vendor_cost: 1000, total_cost: 1000, total_with_markup: 1000, approved: true, scope_type: 'supplier' }], subItemsMap: {} };
  const targetItems = { items: [{ id: 101, parent_line_item_id: null, description: 'Selected category item', quantity: 2, contractor_cost: 0, vendor_cost: 25, total_cost: 50, markup_pct: 10, general_requirements_pct: 5, total_with_markup: 57.5, approved: true, scope_type: 'supplier' }], subItemsMap: {} };

  // Only the selected rfp is passed — exactly the route's contract.
  const result = await buildGinoskoExport(job, [targetRfp], { [targetRfp.id]: targetItems });
  assert.equal(result.materialsCount, 1);
  assert.equal(result.workbookTotal, 57.5);

  const sheet = await loadSheet(result.buffer);
  assert.equal(sheet.getCell('C31').value, 'Selected category item');
  assert.equal(sheet.getCell('C15').value, 'Selected Category');
  assert.doesNotMatch(String(sheet.getCell('C32').value || ''), /Other category item/);
  void otherRfpItems; // documents what must NOT leak in — never passed to buildGinoskoExport
});

test('filename is built dynamically from category + project, with unsafe characters stripped', () => {
  const job = baseJob({ title: 'Midway Square' });
  const rfps = [{ id: 1, contractor_name: '06-41 - Millwork & Finish Carpentry' }];
  const filename = ginoskoExport.buildGinoskoFilename(job, rfps);
  assert.equal(filename, '06-41 - Millwork & Finish Carpentry - Ginosko Bid Sheet - Midway Square.xlsx');

  const dirtyRfps = [{ id: 1, contractor_name: 'Weird/Trade:Name*?"<>|' }];
  const dirtyFilename = ginoskoExport.buildGinoskoFilename(job, dirtyRfps);
  assert.doesNotMatch(dirtyFilename, /[\\/:*?"<>|]/);
});

test('filename never exceeds 207 characters, even with very long category/project names', () => {
  const job = baseJob({ title: 'A'.repeat(150) });
  const rfps = [{ id: 1, contractor_name: 'B'.repeat(150) }];
  const filename = ginoskoExport.buildGinoskoFilename(job, rfps);
  assert.ok(filename.length <= ginoskoExport.MAX_FILENAME_LENGTH, `expected <= ${ginoskoExport.MAX_FILENAME_LENGTH} chars, got ${filename.length}`);
  assert.match(filename, /\.xlsx$/);

  // Short names must be completely unaffected by the cap.
  const shortJob = baseJob({ title: 'Midway Square' });
  const shortRfps = [{ id: 1, contractor_name: '06-41 - Millwork & Finish Carpentry' }];
  const shortFilename = ginoskoExport.buildGinoskoFilename(shortJob, shortRfps);
  assert.equal(shortFilename, '06-41 - Millwork & Finish Carpentry - Ginosko Bid Sheet - Midway Square.xlsx');
  assert.ok(shortFilename.length <= ginoskoExport.MAX_FILENAME_LENGTH);
});
