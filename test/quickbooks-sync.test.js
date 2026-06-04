const test = require('node:test');
const assert = require('node:assert/strict');

const quickbooks = require('../src/services/quickbooks-sync');

test('QuickBooks invoice payload preserves Forge number, PO, customer, and lines', () => {
  process.env.QUICKBOOKS_DEFAULT_ITEM_ID = '42';
  process.env.QUICKBOOKS_PO_CUSTOM_FIELD_ID = '3';
  const invoice = {
    id: 13,
    display_number: 'INV-0042-0000',
    created_at: '2026-06-04T12:00:00Z',
    sent_at: '2026-06-04T13:00:00Z',
    due_date: '2026-07-04',
    customer_po_number: 'PO-7788',
    customer_billing_email: 'ap@example.com',
    customer_email: 'contact@example.com',
    customer_address: '36761 Amrhein Rd',
    customer_city: 'Livonia',
    customer_state: 'MI',
    customer_zip: '48150',
    job_address: '325 West 48th Street',
    job_city: 'Ashtabula',
    job_state: 'OH',
    job_zip: '44004',
    notes: 'Office note',
    conditions: 'Net 30',
    tax_amount: 0,
    lines: [{
      description: 'R&R ceramic tub surround',
      quantity: 1,
      unit_price: 1595,
      line_total: 1595,
    }],
  };

  const payload = quickbooks.buildInvoicePayload(invoice, '7');
  assert.equal(payload.CustomerRef.value, '7');
  assert.equal(payload.DocNumber, 'INV-0042-0000');
  assert.equal(payload.DueDate, '2026-07-04');
  assert.equal(payload.BillEmail.Address, 'ap@example.com');
  assert.equal(payload.CustomField[0].StringValue, 'PO-7788');
  assert.match(payload.PrivateNote, /Forge invoice id: 13/);
  assert.equal(payload.Line[0].SalesItemLineDetail.ItemRef.value, '42');
  assert.equal(payload.Line[0].Amount, 1595);
});

test('QuickBooks invoice payload refuses unmapped product/service item', () => {
  const previous = process.env.QUICKBOOKS_DEFAULT_ITEM_ID;
  delete process.env.QUICKBOOKS_DEFAULT_ITEM_ID;
  assert.throws(() => quickbooks.buildInvoicePayload({
    id: 1,
    display_number: 'INV-0001-0000',
    tax_amount: 0,
    lines: [{ description: 'Labor', quantity: 1, unit_price: 10, line_total: 10 }],
  }, '9'), /QUICKBOOKS_DEFAULT_ITEM_ID/);
  if (previous) process.env.QUICKBOOKS_DEFAULT_ITEM_ID = previous;
});
