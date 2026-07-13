const { test } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const rfpExport = require('../src/services/rfp-export');

test('project RFP CSV export includes all categories and line items', () => {
  const rfps = [
    { id: 10, contractor_name: 'Plumbing & Fixtures', status: 'awarded' },
    { id: 11, contractor_name: 'Electrical', status: 'pending' },
  ];
  const itemsByRfp = {
    10: {
      items: [
        {
          id: 100,
          description: 'Provide shower head',
          quantity: 1,
          unit_cost: 120,
          total_cost: 120,
          markup_pct: 20,
          general_requirements_pct: 6,
          total_with_markup: 151.2,
          final_unit_cost: 151.2,
          approved: true,
        },
      ],
      subItemsMap: {
        100: [
          {
            id: 101,
            parent_line_item_id: 100,
            vendor: 'Ferguson',
            description: '\r\nSupply shower head',
            quantity: 1,
            unit_cost: 90,
            total_cost: 90,
            markup_pct: 20,
            general_requirements_pct: 6,
            total_with_markup: 113.4,
            final_unit_cost: 113.4,
            approved: true,
          },
        ],
      },
    },
    11: {
      items: [
        {
          id: 110,
          description: 'Replace panel',
          quantity: 2,
          unit_cost: 500,
          total_cost: 1000,
          markup_pct: 15,
          general_requirements_pct: 6,
          total_with_markup: 1210,
          final_unit_cost: 605,
          approved: false,
        },
      ],
      subItemsMap: {},
    },
  };

  const csv = rfpExport.renderProjectCsv({ title: 'Ashtabula Towers' }, rfps, itemsByRfp);

  assert.match(csv, /^Category,Status,Line Type,Vendor \/ Contractor,Description,/);
  assert.match(csv, /Plumbing & Fixtures,awarded,Line item,,Provide shower head/);
  assert.match(csv, /Plumbing & Fixtures,awarded,Sub-line item,Ferguson,Supply shower head/);
  assert.match(csv, /Electrical,pending,Line item,,Replace panel/);
  assert.doesNotMatch(csv, /parent_id|category_status|markup_pct|approved\r/);
});

test('project RFP exports derive parent quantity from approved sub-line quantity', () => {
  const rfps = [{ id: 18, contractor_name: 'Resilient Flooring', status: 'pending' }];
  const itemsByRfp = {
    18: {
      items: [{
        id: 116,
        description: 'R&R LVP Kitchen',
        quantity: 1,
        unit_cost: 0,
        total_cost: 0,
        total_with_markup: 0,
        final_unit_cost: 0,
        approved: false,
      }],
      subItemsMap: {
        116: [
          {
            id: 201,
            parent_line_item_id: 116,
            vendor: 'Main Flooring',
            description: 'Install kitchen LVP flooring',
            quantity: 166,
            unit_cost: 608,
            total_cost: 100928,
            markup_pct: 18,
            general_requirements_pct: 4,
            total_with_markup: 123132.16,
            final_unit_cost: 741.76,
            approved: true,
          },
          {
            id: 202,
            parent_line_item_id: 116,
            vendor: 'Main Flooring',
            description: 'Supply Kitchen LVT',
            quantity: 166,
            unit_cost: 304,
            total_cost: 50464,
            markup_pct: 18,
            general_requirements_pct: 4,
            total_with_markup: 61566.08,
            final_unit_cost: 370.88,
            approved: true,
          },
        ],
      },
    },
  };

  const csv = rfpExport.renderProjectCsv({ title: 'Midway Square Apartments' }, rfps, itemsByRfp);

  assert.match(csv, /Resilient Flooring,pending,Line item,,R&R LVP Kitchen,166\.00,912\.00,"151,392\.00"/);
  assert.match(csv, /"184,698\.24","1,112\.64"/);
});

