/**
 * RFP Export — renders an RFP to PDF, CSV, and Excel formats.
 *
 * renderPdf(rfp, items, subItemsMap, extra)  -> Promise<Buffer>
 * renderCsv(rfp, items, subItemsMap)          -> string (RFC 4180)
 * renderXlsx(rfp, items, subItemsMap)         -> Promise<Buffer>
 *
 * extra = { projectTitle, createdBy } — used for the PDF header block.
 *
 * RFP items have a two-level hierarchy:
 *   parent rows (parent_line_item_id == null) → rollups of approved sub-lines
 *   sub rows   (parent_line_item_id != null) → individual vendor/contractor bids
 */

const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');

const DEFAULT_RFP_MARKUP_PCT = 16;
const DEFAULT_RFP_GENERAL_REQUIREMENTS_PCT = 4;

// ── Recon brand palette (mirrors src/services/pdf.js) ──

const COLOR = {
  red:      '#c0202b',
  charcoal: '#1a1a1a',
  ash:      '#3d3d3d',
  fog:      '#888888',
  mist:     '#e5e5e5',
  cloud:    '#f5f5f5',
};

// ── Helpers ──

function fmt(n) {
  const num = Number(n);
  if (!isFinite(num)) return '0.00';
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtMoney(n) {
  return '$' + fmt(n);
}

function escCsv(val) {
  if (val == null) return '';
  const s = String(val);
  // RFC 4180 — wrap in quotes if contains comma, quote, or newline
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function pdfText(val) {
  if (val == null) return '';
  return String(val)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n+/g, ' ')
    .trim();
}

function exportText(val) {
  return pdfText(val);
}

function lineType(level) {
  return level === 'sub' ? 'Sub-line item' : 'Line item';
}

function approvalText(approved) {
  return approved ? 'Yes' : 'No';
}

function parentRollupQty(item, approvedChildren) {
  const parentQty = Number(item && item.quantity);
  const childQtys = (approvedChildren || [])
    .map(child => Number(child.quantity) || 0)
    .filter(qty => qty > 0);
  if (parentQty > 0 && parentQty !== 1) return parentQty;
  if (!childQtys.length) return parentQty > 0 ? parentQty : 0;
  return childQtys.reduce((max, qty) => Math.max(max, qty), 0);
}

function numberOrDefault(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bidRequestQtyForItem(item) {
  const children = item?.bid_request_children || item?.children || [];
  if (!children.length) return Number(item?.quantity) || 0;
  return parentRollupQty(item, children.filter(child => child.approved));
}

function computedLineTotalCost(line) {
  const qty = numberOrDefault(line && line.quantity, 0);
  const splitUnit = numberOrDefault(line && line.contractor_cost, 0) + numberOrDefault(line && line.vendor_cost, 0);
  const unit = splitUnit > 0 ? splitUnit : numberOrDefault(line && line.unit_cost, 0);
  return unit * qty;
}

function computedLineTotalWithMarkup(line) {
  const totalCost = computedLineTotalCost(line);
  const markup = numberOrDefault(line && line.markup_pct, DEFAULT_RFP_MARKUP_PCT);
  const gr = numberOrDefault(line && line.general_requirements_pct, DEFAULT_RFP_GENERAL_REQUIREMENTS_PCT);
  return totalCost * (1 + ((markup + gr) / 100));
}

function measurePdfText(doc, text, width, font, fontSize, options = {}) {
  doc.font(font).fontSize(fontSize);
  return doc.heightOfString(pdfText(text), { width, align: options.align || 'left', lineGap: options.lineGap || 1 });
}

function pdfParagraphText(val) {
  if (val == null) return '';
  return String(val)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function safeFilePart(value, fallback = 'file') {
  const clean = String(value || fallback)
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80);
  return clean || fallback;
}

function rfpParent(item) {
  const rel = item && item.project_rfps;
  return Array.isArray(rel) ? rel[0] : rel;
}

function collectBidInstructionSections(items, fallbackRfp) {
  const sections = new Map();
  if (fallbackRfp && fallbackRfp.notes) {
    sections.set(`rfp-${fallbackRfp.id || 'category'}`, {
      title: fallbackRfp.contractor_name || fallbackRfp.name || 'Bid instructions',
      notes: fallbackRfp.notes,
    });
  }
  (items || []).forEach(item => {
    const rfp = rfpParent(item);
    if (!rfp || !rfp.notes) return;
    const key = `rfp-${rfp.id || rfp.contractor_name || sections.size}`;
    if (!sections.has(key)) {
      sections.set(key, {
        title: rfp.contractor_name || 'Bid instructions',
        notes: rfp.notes,
      });
    }
  });
  return Array.from(sections.values()).filter(section => pdfParagraphText(section.notes));
}

function drawBidInstructionSections(doc, sections, left, right, y) {
  if (!sections || !sections.length) return y;
  const width = right - left;
  const bottom = doc.page.height - doc.page.margins.bottom - 40;

  const ensure = needed => {
    if (y + needed <= bottom) return;
    doc.addPage();
    y = doc.page.margins.top;
  };

  ensure(42);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(COLOR.charcoal)
    .text('BID INSTRUCTIONS / BUILDINGCONNECTED NOTES', left, y, { width });
  y = doc.y + 6;

  sections.forEach(section => {
    const title = pdfText(section.title || '');
    const notes = pdfParagraphText(section.notes || '');
    const titleHeight = title ? measurePdfText(doc, title, width, 'Helvetica-Bold', 9) + 3 : 0;
    const notesHeight = doc.font('Helvetica').fontSize(8.5).heightOfString(notes, { width, lineGap: 2 });
    ensure(Math.min(titleHeight + notesHeight + 16, 240));

    if (title) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR.red)
        .text(title, left, y, { width });
      y = doc.y + 2;
    }
    doc.font('Helvetica').fontSize(8.5).fillColor(COLOR.charcoal)
      .text(notes, left, y, { width, lineGap: 2 });
    y = doc.y + 8;
  });

  doc.strokeColor(COLOR.mist).lineWidth(0.5).moveTo(left, y).lineTo(right, y).stroke();
  return y + 10;
}

/**
 * Build a flat sorted array of row objects for export.
 * Each row has: parent_id, level ('parent'|'sub'), vendor, description,
 * qty, unit_cost, total_cost, markup_pct, general_requirements_pct,
 * total_with_markup, final_unit_cost, approved (boolean).
 *
 * Parent rows receive rollup totals from their approved sub-lines.
 */
