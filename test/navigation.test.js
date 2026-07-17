const assert = require('node:assert/strict');
const test = require('node:test');

const {
  decorateCustomerPickerOptions,
  decorateProjectPickerOptions,
  getBackButtonState,
} = require('../src/services/navigation');

test('back button covers authenticated pages with context-aware fallbacks', () => {
  assert.deepEqual(getBackButtonState('/'), { show: false, fallback: '/' });
  assert.deepEqual(getBackButtonState('/work-orders'), { show: true, fallback: '/' });
  assert.deepEqual(getBackButtonState('/work-orders/171'), { show: true, fallback: '/work-orders' });
  assert.deepEqual(getBackButtonState('/work-orders/171/edit'), { show: true, fallback: '/work-orders/171' });
  assert.deepEqual(getBackButtonState('/files/projects/18'), { show: true, fallback: '/projects/18' });
  assert.deepEqual(getBackButtonState('/projects/18/submittals'), { show: true, fallback: '/projects/18' });
});

test('customer and project pickers are location-aware and remain unique', () => {
  const customers = decorateCustomerPickerOptions([
    { id: 1, name: 'Lakeland Place', address: '100 Main St', city: 'Detroit', state: 'MI' },
    { id: 2, name: 'Lakeland Place', address: '100 Main St', city: 'Detroit', state: 'MI' },
  ]);
  assert.equal(customers[0].picker_label, 'Lakeland Place - 100 Main St, Detroit, MI (#1)');
  assert.equal(customers[1].picker_label, 'Lakeland Place - 100 Main St, Detroit, MI (#2)');

  const projects = decorateProjectPickerOptions([
    { id: 7, title: 'Unit Renovation', customer_name: 'Lakeland Place', city: 'Detroit', state: 'MI' },
  ]);
  assert.equal(projects[0].picker_label, 'Unit Renovation - Lakeland Place - Detroit, MI');
});
