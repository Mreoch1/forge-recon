/**
 * PDF generation for estimates / work orders / invoices.
 *
 * Built on pdfkit. Each generator streams to a Writable (the Express
 * response object). Call sites set Content-Type + Content-Disposition
 * headers BEFORE invoking the generator.
 *
 * Layout style (Letter, 612x792 pts, 50pt margins):
 *
 *   +--------------------------------------------------+
 *   | [LOGO]                          [COMPANY INFO]   |
 *   |                                                  |
 *   |  ESTIMATE                                        |
 *   |  EST-2026-0001                                   |
 *   |                                                  |
 *   |  BILL TO              JOB SITE                   |
 *   |  Customer name        Job address                |
 *   |  ...                  ...                        |
 *   |                                                  |
 *   |  +------------------------------------------+    |
 *   |  | TRADE | DESCR | QTY | UNIT | $/U |  $/L |    |
 *   |  | ...                                       |    |
 *   |  +------------------------------------------+    |
 *   |                                                  |
 *   |                            Subtotal     $XX.XX  |
 *   |                            Tax (X%)     $X.XX   |
 *   |                            ----                  |
 *   |                            TOTAL        $XX.XX  |
 *   |                                                  |
 *   |  Notes:                                          |
 *   |  ...                                             |
 *   |                                                  |
 *   |  Valid until: ... | Created: ...                 |
 *   +--------------------------------------------------+
 *
 * Theme colors mirror the web UI: red accents, charcoal text, fog grey
 * for muted labels, mist for borders, cloud for table header bg.
 */

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const LOGO_PATH = path.join(__dirname, '..', '..', 'public', 'logos', 'recon-logo.jpg');

const COLOR = {
  red:      '#c0202b',
  charcoal: '#1a1a1a',
  ash:      '#3d3d3d',
  fog:      '#888888',
  mist:     '#e5e5e5',
  cloud:    '#f5f5f5',
};

function fmt(n) {
  const num = Number(n);
  if (!isFinite(num)) return '0.00';
  return num.toFixed(2);
}

function fmtMoney(n) {
  return '$' + fmt(n);
}

// --- header ---

const LOGO_HEIGHT = 110;

function drawHeader(doc, company) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const top = doc.page.margins.top;

  // Logo (graceful fallback to text) -- enlarged
  if (fs.existsSync(LOGO_PATH)) {
    try {
      doc.image(LOGO_PATH, left, top, { fit: [220, LOGO_HEIGHT], align: 'left' });
    } catch (e) {
      doc.fillColor(COLOR.charcoal).fontSize(20).font('Helvetica-Bold').text(company.company_name || 'Recon Enterprises', left, top);
    }
  } else {
    doc.fillColor(COLOR.charcoal).fontSize(20).font('Helvetica-Bold').text(company.company_name || 'Recon Enterprises', left, top);
  }

  // Company block (right-aligned)
  const companyLines = [
    company.company_name || 'Recon Enterprises',
    company.address || '',
    [company.city, company.state, company.zip].filter(Boolean).join(', '),
    company.phone || '',
    company.email || '',
  ].filter(Boolean);

  let y = top;
  doc.fontSize(9).font('Helvetica').fillColor(COLOR.ash);
  companyLines.forEach((line, i) => {
    if (i === 0) doc.fillColor(COLOR.charcoal).font('Helvetica-Bold');
    else doc.fillColor(COLOR.ash).font('Helvetica');
    doc.text(line, left, y, { width: right - left, align: 'right' });
    y += i === 0 ? 14 : 11;
  });

  // Ensure subsequent content clears the (now larger) logo.
  doc.y = Math.max(y, top + LOGO_HEIGHT + 6);
}

// --- title ---