function buildExportRows(items, subItemsMap) {
  const rows = [];
  const sorted = (items || []).slice().sort((a, b) => {
    const ao = a.sort_order != null ? a.sort_order : 0;
    const bo = b.sort_order != null ? b.sort_order : 0;
    if (ao !== bo) return ao - bo;
    return (a.id || 0) - (b.id || 0);
  });

  sorted.forEach(item => {
    // Only top-level items (non-sub) become parent rows
    if (item.parent_line_item_id) return;

    const children = (subItemsMap && subItemsMap[item.id]) || [];
    const approvedChildren = children.filter(c => c.approved);
    const hasSubs = children.length > 0;

    // Rollup from approved sub-lines
    const rollupTotal = hasSubs
      ? approvedChildren.reduce((s, c) => s + computedLineTotalWithMarkup(c), 0)
      : (Number(item.total_with_markup) || 0);
    const rollupTotalCost = hasSubs
      ? approvedChildren.reduce((s, c) => s + computedLineTotalCost(c), 0)
      : (Number(item.total_cost) || 0);
    const rollupQty = hasSubs
      ? parentRollupQty(item, approvedChildren)
      : (Number(item.quantity) || 0);
    const rollupUnit = hasSubs
      ? (rollupQty > 0 ? rollupTotalCost / rollupQty : 0)
      : (Number(item.unit_cost) || 0);
    const rollupFinalUnit = rollupQty > 0 ? rollupTotal / rollupQty : 0;

    // Parent row (rollup)
    rows.push({
      parent_id: null,
      level: 'parent',
      vendor: item.vendor || '',
      description: item.description || '',
      qty: rollupQty,
      unit_cost: rollupUnit,
      total_cost: rollupTotalCost,
      markup_pct: item.markup_pct,
      general_requirements_pct: item.general_requirements_pct,
      total_with_markup: rollupTotal,
      final_unit_cost: rollupFinalUnit,
      approved: hasSubs ? (approvedChildren.length === children.length) : !!item.approved,
      sort_order: item.sort_order,
      raw: item,
    });

    // Sub rows (indented under parent)
    const subs = children.slice().sort((a, b) => {
      const ao = a.sort_order != null ? a.sort_order : 0;
      const bo = b.sort_order != null ? b.sort_order : 0;
      if (ao !== bo) return ao - bo;
      return (a.id || 0) - (b.id || 0);
    });
    subs.forEach(sub => {
      rows.push({
        parent_id: sub.parent_line_item_id,
        level: 'sub',
        vendor: sub.vendor || '',
        description: sub.description || '',
        qty: Number(sub.quantity) || 0,
        unit_cost: (numberOrDefault(sub.contractor_cost, 0) + numberOrDefault(sub.vendor_cost, 0)) || numberOrDefault(sub.unit_cost, 0),
        total_cost: computedLineTotalCost(sub),
        markup_pct: sub.markup_pct,
        general_requirements_pct: sub.general_requirements_pct,
        total_with_markup: computedLineTotalWithMarkup(sub),
        final_unit_cost: (Number(sub.quantity) || 0) > 0 ? computedLineTotalWithMarkup(sub) / (Number(sub.quantity) || 0) : 0,
        approved: !!sub.approved,
        sort_order: sub.sort_order,
        raw: sub,
      });
    });
  });

  return rows;
}

/**
 * Compute grand total of approved items.
 * Uses the same logic as the EJS view: for parent items with children,
 * only approved sub-line totals are summed; standalone items count when approved.
 */
function computeGrandTotal(items, subItemsMap) {
  let total = 0;
  (items || []).forEach(item => {
    if (item.parent_line_item_id) return;
    const children = (subItemsMap && subItemsMap[item.id]) || [];
    if (children.length > 0) {
      total += children.reduce((s, c) => s + (c.approved ? computedLineTotalWithMarkup(c) : 0), 0);
    } else {
      total += (item.approved ? (Number(item.total_with_markup) || 0) : 0);
    }
  });
  return total;
}

function buildProjectExportRows(rfps, itemsByRfp) {
  const rows = [];
  (rfps || []).forEach(rfp => {
    const group = itemsByRfp && itemsByRfp[rfp.id] ? itemsByRfp[rfp.id] : { items: [], subItemsMap: {} };
    buildExportRows(group.items, group.subItemsMap).forEach(row => {
      rows.push({
        ...row,
        category: rfp.contractor_name || '',
        category_status: rfp.status || 'pending',
      });
    });
  });
  return rows;
}

function computeProjectGrandTotal(rfps, itemsByRfp) {
  return (rfps || []).reduce((sum, rfp) => {
    const group = itemsByRfp && itemsByRfp[rfp.id] ? itemsByRfp[rfp.id] : { items: [], subItemsMap: {} };
    return sum + computeGrandTotal(group.items, group.subItemsMap);
  }, 0);
}

// ════════════════════════════════════════════════════════════════════════
//  PDF
// ════════════════════════════════════════════════════════════════════════

/**
 * Render an RFP to a PDF Buffer.
 *
 * @param {object} rfp             - project_rfps row
 * @param {Array}  items            - rfp_line_items rows
 * @param {object} subItemsMap      - { parent_id: [child items] }
 * @param {object} extra            - { projectTitle, createdBy }
 * @returns {Promise<Buffer>}
 */
