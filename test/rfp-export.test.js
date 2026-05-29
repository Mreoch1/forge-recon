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