function drawTitle(doc, label, number, status) {
  const left = doc.page.margins.left;
  doc.moveDown(2);
  const y = doc.y + 20;
  doc.fillColor(COLOR.charcoal).fontSize(28).font('Helvetica-Bold').text(label.toUpperCase(), left, y);
  doc.fillColor(COLOR.red).fontSize(14).font('Helvetica').text(number, left, doc.y + 2);
  if (status) {
    doc.fillColor(COLOR.fog).fontSize(9).font('Helvetica').text(`Status: ${status}`, left, doc.y + 2);
  }
  doc.moveDown(1.2);
}

// --- bill to / job site ---

function drawAddressBlocks(doc, billTo, jobSite) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const colWidth = (right - left - 20) / 2;
  const y = doc.y;

  function block(x, label, lines) {
    doc.fillColor(COLOR.fog).fontSize(8).font('Helvetica-Bold').text(label.toUpperCase(), x, y);
    let ly = doc.y + 2;
    doc.fillColor(COLOR.charcoal).fontSize(10).font('Helvetica');
    lines.filter(Boolean).forEach((line, i) => {
      if (i === 0) doc.font('Helvetica-Bold');
      else doc.font('Helvetica');
      doc.text(line, x, ly, { width: colWidth });
      ly = doc.y;
    });
    return ly;
  }

  const yLeft = block(left, 'Bill to', billTo);
  const yRight = block(left + colWidth + 20, 'Job site', jobSite);
  doc.y = Math.max(yLeft, yRight) + 10;
}

// --- line items table ---

function drawLineItemsTable(doc, lines) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const tableWidth = right - left;
  const cols = [
    { key: 'description', label: 'DESCRIPTION', width: tableWidth - 50 - 50 - 65 - 70, align: 'left' },
    { key: 'quantity',    label: 'QTY',         width: 50,  align: 'right' },
    { key: 'unit',        label: 'UNIT',        width: 50,  align: 'left' },
    { key: 'unit_price',  label: 'UNIT $',      width: 65,  align: 'right' },
    { key: 'line_total',  label: 'LINE $',      width: 70,  align: 'right' },
  ];

  let y = doc.y;
  const headerHeight = 22;
  const rowHeight = 18;

  // Header background
  doc.fillColor(COLOR.cloud).rect(left, y, tableWidth, headerHeight).fill();

  // Header text
  doc.fillColor(COLOR.fog).fontSize(8).font('Helvetica-Bold');
  let cx = left;
  cols.forEach(c => {
    doc.text(c.label, cx + 6, y + 7, { width: c.width - 12, align: c.align });
    cx += c.width;
  });
  y += headerHeight;

  // Rows
  doc.fontSize(9).font('Helvetica').fillColor(COLOR.charcoal);
  lines.forEach((li, i) => {
    // D-108: measure actual row height — descriptions with newlines or long
    // text need to wrap onto multiple lines. Previously rowHeight was fixed at
    // 18px and overflow lines would render ON TOP OF the next row.
    let maxCellHeight = rowHeight - 10; // baseline minus padding
    cols.forEach(c => {
      let val = li[c.key];
      if (c.key === 'unit_price' || c.key === 'line_total') val = fmtMoney(val);
      else if (c.key === 'quantity') val = String(val);
      else val = String(val == null ? '' : val);
      const cellH = doc.heightOfString(val, { width: c.width - 12, align: c.align });
      if (cellH > maxCellHeight) maxCellHeight = cellH;
    });
    const actualRowHeight = Math.max(rowHeight, maxCellHeight + 10); // +10 = top+bottom padding

    // Page break if this row won't fit
    if (y + actualRowHeight > doc.page.height - doc.page.margins.bottom - 100) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    cx = left;
    cols.forEach(c => {
      let val = li[c.key];
      if (c.key === 'unit_price' || c.key === 'line_total') val = fmtMoney(val);
      else if (c.key === 'quantity') val = String(val);
      else val = String(val == null ? '' : val);
      doc.text(val, cx + 6, y + 5, { width: c.width - 12, align: c.align });
      cx += c.width;
    });
    // Bottom border at the bottom of the actual (variable) row height
    doc.strokeColor(COLOR.mist).lineWidth(0.5)
      .moveTo(left, y + actualRowHeight).lineTo(left + tableWidth, y + actualRowHeight).stroke();
    y += actualRowHeight;
  });

  doc.y = y + 10;
}