function renderPdf(rfp, items, subItemsMap, extra) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 50,
      info: {
        Title: `RFP — ${rfp.contractor_name || ''}`,
        Subject: `RFP for ${extra?.projectTitle || ''}`,
        Author: 'Recon Enterprises',
      },
    });

    const chunks = [];
    const { Writable } = require('stream');
    const sink = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
    });
    sink.on('finish', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);

    doc.pipe(sink);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const tableWidth = right - left;
    const top = doc.page.margins.top;

    // ── Header block ──
    doc.fillColor(COLOR.charcoal).fontSize(22).font('Helvetica-Bold')
      .text('RFP / BID COMPARISON', left, top);

    let hdrY = doc.y + 4;

    // Project title
    doc.fontSize(12).font('Helvetica').fillColor(COLOR.ash);
    doc.text(extra?.projectTitle || '', left, hdrY);
    hdrY = doc.y + 2;

    // RFP category
    doc.fontSize(10).fillColor(COLOR.charcoal).font('Helvetica-Bold')
      .text('Category: ', left, hdrY, { continued: true });
    doc.fillColor(COLOR.ash).font('Helvetica')
      .text(rfp.contractor_name || '—');

    // Status
    doc.fillColor(COLOR.fog).fontSize(10).font('Helvetica')
      .text('Status: ' + (rfp.status || 'pending'), left, doc.y + 2);

    // Date
    const dateStr = rfp.created_at ? String(rfp.created_at).slice(0, 10) : new Date().toISOString().slice(0, 10);
    doc.text('Date: ' + dateStr, left, doc.y + 2);

    // Prepared by
    doc.text('Prepared by: ' + (extra?.createdBy || '—'), left, doc.y + 2);

    doc.moveDown(0.5);

    // ── Horizontal rule ──
    let y = doc.y + 6;
    doc.strokeColor(COLOR.red).lineWidth(2)
      .moveTo(left, y).lineTo(right, y).stroke();
    doc.moveDown(0.8);

    // ── Build export rows ──
    const rows = buildExportRows(items, subItemsMap);

    // ── Column definitions (no pricing, show vendor) ──
    const cols = [
      { key: 'vendor',      label: 'VENDOR / CONTRACTOR', width: 100, align: 'left' },
      { key: 'description', label: 'DESCRIPTION',         width: tableWidth - 100 - 50, align: 'left' },
      { key: 'qty',         label: 'QTY',                 width: 50,  align: 'right' },
    ];

    const headerHeight = 22;
    const rowHeight = 18;

    Y: while (true) {
      y = doc.y;

      // Check if we have room for header + at least one row
      if (y + headerHeight + rowHeight > doc.page.height - doc.page.margins.bottom - 60) {
        doc.addPage();
        y = doc.page.margins.top;
      }

      // ── Table header ──
      doc.fillColor(COLOR.cloud).rect(left, y, tableWidth, headerHeight).fill();
      doc.fillColor(COLOR.fog).fontSize(7).font('Helvetica-Bold');
      let cx = left;
      cols.forEach(c => {
        doc.text(c.label, cx + 4, y + 7, { width: c.width - 8, align: c.align });
        cx += c.width;
      });
      y += headerHeight;

      // ── Rows ──
      let pageBottom = doc.page.height - doc.page.margins.bottom - 60;

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const isParent = r.level === 'parent';

        // Measure row height
        let displayDesc = pdfText(r.description);
        let displayVendor = pdfText(r.vendor);
        if (!isParent) displayDesc = '    ' + displayDesc; // indent sub-lines

        const descH = measurePdfText(doc, displayDesc, cols[1].width - 8, isParent ? 'Helvetica-Bold' : 'Helvetica', 8);
        const vendorH = measurePdfText(doc, displayVendor, cols[0].width - 8, 'Helvetica', 8);
        const actualRowHeight = Math.max(rowHeight, descH + 8, vendorH + 8);

        if (y + actualRowHeight > pageBottom) {
          doc.addPage();
          y = doc.page.margins.top;

          // Redraw header on new page
          doc.fillColor(COLOR.cloud).rect(left, y, tableWidth, headerHeight).fill();
          doc.fillColor(COLOR.fog).fontSize(7).font('Helvetica-Bold');
          cx = left;
          cols.forEach(c => {
            doc.text(c.label, cx + 4, y + 7, { width: c.width - 8, align: c.align });
            cx += c.width;
          });
          y += headerHeight;
          pageBottom = doc.page.height - doc.page.margins.bottom - 60;
        }

        // Background shade for parent rows
        if (isParent) {
          doc.fillColor(COLOR.cloud).opacity(0.5).rect(left, y, tableWidth, actualRowHeight).fill().opacity(1);
        }

        // Vendor cell
        doc.font('Helvetica').fontSize(8).fillColor(isParent ? COLOR.charcoal : COLOR.ash)
          .text(displayVendor, left + 4, y + 4, { width: cols[0].width - 8, align: cols[0].align, lineGap: 1 });

        // Description cell
        doc.font(isParent ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(COLOR.charcoal);
        doc.text(displayDesc, left + cols[0].width + 4, y + 4, { width: cols[1].width - 8, align: cols[1].align, lineGap: 1 });

        // Qty cell
        doc.font('Helvetica').fontSize(8).fillColor(isParent ? COLOR.charcoal : COLOR.ash)
          .text(String(r.qty || 0), left + cols[0].width + cols[1].width + 4, y + 4, { width: cols[2].width - 8, align: cols[2].align });

        // Bottom border
        doc.strokeColor(COLOR.mist).lineWidth(0.5)
          .moveTo(left, y + actualRowHeight).lineTo(left + tableWidth, y + actualRowHeight).stroke();

        y += actualRowHeight;
      }
      doc.y = y + 10;
      break Y;
    }

    // ── Footer metadata ──
    const footerY = doc.page.height - doc.page.margins.bottom - 18;
    const footerParts = [];
    if (rfp.created_at) footerParts.push(`Created: ${String(rfp.created_at).slice(0, 10)}`);
    if (rfp.contractor_name) footerParts.push(`Category: ${rfp.contractor_name}`);
    footerParts.push(`Recon Enterprises`);
    doc.fontSize(7).fillColor(COLOR.fog).font('Helvetica')
      .text(footerParts.filter(Boolean).join('   |   '), left, footerY, { width: tableWidth, align: 'center' });

    doc.end();
  });
}

