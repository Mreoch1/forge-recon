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

const LOGO_PATH = path.join(__dirname, '..', '..', 'public', 'logos', 'recon.png');

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

function drawHeader(doc, company) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const top = doc.page.margins.top;

  // Logo (graceful fallback to text)
  if (fs.existsSync(LOGO_PATH)) {
    try {
      doc.image(LOGO_PATH, left, top, { fit: [120, 60], align: 'left' });
    } catch (e) {
      doc.fillColor(COLOR.charcoal).fontSize(20).font('Helvetica-Bold').text(company.company_name || 'Recon Construction', left, top);
    }
  } else {
    doc.fillColor(COLOR.charcoal).fontSize(20).font('Helvetica-Bold').text(company.company_name || 'Recon Construction', left, top);
  }

  // Company block (right-aligned)
  const companyLines = [
    company.company_name || 'Recon Construction',
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
    { key: 'trade',       label: 'TRADE',       width: 70,  align: 'left' },
    { key: 'description', label: 'DESCRIPTION', width: tableWidth - 70 - 50 - 50 - 65 - 70, align: 'left' },
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
    // Page break if needed
    if (y > doc.page.height - doc.page.margins.bottom - 100) {
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
    // Bottom border
    doc.strokeColor(COLOR.mist).lineWidth(0.5)
      .moveTo(left, y + rowHeight).lineTo(left + tableWidth, y + rowHeight).stroke();
    y += rowHeight;
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
    Author: company.company_name || 'Recon Construction',
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
    estimate.job_address || '',
    [estimate.job_city, estimate.job_state, estimate.job_zip].filter(Boolean).join(', '),
  ]);

  drawLineItemsTable(doc, estimate.lines || []);

  drawTotals(doc, {
    subtotal: estimate.subtotal,
    tax_rate: estimate.tax_rate,
    tax_amount: estimate.tax_amount,
    total: estimate.total,
  });

  if (estimate.notes) drawNotes(doc, estimate.notes);

  const footerLines = [];
  if (estimate.created_at) footerLines.push(`Created: ${String(estimate.created_at).slice(0,10)}`);
  if (estimate.valid_until) footerLines.push(`Valid until: ${String(estimate.valid_until).slice(0,10)}`);
  if (estimate.sent_at) footerLines.push(`Sent: ${String(estimate.sent_at).slice(0,10)}`);
  drawFooterMeta(doc, footerLines);

  doc.end();
}

module.exports = {
  generateEstimatePDF,
  // Future: generateWorkOrderPDF, generateInvoicePDF
  _internal: { drawHeader, drawTitle, drawAddressBlocks, drawLineItemsTable, drawTotals, drawNotes, drawFooterMeta, fmt, fmtMoney, COLOR },
};