// --- totals block (right-aligned) ---

function drawTotals(doc, { subtotal, tax_rate, tax_amount, total }) {
  const right = doc.page.width - doc.page.margins.right;
  const colW = 200;
  const x = right - colW;
  let y = doc.y;

  doc.fontSize(10).font('Helvetica').fillColor(COLOR.ash);
  doc.text('Subtotal', x, y, { width: colW * 0.6, align: 'right' });
  doc.fillColor(COLOR.charcoal).text(fmtMoney(subtotal), x + colW * 0.6, y, { width: colW * 0.4, align: 'right' });
  y += 16;

  const taxRateLabel = `Tax (${fmt(tax_rate)}%)`;
  doc.fillColor(COLOR.ash).text(taxRateLabel, x, y, { width: colW * 0.6, align: 'right' });
  doc.fillColor(COLOR.charcoal).text(fmtMoney(tax_amount), x + colW * 0.6, y, { width: colW * 0.4, align: 'right' });
  y += 16;

  // Divider
  doc.strokeColor(COLOR.charcoal).lineWidth(1).moveTo(x, y).lineTo(right, y).stroke();
  y += 6;

  doc.fontSize(13).font('Helvetica-Bold').fillColor(COLOR.charcoal);
  doc.text('TOTAL', x, y, { width: colW * 0.6, align: 'right' });
  doc.fillColor(COLOR.red).text(fmtMoney(total), x + colW * 0.6, y, { width: colW * 0.4, align: 'right' });

  doc.y = y + 22;
}

// --- notes / footer ---

function drawNotes(doc, notes) {
  if (!notes) return;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  doc.fillColor(COLOR.fog).fontSize(8).font('Helvetica-Bold').text('NOTES', left, doc.y);
  doc.fillColor(COLOR.charcoal).fontSize(10).font('Helvetica').text(notes, left, doc.y + 4, {
    width: right - left
  });
  doc.moveDown(1);
}

function drawTextBlock(doc, title, text) {
  if (!text) return;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  if (doc.y > doc.page.height - doc.page.margins.bottom - 90) doc.addPage();
  doc.fillColor(COLOR.fog).fontSize(8).font('Helvetica-Bold').text(String(title || '').toUpperCase(), left, doc.y);
  doc.fillColor(COLOR.charcoal).fontSize(10).font('Helvetica').text(String(text), left, doc.y + 4, {
    width: right - left,
    lineGap: 2
  });
  doc.moveDown(1.2);
}

// --- signature block (estimates) ---

function drawSignatureBlock(doc) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const tableWidth = right - left;

  // Reserve room: if not enough, page-break first.
  const blockHeight = 110;
  if (doc.y > doc.page.height - doc.page.margins.bottom - blockHeight - 30) {
    doc.addPage();
  }

  doc.moveDown(1);
  let y = doc.y;

  // Header
  doc.fillColor(COLOR.fog).fontSize(8).font('Helvetica-Bold')
    .text('ACCEPTANCE OF ESTIMATE', left, y);
  y = doc.y + 4;

  doc.fillColor(COLOR.ash).fontSize(9).font('Helvetica')
    .text(
      'The above prices, specifications and conditions are satisfactory and are hereby accepted. ' +
      'You are authorized to do the work as specified. Payment will be made as outlined above.',
      left, y, { width: tableWidth }
    );
  y = doc.y + 14;

  // Signature line + date line, side by side
  const sigW = tableWidth * 0.62;
  const dateW = tableWidth - sigW - 20;
  const sigX = left;
  const dateX = left + sigW + 20;
  const lineY = y + 22;

  doc.strokeColor(COLOR.charcoal).lineWidth(0.8)
    .moveTo(sigX, lineY).lineTo(sigX + sigW, lineY).stroke();
  doc.strokeColor(COLOR.charcoal).lineWidth(0.8)
    .moveTo(dateX, lineY).lineTo(dateX + dateW, lineY).stroke();

  doc.fillColor(COLOR.fog).fontSize(8).font('Helvetica')
    .text('Sign here', sigX, lineY + 4, { width: sigW });
  doc.fillColor(COLOR.fog).fontSize(8).font('Helvetica')
    .text('Date', dateX, lineY + 4, { width: dateW });

  // Return-to instruction (bold, red accent)
  const instrY = lineY + 22;
  doc.fillColor(COLOR.red).fontSize(10).font('Helvetica-Bold')
    .text('Please sign, date and return to Office@reconenterprises.net',
      left, instrY, { width: tableWidth, align: 'center' });

  doc.y = instrY + 18;
}