function renderProjectPdf(project, rfps, itemsByRfp, extra) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 50,
      info: {
        Title: `RFP — ${project.title || project.name || ''}`,
        Subject: `RFP bid comparison for ${project.title || project.name || ''}`,
        Author: 'Recon Enterprises',
      },
    });

    const chunks = [];
    const { Writable } = require('stream');
    const sink = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
    });
    sink.on('finish', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);
    doc.pipe(sink);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const tableWidth = right - left;
    const top = doc.page.margins.top;

    doc.fillColor(COLOR.charcoal).fontSize(22).font('Helvetica-Bold')
      .text('RFP / BID COMPARISON', left, top);
    doc.fontSize(12).font('Helvetica').fillColor(COLOR.ash)
      .text(project.title || project.name || '', left, doc.y + 4);
    doc.fillColor(COLOR.fog).fontSize(10)
      .text(`Categories: ${(rfps || []).length}`, left, doc.y + 2)
      .text(`Date: ${new Date().toISOString().slice(0, 10)}`, left, doc.y + 2)
      .text(`Prepared by: ${extra?.createdBy || '—'}`, left, doc.y + 2);

    let y = doc.y + 12;
    doc.strokeColor(COLOR.red).lineWidth(2).moveTo(left, y).lineTo(right, y).stroke();
    doc.y = y + 12;

    const rows = buildProjectExportRows(rfps, itemsByRfp);
    const cols = [
      { key: 'category',    label: 'CATEGORY',          width: 100, align: 'left' },
      { key: 'vendor',      label: 'VENDOR / CONTRACTOR', width: 100, align: 'left' },
      { key: 'description', label: 'DESCRIPTION',       width: tableWidth - 100 - 100 - 40, align: 'left' },
      { key: 'qty',         label: 'QTY',               width: 40,  align: 'right' },
    ];
    const headerHeight = 22;
    const rowHeight = 18;

    function drawHeader(yPos) {
      doc.fillColor(COLOR.cloud).rect(left, yPos, tableWidth, headerHeight).fill();
      doc.fillColor(COLOR.fog).fontSize(7).font('Helvetica-Bold');
      let cx = left;
      cols.forEach(c => {
        doc.text(c.label, cx + 4, yPos + 7, { width: c.width - 8, align: c.align });
        cx += c.width;
      });
      return yPos + headerHeight;
    }

    y = drawHeader(doc.y);
    let pageBottom = doc.page.height - doc.page.margins.bottom - 60;
    rows.forEach(r => {
      const isParent = r.level === 'parent';
      const categoryText = pdfText(r.category);
      const displayVendor = pdfText(r.vendor);
      const displayDesc = (isParent ? '' : '    ') + pdfText(r.description);
      const categoryH = measurePdfText(doc, categoryText, cols[0].width - 8, isParent ? 'Helvetica-Bold' : 'Helvetica', 7.5);
      const vendorH = measurePdfText(doc, displayVendor, cols[1].width - 8, 'Helvetica', 7.5);
      const descH = measurePdfText(doc, displayDesc, cols[2].width - 8, isParent ? 'Helvetica-Bold' : 'Helvetica', 8);
      const actualRowHeight = Math.max(rowHeight, categoryH + 8, vendorH + 8, descH + 8);
      if (y + actualRowHeight > pageBottom) {
        doc.addPage();
        y = drawHeader(doc.page.margins.top);
        pageBottom = doc.page.height - doc.page.margins.bottom - 60;
      }
      if (isParent) doc.fillColor(COLOR.cloud).opacity(0.5).rect(left, y, tableWidth, actualRowHeight).fill().opacity(1);

      let cx = left;
      doc.font(isParent ? 'Helvetica-Bold' : 'Helvetica').fontSize(7.5).fillColor(COLOR.charcoal)
        .text(categoryText, cx + 4, y + 4, { width: cols[0].width - 8, align: cols[0].align, lineGap: 1 });
      cx += cols[0].width;
      doc.font('Helvetica').fontSize(7.5).fillColor(isParent ? COLOR.charcoal : COLOR.ash)
        .text(displayVendor, cx + 4, y + 4, { width: cols[1].width - 8, align: cols[1].align, lineGap: 1 });
      cx += cols[1].width;
      doc.font(isParent ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(COLOR.charcoal)
        .text(displayDesc, cx + 4, y + 4, { width: cols[2].width - 8, align: cols[2].align, lineGap: 1 });
      cx += cols[2].width;
      doc.font('Helvetica').fontSize(8).fillColor(isParent ? COLOR.charcoal : COLOR.ash)
        .text(String(r.qty || 0), cx + 4, y + 4, { width: cols[3].width - 8, align: cols[3].align });

      doc.strokeColor(COLOR.mist).lineWidth(0.5)
        .moveTo(left, y + actualRowHeight).lineTo(left + tableWidth, y + actualRowHeight).stroke();
      y += actualRowHeight;
    });

    doc.y = y + 10;
    const footerY = doc.page.height - doc.page.margins.bottom - 18;
    doc.fontSize(7).fillColor(COLOR.fog).font('Helvetica')
      .text('Recon Enterprises', left, footerY, { width: tableWidth, align: 'center' });

    doc.end();
  });
}

/**
 * Render a contractor handoff PDF — scope-of-work sheet for a specific contractor
 * on a specific project. Pricing is the contractor's raw cost only; customer-facing
 * markup and GR pricing are intentionally excluded.
 *
 * @param {object} contractor  - contractors row (name, trade, etc.)
 * @param {object} project     - jobs row (title, address, etc.)
 * @param {Array}  items       - rfp_line_items (sub-rows) for this contractor + project
 * @returns {Promise<Buffer>}
 */