test('project RFP exports recompute child totals when zero markup and GR are saved', () => {
  const rfps = [{ id: 18, contractor_name: 'Resilient Flooring', status: 'pending' }];
  const itemsByRfp = {
    18: {
      items: [{
        id: 468,
        description: 'Dumpster',
        quantity: 1,
        unit_cost: 0,
        total_cost: 0,
        total_with_markup: 0,
        final_unit_cost: 0,
        approved: false,
      }],
      subItemsMap: {
        468: [
          {
            id: 469,
            parent_line_item_id: 468,
            vendor: 'Recon',
            description: 'Supply 3 months dumpster',
            quantity: 3,
            unit_cost: 1000,
            total_cost: 3000,
            markup_pct: 0,
            general_requirements_pct: 0,
            total_with_markup: 3780,
            final_unit_cost: 1260,
            approved: true,
          },
        ],
      },
    },
  };

  const csv = rfpExport.renderProjectCsv({ title: 'Midway Square Apartments' }, rfps, itemsByRfp);

  assert.match(csv, /Resilient Flooring,pending,Line item,,Dumpster,3\.00,"1,000\.00","3,000\.00"/);
  assert.match(csv, /"3,000\.00","1,000\.00"/);
  assert.doesNotMatch(csv, /3,780\.00|1,260\.00/);
});

test('project RFP PDF normalizes copied line-item whitespace', async () => {
  assert.equal(
    rfpExport._internal.pdfText('\r\nProvide and install new sink, trim and faucet in kitchens'),
    'Provide and install new sink, trim and faucet in kitchens'
  );

  const pdf = await rfpExport.renderProjectPdf(
    { title: 'Ashtabula Towers' },
    [{ id: 10, contractor_name: 'Plumbing & Fixtures', status: 'awarded' }],
    {
      10: {
        items: [{
          id: 100,
          description: '\r\nProvide pricing to turn off each units water supply, cut back all water supply and drain line and cap in proper locations for new cabinet installation',
          quantity: 1,
          total_cost: 0,
          markup_pct: 20,
          general_requirements_pct: 6,
          total_with_markup: 0,
          approved: true,
        }],
        subItemsMap: {},
      },
    },
    { createdBy: 'Michael Reoch' }
  );

  assert.ok(Buffer.isBuffer(pdf));
  assert.ok(pdf.length > 1000);
});

test('selected bid request PDF renders only chosen lines across categories', async () => {
  const pdf = await rfpExport.renderSelectedBidRequestPdf(
    { title: 'Ashtabula Towers', address: '100 Main', city: 'Detroit', state: 'MI', zip: '48201' },
    [
      {
        id: 100,
        rfp_id: 10,
        project_rfps: { id: 10, contractor_name: 'Cabinets', notes: 'Include shop drawings.' },
        description: 'Cabinet install at kitchens',
        quantity: 14,
        sort_order: 1,
      },
      {
        id: 200,
        rfp_id: 11,
        project_rfps: { id: 11, contractor_name: 'Countertops', notes: 'Field verify all dimensions.' },
        description: 'Quartz tops at kitchens',
        quantity: 14,
        sort_order: 1,
      },
    ],
    'Hardrock Stoneworks'
  );

  assert.ok(Buffer.isBuffer(pdf));
  assert.ok(pdf.length > 1000);
});

test('project RFP XLSX export aligns readable columns', async () => {
  const rfps = [{ id: 10, contractor_name: 'Plumbing & Fixtures', status: 'awarded' }];
  const itemsByRfp = {
    10: {
      items: [{
        id: 100,
        description: 'Provide shower head',
        quantity: 1,
        unit_cost: 120,
        total_cost: 120,
        markup_pct: 20,
        general_requirements_pct: 6,
        total_with_markup: 151.2,
        final_unit_cost: 151.2,
        approved: true,
      }],
      subItemsMap: {},
    },
  };

  const buffer = await rfpExport.renderProjectXlsx({ title: 'Ashtabula Towers' }, rfps, itemsByRfp);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet('RFP');

  assert.equal(sheet.getCell('A1').value, 'Category');
  assert.equal(sheet.getCell('B1').value, 'Status');
  assert.equal(sheet.getCell('C1').value, 'Line Type');
  assert.equal(sheet.getCell('A2').value, 'Plumbing & Fixtures');
  assert.equal(sheet.getCell('B2').value, 'awarded');
  assert.equal(sheet.getCell('C2').value, 'Line item');
  assert.equal(sheet.getCell('E2').value, 'Provide shower head');
  assert.equal(sheet.getCell('M2').value, 'Yes');
});