// --- payment terms (invoices) ---

function drawPaymentTerms(doc, invoice, company) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const tableWidth = right - left;

  // Prefer company- or invoice-level terms; fall back to a sensible default.
  const terms =
    (invoice && invoice.payment_terms) ||
    (company && (company.default_payment_terms || company.payment_terms)) ||
    'Net 30 -- payment due within 30 days of invoice date. ' +
    'A finance charge of 1.5% per month (18% per annum) will be applied to past-due balances. ' +
    'Make checks payable to Recon Enterprises. For questions, contact Office@reconenterprises.net.';

  // Reserve a bit of room; page-break if tight.
  if (doc.y > doc.page.height - doc.page.margins.bottom - 80) {
    doc.addPage();
  }

  doc.moveDown(0.5);
  const y = doc.y;
  doc.fillColor(COLOR.fog).fontSize(8).font('Helvetica-Bold')
    .text('PAYMENT TERMS', left, y);
  doc.fillColor(COLOR.charcoal).fontSize(9).font('Helvetica')
    .text(terms, left, doc.y + 4, { width: tableWidth });
  doc.moveDown(0.8);
}

function drawFooterMeta(doc, lines) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const y = doc.page.height - doc.page.margins.bottom - 18;
  doc.fontSize(8).fillColor(COLOR.fog).font('Helvetica');
  doc.text(lines.filter(Boolean).join('   |   '), left, y, { width: right - left, align: 'center' });
}

// --- public: estimate ---

function generateEstimatePDF(estimate, company, stream) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 50, info: {
    Title: estimate.estimate_number,
    Subject: `Estimate for ${estimate.customer_name || ''}`,
    Author: company.company_name || 'Recon Enterprises',
  }});
  doc.pipe(stream);

  drawHeader(doc, company);
  drawTitle(doc, 'Estimate', estimate.estimate_number, estimate.status);

  drawAddressBlocks(doc, [
    estimate.customer_name,
    estimate.customer_address || '',
    [estimate.customer_city, estimate.customer_state, estimate.customer_zip].filter(Boolean).join(', '),
    estimate.customer_email,
    estimate.customer_phone,
  ], [
    estimate.job_title,
    estimate.unit_number ? `Unit ${String(estimate.unit_number).replace(/^(Unit|Apt)\s*/i, '')}` : '',  // R37j: surface unit on estimate PDF, strip duplicate prefix
    estimate.job_address || '',
    [estimate.job_city, estimate.job_state, estimate.job_zip].filter(Boolean).join(', '),
  ].filter(Boolean));

  drawLineItemsTable(doc, estimate.lines || []);

  drawTotals(doc, {
    subtotal: estimate.subtotal,
    tax_rate: estimate.tax_rate,
    tax_amount: estimate.tax_amount,
    total: estimate.total,
  });

  if (estimate.notes) drawNotes(doc, estimate.notes);

  drawPaymentTerms(doc, estimate, company);

  // Customer signature / acceptance block + return-to instruction
  drawSignatureBlock(doc);

  const footerLines = [];
  if (estimate.created_at) footerLines.push(`Created: ${String(estimate.created_at).slice(0,10)}`);
  if (estimate.valid_until) footerLines.push(`Valid until: ${String(estimate.valid_until).slice(0,10)}`);
  if (estimate.sent_at) footerLines.push(`Sent: ${String(estimate.sent_at).slice(0,10)}`);
  drawFooterMeta(doc, footerLines);

  doc.end();
}