function renderContractorHandoffPdf(contractor, project, items) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 50,
      info: {
        Title: `SCOPE OF WORK — ${contractor.name || ''}`,
        Subject: `Scope for ${project.title || ''}`,
        Author: 'Recon Enterprises',
      },
    });

    const chunks = [];
    const { Writable } = require('stream');
    const sink = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
    });
    sink.on('finish', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);
    doc.pipe(sink);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const tableWidth = right - left;
    const top = doc.page.margins.top;

    // ── Header ──
    doc.fillColor(COLOR.charcoal).fontSize(22).font('Helvetica-Bold')
      .text('SCOPE OF WORK', left, top);

    let y = doc.y + 8;

    // Contractor name
    doc.fontSize(14).font('Helvetica-Bold').fillColor(COLOR.red);
    doc.text(contractor.name || '—', left, y);
    y = doc.y + 4;

    // Project title
    doc.fontSize(12).font('Helvetica').fillColor(COLOR.ash);
    doc.text(project.title || project.name || '', left, y);
    y = doc.y + 2;

    // Address
    if (project.address) {
      doc.fontSize(10).fillColor(COLOR.fog);
      doc.text([project.address, project.city, project.state, project.zip].filter(Boolean).join(', '), left, y);
      y = doc.y + 2;
    }

    // Date
    doc.fontSize(10).fillColor(COLOR.fog);
    doc.text('Date: ' + new Date().toISOString().slice(0, 10), left, y);
    y = doc.y + 6;

    // Trade / scope tag
    if (contractor.trade) {
      doc.fontSize(10).font('Helvetica-Oblique').fillColor(COLOR.fog);
      doc.text('Trade: ' + contractor.trade, left, y);
      y = doc.y + 6;
    }

    // ── Horizontal rule ──
    y = doc.y + 4;
    doc.strokeColor(COLOR.red).lineWidth(2)
      .moveTo(left, y).lineTo(right, y).stroke();
    doc.moveDown(0.8);

    y = drawBidInstructionSections(doc, collectBidInstructionSections(items), left, right, doc.y);
    doc.y = y;

    // ── Items table (contractor raw pricing only) ──
    const cols = [
      { key: 'description', label: 'DESCRIPTION', width: tableWidth - 220, align: 'left' },
      { key: 'qty',         label: 'QTY',         width: 45,               align: 'right' },
      { key: 'unit_cost',   label: 'UNIT PRICE',  width: 85,               align: 'right' },
      { key: 'total_cost',  label: 'TOTAL PRICE', width: 90,               align: 'right' },
    ];

    const headerHeight = 22;
    const rowHeight = 18;
    const sortedItems = (items || []).slice().sort((a, b) => {
      const ao = a.sort_order != null ? a.sort_order : 0;
      const bo = b.sort_order != null ? b.sort_order : 0;
      if (ao !== bo) return ao - bo;
      return (a.id || 0) - (b.id || 0);
    });
    const pricingTotals = sortedItems.reduce((totals, item) => {
      const qtyVal = Number(item.quantity) || 0;
      const unitCost = Number(item.unit_cost) || 0;
      const totalCost = Number(item.total_cost) || (qtyVal * unitCost);
      totals.total += totalCost;
      return totals;
    }, { total: 0 });

    y = doc.y;
    if (y + headerHeight + rowHeight > doc.page.height - doc.page.margins.bottom - 60) {
      doc.addPage();
      y = doc.page.margins.top;
    }

    // Table header
    doc.fillColor(COLOR.cloud).rect(left, y, tableWidth, headerHeight).fill();
    doc.fillColor(COLOR.fog).fontSize(8).font('Helvetica-Bold');
    let cx = left;
    cols.forEach(c => {
      doc.text(c.label, cx + 4, y + 7, { width: c.width - 8, align: c.align });
      cx += c.width;
    });
    y += headerHeight;

    let pageBottom = doc.page.height - doc.page.margins.bottom - 60;

    if (sortedItems.length === 0) {
      // No items message
      doc.fillColor(COLOR.fog).fontSize(10).font('Helvetica-Oblique')
        .text('No scope items have been assigned to this contractor yet.', left, y + 10, { width: tableWidth, align: 'center' });
      y = doc.y + 20;
    } else {
      sortedItems.forEach(item => {
        const displayDesc = pdfText(item.description || item.name || '');
        const qtyVal = Number(item.quantity) || 0;
        const unitCost = Number(item.unit_cost) || 0;
        const totalCost = Number(item.total_cost) || (qtyVal * unitCost);

        const descH = measurePdfText(doc, displayDesc, cols[0].width - 8, 'Helvetica', 9);
        const actualRowHeight = Math.max(rowHeight, descH + 8);

        if (y + actualRowHeight > pageBottom) {
          doc.addPage();
          y = doc.page.margins.top;

          // Redraw header
          doc.fillColor(COLOR.cloud).rect(left, y, tableWidth, headerHeight).fill();
          doc.fillColor(COLOR.fog).fontSize(8).font('Helvetica-Bold');
          cx = left;
          cols.forEach(c => {
            doc.text(c.label, cx + 4, y + 7, { width: c.width - 8, align: c.align });
            cx += c.width;
          });
          y += headerHeight;
          pageBottom = doc.page.height - doc.page.margins.bottom - 60;
        }

        // Description cell
        doc.font('Helvetica').fontSize(9).fillColor(COLOR.charcoal)
          .text(displayDesc, left + 4, y + 4, { width: cols[0].width - 8, align: cols[0].align, lineGap: 1 });

        // Qty cell
        doc.font('Helvetica').fontSize(9).fillColor(COLOR.charcoal)
          .text(String(qtyVal), left + cols[0].width + 4, y + 4, { width: cols[1].width - 8, align: cols[1].align });

        doc.font('Helvetica').fontSize(9).fillColor(COLOR.charcoal)
          .text(fmtMoney(unitCost), left + cols[0].width + cols[1].width + 4, y + 4, { width: cols[2].width - 8, align: cols[2].align });

        doc.font('Helvetica').fontSize(9).fillColor(COLOR.charcoal)
          .text(fmtMoney(totalCost), left + cols[0].width + cols[1].width + cols[2].width + 4, y + 4, { width: cols[3].width - 8, align: cols[3].align });

        // Bottom border
        doc.strokeColor(COLOR.mist).lineWidth(0.5)
          .moveTo(left, y + actualRowHeight).lineTo(left + tableWidth, y + actualRowHeight).stroke();

        y += actualRowHeight;
      });
    }

    if (sortedItems.length > 0) {
      const summaryHeight = 28;
      if (y + summaryHeight > pageBottom) {
        doc.addPage();
        y = doc.page.margins.top;
        pageBottom = doc.page.height - doc.page.margins.bottom - 60;
      }

      doc.strokeColor(COLOR.red).lineWidth(1)
        .moveTo(left, y).lineTo(left + tableWidth, y).stroke();
      y += 8;

      const amountWidth = cols[3].width - 8;
      const labelWidth = 135;
      const amountX = right - amountWidth - 4;
      const labelX = amountX - labelWidth - 12;

      doc.font('Helvetica-Bold').fontSize(10).fillColor(COLOR.charcoal)
        .text('FINAL TOTAL', labelX, y, { width: labelWidth, align: 'right', lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(COLOR.charcoal)
        .text(fmtMoney(pricingTotals.total), amountX, y, { width: amountWidth, align: 'right', lineBreak: false });
      y += 10;
    }

    doc.y = y + 10;

    // ── Footer ──
    const footerY = doc.page.height - doc.page.margins.bottom - 18;
    doc.fontSize(7).fillColor(COLOR.fog).font('Helvetica')
      .text('Recon Enterprises   |   Scope of Work   |   ' + new Date().toISOString().slice(0, 10),
        left, footerY, { width: tableWidth, align: 'center' });

    doc.end();
  });
}

/**
 * Render a category-level bid request package. This is intentionally pre-award:
 * it shows the BuildingConnected instructions and Forge scope lines, but no
 * Recon markup or contractor pricing.
 */
