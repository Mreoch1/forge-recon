const { test } = require('node:test');
const assert = require('node:assert/strict');
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
      subItemsMap: {},
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

  assert.match(csv, /^category,category_status,parent_id,level,/);
  assert.match(csv, /Plumbing & Fixtures,awarded,,parent,,Provide shower head/);
  assert.match(csv, /Electrical,pending,,parent,,Replace panel/);
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