// --- public: work order ---

function drawWOLineItems(doc, lines) {
  // WO line items — description only, no pricing or checkboxes.
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const tableWidth = right - left;
  const cols = [
    { key: 'description', label: 'DESCRIPTION', width: tableWidth - 50 - 50, align: 'left' },
    { key: 'quantity',    label: 'QTY',         width: 50,  align: 'right' },
    { key: 'unit',        label: 'UNIT',        width: 50,  align: 'left' },
  ];

  let y = doc.y;
  const headerHeight = 22;
  const rowHeight = 18;

  doc.fillColor(COLOR.cloud).rect(left, y, tableWidth, headerHeight).fill();
  doc.fillColor(COLOR.fog).fontSize(8).font('Helvetica-Bold');
  let cx = left;
  cols.forEach(c => {
    doc.text(c.label, cx + 6, y + 7, { width: c.width - 12, align: c.align });
    cx += c.width;
  });
  y += headerHeight;

  doc.fontSize(9).font('Helvetica').fillColor(COLOR.charcoal);
  lines.forEach((li) => {
    // D-108: measure actual row height to handle multi-line descriptions cleanly.
    let maxCellHeight = rowHeight - 10;
    cols.forEach(c => {
      let val;
      if (c.key === 'unit_price' || c.key === 'line_total') val = fmtMoney(li[c.key]);
      else if (c.key === 'quantity')  val = String(li.quantity);
      else                            val = String(li[c.key] == null ? '' : li[c.key]);
      const cellH = doc.heightOfString(val, { width: c.width - 12, align: c.align });
      if (cellH > maxCellHeight) maxCellHeight = cellH;
    });
    const actualRowHeight = Math.max(rowHeight, maxCellHeight + 10);

    if (y + actualRowHeight > doc.page.height - doc.page.margins.bottom - 100) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    cx = left;
    cols.forEach(c => {
      let val;
      if (c.key === 'unit_price' || c.key === 'line_total') val = fmtMoney(li[c.key]);
      else if (c.key === 'quantity')  val = String(li.quantity);
      else                            val = String(li[c.key] == null ? '' : li[c.key]);
      doc.text(val, cx + 6, y + 5, { width: c.width - 12, align: c.align });
      cx += c.width;
    });
    doc.strokeColor(COLOR.mist).lineWidth(0.5)
      .moveTo(left, y + actualRowHeight).lineTo(left + tableWidth, y + actualRowHeight).stroke();
    y += actualRowHeight;
  });

  doc.y = y + 10;
}

function drawWOMeta(doc, wo) {
  // 3-column meta strip: Status, Scheduled, Assigned to
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const tableWidth = right - left;
  const cellW = tableWidth / 3;
  let y = doc.y;

  doc.fillColor(COLOR.cloud).rect(left, y, tableWidth, 36).fill();

  function cell(idx, label, value) {
    const x = left + cellW * idx;
    doc.fillColor(COLOR.fog).fontSize(7).font('Helvetica-Bold').text(label.toUpperCase(), x + 8, y + 5, { width: cellW - 16 });
    doc.fillColor(COLOR.charcoal).fontSize(11).font('Helvetica-Bold').text(value || '—', x + 8, y + 17, { width: cellW - 16 });
  }
  cell(0, 'Status', (wo.status || '').replace('_', ' '));
  cell(1, 'Scheduled', wo.scheduled_date ? String(wo.scheduled_date).slice(0,10) : '—');
  cell(2, 'Assigned to', wo.assigned_to || '—');

  doc.y = y + 36 + 12;
}