function renderBidRequestPdf(project, rfp, items, recipientName) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 50,
      info: {
        Title: `BID REQUEST — ${rfp.contractor_name || ''}`,
        Subject: `Bid request for ${project.title || ''}`,
        Author: 'Recon Enterprises',
      },
    });

    const chunks = [];
    const { Writable } = require('stream');
    const sink = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
    });
    sink.on('finish', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);
    doc.pipe(sink);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const tableWidth = right - left;
    let y = doc.page.margins.top;

    doc.fillColor(COLOR.charcoal).fontSize(22).font('Helvetica-Bold')
      .text('BID REQUEST', left, y);
    y = doc.y + 8;

    doc.fontSize(14).font('Helvetica-Bold').fillColor(COLOR.red)
      .text(rfp.contractor_name || 'Trade / Category', left, y);
    y = doc.y + 4;

    if (recipientName) {
      doc.fontSize(11).font('Helvetica-Bold').fillColor(COLOR.charcoal)
        .text('Prepared for: ' + recipientName, left, y);
      y = doc.y + 4;
    }

    doc.fontSize(12).font('Helvetica').fillColor(COLOR.ash)
      .text(project.title || project.name || '', left, y);
    y = doc.y + 2;

    if (project.address) {
      doc.fontSize(10).fillColor(COLOR.fog)
        .text([project.address, project.city, project.state, project.zip].filter(Boolean).join(', '), left, y);
      y = doc.y + 2;
    }

    doc.fontSize(10).fillColor(COLOR.fog)
      .text('Date: ' + new Date().toISOString().slice(0, 10), left, y);
    y = doc.y + 8;

    doc.strokeColor(COLOR.red).lineWidth(2)
      .moveTo(left, y).lineTo(right, y).stroke();
    y += 12;

    y = drawBidInstructionSections(doc, collectBidInstructionSections([], rfp), left, right, y);

    const sortedItems = (items || []).slice().sort((a, b) => {
      const ao = a.sort_order != null ? a.sort_order : 0;
      const bo = b.sort_order != null ? b.sort_order : 0;
      if (ao !== bo) return ao - bo;
      return (a.id || 0) - (b.id || 0);
    });

    // D-142: Unit Cost / Total are intentionally left blank — this PDF never
    // carries Michael's own pricing. They're fillable columns for whichever
    // contractor/vendor the bid request goes out to.
    const priceColWidth = 85;
    const qtyColWidth = 60;
    const cols = [
      { label: 'SCOPE / DESCRIPTION', width: tableWidth - qtyColWidth - priceColWidth * 2, align: 'left' },
      { label: 'QTY', width: qtyColWidth, align: 'right' },
      { label: 'UNIT COST', width: priceColWidth, align: 'right' },
      { label: 'TOTAL', width: priceColWidth, align: 'right' },
    ];
    const headerHeight = 22;
    const rowHeight = 18;
    let pageBottom = doc.page.height - doc.page.margins.bottom - 50;

    const colBoundaries = () => {
      const xs = [left];
      let cx = left;
      cols.forEach(c => { cx += c.width; xs.push(cx); });
      return xs;
    };

    const drawHeader = () => {
      doc.fillColor(COLOR.cloud).rect(left, y, tableWidth, headerHeight).fill();
      doc.fillColor(COLOR.fog).fontSize(8).font('Helvetica-Bold');
      let cx = left;
      cols.forEach(c => {
        doc.text(c.label, cx + 4, y + 7, { width: c.width - 8, align: c.align });
        cx += c.width;
      });
      y += headerHeight;
    };

    if (y + headerHeight + rowHeight > pageBottom) {
      doc.addPage();
      y = doc.page.margins.top;
      pageBottom = doc.page.height - doc.page.margins.bottom - 50;
    }
    drawHeader();

    if (!sortedItems.length) {
      doc.fillColor(COLOR.fog).fontSize(10).font('Helvetica-Oblique')
        .text('No scope lines have been added to this bid category yet.', left, y + 10, { width: tableWidth, align: 'center' });
      y = doc.y + 20;
    } else {
      sortedItems.forEach(item => {
        const displayDesc = pdfText(item.description || item.name || '');
        const qtyVal = Number(item.quantity) || 0;
        const descH = measurePdfText(doc, displayDesc, cols[0].width - 8, 'Helvetica', 9);
        const actualRowHeight = Math.max(rowHeight, descH + 8);
        if (y + actualRowHeight > pageBottom) {
          doc.addPage();
          y = doc.page.margins.top;
          pageBottom = doc.page.height - doc.page.margins.bottom - 50;
          drawHeader();
        }
        doc.font('Helvetica').fontSize(9).fillColor(COLOR.charcoal)
          .text(displayDesc, left + 4, y + 4, { width: cols[0].width - 8, lineGap: 1 });
        doc.font('Helvetica').fontSize(9).fillColor(COLOR.charcoal)
          .text(String(qtyVal), left + cols[0].width + 4, y + 4, { width: cols[1].width - 8, align: 'right' });
        // Unit Cost / Total columns stay blank — fillable by the bidder.
        colBoundaries().forEach(cx => {
          doc.strokeColor(COLOR.mist).lineWidth(0.5)
            .moveTo(cx, y).lineTo(cx, y + actualRowHeight).stroke();
        });
        doc.strokeColor(COLOR.mist).lineWidth(0.5)
          .moveTo(left, y + actualRowHeight).lineTo(right, y + actualRowHeight).stroke();
        y += actualRowHeight;
      });
    }

    y += 14;
    if (y + 48 > pageBottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLOR.charcoal)
      .text('Pricing response', left, y);
    y = doc.y + 4;
    doc.font('Helvetica').fontSize(9).fillColor(COLOR.ash)
      .text('Please review this bid request, price the listed scope, include any required BuildingConnected acknowledgements, and return pricing to office@reconenterprises.net.', left, y, { width: tableWidth, lineGap: 2 });

    const footerY = doc.page.height - doc.page.margins.bottom - 18;
    doc.fontSize(7).fillColor(COLOR.fog).font('Helvetica')
      .text('Recon Enterprises   |   Bid Request   |   ' + new Date().toISOString().slice(0, 10),
        left, footerY, { width: tableWidth, align: 'center' });

    doc.end();
  });
}

/**
 * Render a selected-line bid request package across one or more RFP
 * categories. Used by the RFP page batch action so contractors only receive
 * the exact scope lines selected for them.
 */