function generateWorkOrderPDF(wo, company, stream) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 50, info: {
    Title: wo.wo_number,
    Subject: `Work order for ${wo.customer_name || ''}`,
    Author: company.company_name || 'Recon Enterprises',
  }});
  doc.pipe(stream);

  drawHeader(doc, company);
  drawTitle(doc, 'Work Order', wo.wo_number, wo.status);

  drawAddressBlocks(doc, [
    wo.customer_name,
    wo.customer_address || '',
    [wo.customer_city, wo.customer_state, wo.customer_zip].filter(Boolean).join(', '),
    wo.customer_email,
    wo.customer_phone,
  ], [
    wo.job_title || (wo.customer_name ? wo.customer_name + ' (job site)' : 'Job Site'),
    wo.unit_number ? `Unit ${String(wo.unit_number).replace(/^(Unit|Apt)\s*/i, '')}` : '',
    (wo.job_address || wo.customer_address || ''),
    ([wo.job_city || wo.customer_city, wo.job_state || wo.customer_state, wo.job_zip || wo.customer_zip].filter(Boolean).join(', ')),
  ]);

  drawWOMeta(doc, wo);
  drawTextBlock(doc, 'Description', wo.description);
  // Remove completed column from WO line items — WOs use descriptions, not checklists
  drawWOLineItems(doc, (wo.lines || []).map(li => ({ ...li, completed: undefined })));

  const footerLines = [];
  if (wo.created_at) footerLines.push(`Issued: ${String(wo.created_at).slice(0,10)}`);
  if (wo.estimate_number) footerLines.push(`From estimate: ${wo.estimate_number}`);
  drawFooterMeta(doc, footerLines);

  doc.end();
}

// --- public: invoice ---

function drawInvoiceMeta(doc, invoice) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const tableWidth = right - left;
  const cellW = tableWidth / 4;
  let y = doc.y;

  doc.fillColor(COLOR.cloud).rect(left, y, tableWidth, 36).fill();
  function cell(idx, label, value) {
    const x = left + cellW * idx;
    doc.fillColor(COLOR.fog).fontSize(7).font('Helvetica-Bold').text(label.toUpperCase(), x + 8, y + 5, { width: cellW - 16 });
    doc.fillColor(COLOR.charcoal).fontSize(11).font('Helvetica-Bold').text(value || '—', x + 8, y + 17, { width: cellW - 16 });
  }
  cell(0, 'Issued', invoice.created_at ? String(invoice.created_at).slice(0,10) : '—');
  cell(1, 'Due', invoice.due_date ? String(invoice.due_date).slice(0,10) : '—');
  cell(2, 'Terms', invoice.payment_terms || '—');
  cell(3, 'Balance due', fmtMoney((Number(invoice.total)||0) - (Number(invoice.amount_paid)||0)));

  doc.y = y + 36 + 12;
}

function generateInvoicePDF(invoice, company, stream) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 50, info: {
    Title: invoice.invoice_number,
    Subject: `Invoice for ${invoice.customer_name || ''}`,
    Author: company.company_name || 'Recon Enterprises',
  }});
  doc.pipe(stream);

  drawHeader(doc, company);
  drawTitle(doc, 'Invoice', invoice.invoice_number);

  drawAddressBlocks(doc, [
    invoice.customer_name,
    invoice.customer_address || '',
    [invoice.customer_city, invoice.customer_state, invoice.customer_zip].filter(Boolean).join(', '),
    invoice.customer_email,
    invoice.customer_phone,
  ], [
    invoice.job_title,
    invoice.unit_number ? `Unit ${String(invoice.unit_number).replace(/^(Unit|Apt)\s*/i, '')}` : '',  // R37j: surface unit on invoice PDF, strip duplicate prefix
    invoice.job_address || '',
    [invoice.job_city, invoice.job_state, invoice.job_zip].filter(Boolean).join(', '),
  ].filter(Boolean));

  drawInvoiceMeta(doc, invoice);
  drawLineItemsTable(doc, (invoice.lines || []).map(li => ({
    description: li.description,
    quantity: li.quantity,
    unit: li.unit,
    unit_price: li.unit_price,
    line_total: li.line_total,
  })));

  drawTotals(doc, {
    subtotal: invoice.subtotal,
    tax_rate: invoice.tax_rate,
    tax_amount: invoice.tax_amount,
    total: invoice.total,
  });

  // Conditions
  if (invoice.conditions) {
    drawNotes(doc, 'Conditions: ' + invoice.conditions);
  }

  // Balance due (total - paid) prominently on its own line if anything outstanding
  const balanceDue = (Number(invoice.total) || 0) - (Number(invoice.amount_paid) || 0);
  if (balanceDue > 0) {
    const right = doc.page.width - doc.page.margins.right;
    const colW = 200;
    const x = right - colW;
    doc.fontSize(10).fillColor(COLOR.ash).font('Helvetica');
    doc.text('Amount due', x, doc.y, { width: colW * 0.6, align: 'right' });
    doc.fillColor(COLOR.red).font('Helvetica-Bold').fontSize(13)
       .text(fmtMoney(balanceDue), x + colW * 0.6, doc.y - 12, { width: colW * 0.4, align: 'right' });
    doc.moveDown(1.5);
  }

  if (invoice.notes) drawNotes(doc, invoice.notes);

  // Payment terms block (configurable via company/invoice, with default)
  drawPaymentTerms(doc, invoice, company);

  // PAID stamp — large diagonal red overlay when invoice is paid (D-067h)
  // D-110: moved up from 35% → 18% of page height so the stamp lands in the
  // empty space above BILL TO / JOB SITE / dates row instead of blocking them.
  if (invoice.status === 'PAID' || invoice.status === 'paid' || invoice.paid_at) {
    const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const pageH = doc.page.height - doc.page.margins.top - doc.page.margins.bottom;
    const stampY = doc.page.margins.top + pageH * 0.18;
    doc.save();
    doc.fontSize(72).fillColor(180, 30, 30, 0.2).font('Helvetica-Bold');
    doc.translate(doc.page.margins.left + pageW * 0.55, stampY);
    doc.rotate(-15, { origin: [0, 0] });
    doc.text('PAID', 0, 0, { align: 'center', width: 250 });
    doc.restore();
    if (invoice.paid_at) {
      doc.fontSize(9).fillColor(180, 30, 30, 0.35).font('Helvetica');
      doc.text('Paid ' + String(invoice.paid_at).slice(0, 10), doc.page.margins.left + pageW * 0.52, stampY + 52, { width: 200, align: 'center' });
    }
  }

  const footerLines = [];
  if (invoice.created_at) footerLines.push(`Issued: ${String(invoice.created_at).slice(0,10)}`);
  if (invoice.due_date)  footerLines.push(`Due: ${String(invoice.due_date).slice(0,10)}`);
  if (invoice.sent_at)   footerLines.push(`Sent: ${String(invoice.sent_at).slice(0,10)}`);
  if (invoice.paid_at)   footerLines.push(`Paid: ${String(invoice.paid_at).slice(0,10)}`);
  drawFooterMeta(doc, footerLines);

  doc.end();
}

// Render any of the PDFs to a Buffer (for email attachment).
function renderToBuffer(generatorFn, ...args) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const { Writable } = require('stream');
    const sink = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
    });
    sink.on('finish', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);
    try {
      generatorFn(...args, sink);
    } catch (e) { reject(e); }
  });
}

module.exports = {
  generateEstimatePDF,
  generateWorkOrderPDF,
  generateInvoicePDF,
  renderToBuffer,
  _internal: { drawHeader, drawTitle, drawAddressBlocks, drawLineItemsTable, drawTotals, drawNotes, drawTextBlock, drawSignatureBlock, drawPaymentTerms, drawFooterMeta, fmt, fmtMoney, COLOR },
};