function renderSelectedBidRequestPdf(project, items, recipientName) {
  const selectedItems = (items || []).filter(item => !item.parent_line_item_id);
  const categoryNames = Array.from(new Set(selectedItems.map(item => {
    const rfp = rfpParent(item);
    return rfp?.contractor_name || 'Selected scope';
  }).filter(Boolean)));
  const packageTitle = categoryNames.length === 1 ? categoryNames[0] : 'Selected Scope';

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 50,
      info: {
        Title: `BID REQUEST — ${packageTitle}`,
        Subject: `Selected bid request for ${project.title || ''}`,
        Author: 'Recon Enterprises',
      },
    });

    const chunks = [];
    const { Writable } = require('stream');
    const sink = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
    });
    sink.on('finish', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);
    doc.pipe(sink);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const tableWidth = right - left;
    let y = doc.page.margins.top;

    doc.fillColor(COLOR.charcoal).fontSize(22).font('Helvetica-Bold')
      .text('BID REQUEST', left, y);
    y = doc.y + 8;

    doc.fontSize(14).font('Helvetica-Bold').fillColor(COLOR.red)
      .text(packageTitle, left, y);
    y = doc.y + 4;

    if (recipientName) {
      doc.fontSize(11).font('Helvetica-Bold').fillColor(COLOR.charcoal)
        .text('Prepared for: ' + recipientName, left, y);
      y = doc.y + 4;
    }

    doc.fontSize(12).font('Helvetica').fillColor(COLOR.ash)
      .text(project.title || project.name || '', left, y);
    y = doc.y + 2;

    if (project.address) {
      doc.fontSize(10).fillColor(COLOR.fog)
        .text([project.address, project.city, project.state, project.zip].filter(Boolean).join(', '), left, y);
      y = doc.y + 2;
    }

    doc.fontSize(10).fillColor(COLOR.fog)
      .text('Date: ' + new Date().toISOString().slice(0, 10), left, y);
    y = doc.y + 8;

    doc.strokeColor(COLOR.red).lineWidth(2)
      .moveTo(left, y).lineTo(right, y).stroke();
    y += 12;

    y = drawBidInstructionSections(doc, collectBidInstructionSections(selectedItems), left, right, y);

    const priceColWidth = 85;
    const qtyColWidth = 60;
    const cols = [
      { label: 'SCOPE / DESCRIPTION', width: tableWidth - qtyColWidth - priceColWidth * 2, align: 'left' },
      { label: 'QTY', width: qtyColWidth, align: 'right' },
      { label: 'UNIT COST', width: priceColWidth, align: 'right' },
      { label: 'TOTAL', width: priceColWidth, align: 'right' },
    ];
    const headerHeight = 22;
    const rowHeight = 18;
    let pageBottom = doc.page.height - doc.page.margins.bottom - 50;

    const colBoundaries = () => {
      const xs = [left];
      let cx = left;
      cols.forEach(c => { cx += c.width; xs.push(cx); });
      return xs;
    };

    const ensure = needed => {
      if (y + needed <= pageBottom) return;
      doc.addPage();
      y = doc.page.margins.top;
      pageBottom = doc.page.height - doc.page.margins.bottom - 50;
    };

    const drawHeader = () => {
      doc.fillColor(COLOR.cloud).rect(left, y, tableWidth, headerHeight).fill();
      doc.fillColor(COLOR.fog).fontSize(8).font('Helvetica-Bold');
      let cx = left;
      cols.forEach(c => {
        doc.text(c.label, cx + 4, y + 7, { width: c.width - 8, align: c.align });
        cx += c.width;
      });
      y += headerHeight;
    };

    ensure(headerHeight + rowHeight);
    drawHeader();

    if (!selectedItems.length) {
      doc.fillColor(COLOR.fog).fontSize(10).font('Helvetica-Oblique')
        .text('No scope lines were selected for this bid request.', left, y + 10, { width: tableWidth, align: 'center' });
      y = doc.y + 20;
    } else {
      const groups = new Map();
      selectedItems.slice().sort((a, b) => {
        const ar = rfpParent(a);
        const br = rfpParent(b);
        const ao = ar?.created_at || '';
        const bo = br?.created_at || '';
        if (ao !== bo) return ao < bo ? 1 : -1;
        const aso = a.sort_order != null ? a.sort_order : 0;
        const bso = b.sort_order != null ? b.sort_order : 0;
        if (aso !== bso) return aso - bso;
        return (a.id || 0) - (b.id || 0);
      }).forEach(item => {
        const rfp = rfpParent(item) || {};
        const key = String(rfp.id || rfp.contractor_name || 'selected');
        if (!groups.has(key)) groups.set(key, { title: rfp.contractor_name || 'Selected scope', items: [] });
        groups.get(key).items.push(item);
      });

      groups.forEach(group => {
        ensure(rowHeight * 2);
        doc.fillColor('#ffffff').rect(left, y, tableWidth, rowHeight).fill();
        doc.font('Helvetica-Bold').fontSize(9).fillColor(COLOR.red)
          .text(pdfText(group.title), left + 4, y + 5, { width: tableWidth - 8 });
        doc.strokeColor(COLOR.mist).lineWidth(0.5)
          .moveTo(left, y + rowHeight).lineTo(right, y + rowHeight).stroke();
        y += rowHeight;

        group.items.forEach(item => {
          const displayDesc = pdfText(item.description || item.name || '');
          const qtyVal = bidRequestQtyForItem(item);
          const descH = measurePdfText(doc, displayDesc, cols[0].width - 8, 'Helvetica', 9);
          const actualRowHeight = Math.max(rowHeight, descH + 8);
          if (y + actualRowHeight > pageBottom) {
            doc.addPage();
            y = doc.page.margins.top;
            pageBottom = doc.page.height - doc.page.margins.bottom - 50;
            drawHeader();
          }
          doc.font('Helvetica').fontSize(9).fillColor(COLOR.charcoal)
            .text(displayDesc, left + 4, y + 4, { width: cols[0].width - 8, lineGap: 1 });
          doc.font('Helvetica').fontSize(9).fillColor(COLOR.charcoal)
            .text(String(qtyVal), left + cols[0].width + 4, y + 4, { width: cols[1].width - 8, align: 'right' });
          colBoundaries().forEach(cx => {
            doc.strokeColor(COLOR.mist).lineWidth(0.5)
              .moveTo(cx, y).lineTo(cx, y + actualRowHeight).stroke();
          });
          doc.strokeColor(COLOR.mist).lineWidth(0.5)
            .moveTo(left, y + actualRowHeight).lineTo(right, y + actualRowHeight).stroke();
          y += actualRowHeight;
        });
      });
    }

    y += 14;
    if (y + 48 > pageBottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLOR.charcoal)
      .text('Pricing response', left, y);
    y = doc.y + 4;
    doc.font('Helvetica').fontSize(9).fillColor(COLOR.ash)
      .text('Please review this bid request, price the listed scope, include any required BuildingConnected acknowledgements, and return pricing to office@reconenterprises.net.', left, y, { width: tableWidth, lineGap: 2 });

    const footerY = doc.page.height - doc.page.margins.bottom - 18;
    doc.fontSize(7).fillColor(COLOR.fog).font('Helvetica')
      .text('Recon Enterprises   |   Bid Request   |   ' + new Date().toISOString().slice(0, 10),
        left, footerY, { width: tableWidth, align: 'center' });

    doc.end();
  });
}

// ════════════════════════════════════════════════════════════════════════
//  CSV
// ════════════════════════════════════════════════════════════════════════

const EXPORT_COLUMNS = [
  { header: 'Line Type', key: 'line_type', width: 16 },
  { header: 'Vendor / Contractor', key: 'vendor', width: 24 },
  { header: 'Description', key: 'description', width: 62 },
  { header: 'Qty', key: 'qty', width: 10 },
  { header: 'Unit Cost', key: 'unit_cost', width: 14, money: true },
  { header: 'Total Cost', key: 'total_cost', width: 14, money: true },
  { header: 'Markup %', key: 'markup_pct', width: 11 },
  { header: 'GR %', key: 'general_requirements_pct', width: 10 },
  { header: 'Total w/ Markup', key: 'total_with_markup', width: 18, money: true },
  { header: 'Final Unit Cost', key: 'final_unit_cost', width: 16, money: true },
  { header: 'Approved', key: 'approved', width: 11 },
];

function csvRowForExport(r, includeCategory = false) {
  const row = [];
  if (includeCategory) {
    row.push(exportText(r.category));
    row.push(exportText(r.category_status || 'pending'));
  }
  row.push(
    lineType(r.level),
    exportText(r.vendor),
    exportText(r.description),
    fmt(r.qty),
    fmt(r.unit_cost),
    fmt(r.total_cost),
    r.markup_pct != null ? String(r.markup_pct) : '',
    r.general_requirements_pct != null ? String(r.general_requirements_pct) : '',
    fmt(r.total_with_markup),
    fmt(r.final_unit_cost),
    approvalText(r.approved)
  );
  return row.map(escCsv).join(',');
}

function applyWorksheetStyles(sheet, moneyColumns, descriptionColumn) {
  const headerRow = sheet.getRow(1);
  headerRow.height = 22;
  headerRow.font = { bold: true, size: 11, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFC0202B' },
  };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = {
    from: 'A1',
    to: sheet.getRow(1).getCell(sheet.columnCount).address,
  };

  sheet.columns.forEach(column => {
    column.alignment = { vertical: 'top' };
  });
  if (descriptionColumn) {
    sheet.getColumn(descriptionColumn).alignment = { vertical: 'top', wrapText: true };
  }

  const moneyFmt = '$#,##0.00';
  moneyColumns.forEach(cellNum => {
    sheet.getColumn(cellNum).numFmt = moneyFmt;
  });
}

function addExportRow(sheet, r, rowIdx, includeCategory = false) {
  const values = [];
  if (includeCategory) {
    values.push(exportText(r.category));
    values.push(exportText(r.category_status || 'pending'));
  }
  values.push(
    lineType(r.level),
    exportText(r.vendor),
    exportText(r.description),
    Number(r.qty) || 0,
    Number(r.unit_cost) || 0,
    Number(r.total_cost) || 0,
    r.markup_pct != null ? Number(r.markup_pct) : null,
    r.general_requirements_pct != null ? Number(r.general_requirements_pct) : null,
    Number(r.total_with_markup) || 0,
    Number(r.final_unit_cost) || 0,
    approvalText(r.approved)
  );

  const row = sheet.getRow(rowIdx);
  row.values = values;
  row.alignment = { vertical: 'top' };

  if (r.level === 'parent') {
    row.font = { bold: true };
    row.eachCell(cell => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF0F0F0' },
      };
    });
  }

  return row;
}

/**
 * Render an RFP to a CSV string (RFC 4180).
 *
 * @param {object} rfp
 * @param {Array}  items
 * @param {object} subItemsMap
 * @returns {string}
 */
function renderCsv(rfp, items, subItemsMap) {
  const rows = buildExportRows(items, subItemsMap);
  const lines = [];

  // Header row
  lines.push(EXPORT_COLUMNS.map(c => escCsv(c.header)).join(','));

  // Data rows
  rows.forEach(r => {
    lines.push(csvRowForExport(r));
  });

  return lines.join('\r\n') + '\r\n';
}

function renderProjectCsv(project, rfps, itemsByRfp) {
  const headers = ['Category', 'Status', ...EXPORT_COLUMNS.map(c => c.header)];
  const lines = [headers.map(escCsv).join(',')];
  buildProjectExportRows(rfps, itemsByRfp).forEach(r => {
    lines.push(csvRowForExport(r, true));
  });
  return lines.join('\r\n') + '\r\n';
}

// ════════════════════════════════════════════════════════════════════════
//  XLSX
// ════════════════════════════════════════════════════════════════════════

/**
 * Render an RFP to an XLSX Buffer using ExcelJS.
 *
 * @param {object} rfp
 * @param {Array}  items
 * @param {object} subItemsMap
 * @returns {Promise<Buffer>}
 */
async function renderXlsx(rfp, items, subItemsMap) {
  const rows = buildExportRows(items, subItemsMap);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(rfp.contractor_name || 'RFP');

  // ── Columns ──
  sheet.columns = EXPORT_COLUMNS;
  applyWorksheetStyles(sheet, [5, 6, 9, 10], 3);

  // ── Data rows ──
  rows.forEach((r, i) => {
    addExportRow(sheet, r, i + 2);
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

async function renderProjectXlsx(project, rfps, itemsByRfp) {
  const rows = buildProjectExportRows(rfps, itemsByRfp);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('RFP');
  sheet.columns = [
    { header: 'Category', key: 'category', width: 24 },
    { header: 'Status', key: 'category_status', width: 14 },
    ...EXPORT_COLUMNS,
  ];
  applyWorksheetStyles(sheet, [7, 8, 11, 12], 5);

  rows.forEach((r, idx) => {
    addExportRow(sheet, r, idx + 2, true);
  });

  const totalRow = sheet.getRow(rows.length + 3);
  totalRow.getCell(11).value = 'Grand Total (Approved)';
  totalRow.getCell(12).value = computeProjectGrandTotal(rfps, itemsByRfp);
  totalRow.getCell(12).numFmt = '$#,##0.00';
  totalRow.font = { bold: true };

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// ════════════════════════════════════════════════════════════════════════

module.exports = {
  renderPdf,
  renderCsv,
  renderXlsx,
  renderProjectPdf,
  renderProjectCsv,
  renderProjectXlsx,
  renderContractorHandoffPdf,
  renderBidRequestPdf,
  renderSelectedBidRequestPdf,
  _internal: {
    pdfText,
    // Exposed for src/services/ginosko-export.js — reuses the exact same
    // approved-total math as the standard RFP exports so the Ginosko
    // export can validate its grand total against the same source of truth
    // instead of re-deriving (and risking drift from) the calculation.
    computedLineTotalCost,
    computedLineTotalWithMarkup,
    computeGrandTotal,
    computeProjectGrandTotal,
    buildExportRows,
    buildProjectExportRows,
    bidRequestQtyForItem,
  },
};
