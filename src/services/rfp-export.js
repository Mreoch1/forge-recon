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
  return num.toFixed(2);
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
      ? approvedChildren.reduce((s, c) => s + (Number(c.total_with_markup) || 0), 0)
      : (Number(item.total_with_markup) || 0);
    const rollupUnit = hasSubs
      ? children.reduce((s, c) => s + (Number(c.contractor_cost || 0) + Number(c.vendor_cost || 0)), 0)
      : (Number(item.unit_cost) || 0);
    const rollupTotalCost = hasSubs
      ? children.reduce((s, c) => s + (Number(c.total_cost) || 0), 0)
      : (Number(item.total_cost) || 0);
    const rollupQty = hasSubs
      ? (Number(item.quantity) || 1)
      : (Number(item.quantity) || 0);
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
        unit_cost: Number(sub.unit_cost) || 0,
        total_cost: Number(sub.total_cost) || 0,
        markup_pct: sub.markup_pct,
        general_requirements_pct: sub.general_requirements_pct,
        total_with_markup: Number(sub.total_with_markup) || 0,
        final_unit_cost: Number(sub.final_unit_cost) || 0,
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
      total += children.reduce((s, c) => s + (c.approved ? (Number(c.total_with_markup) || 0) : 0), 0);
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
    const grandTotal = computeGrandTotal(items, subItemsMap);

    // ── Column definitions ──
    const cols = [
      { key: 'description', label: 'DESCRIPTION',        width: tableWidth - 50 - 55 - 55 - 55 - 60, align: 'left' },
      { key: 'qty',         label: 'QTY',                width: 50,  align: 'right' },
      { key: 'total_cost',  label: 'TOTAL COST',         width: 55,  align: 'right' },
      { key: 'markup_pct',  label: 'MU%',                width: 55,  align: 'right' },
      { key: 'gr_pct',      label: 'GR%',                width: 55,  align: 'right' },
      { key: 'total_w_mu',  label: 'TOTAL w/ MARKUP',    width: 60,  align: 'right' },
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
        let displayDesc = r.description;
        if (!isParent) displayDesc = '    ' + (r.description || ''); // indent sub-lines

        const descH = doc.heightOfString(displayDesc, { width: cols[0].width - 8, align: 'left' });
        const actualRowHeight = Math.max(rowHeight, descH + 8);

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

        // Sub-line indent via description prefix
        doc.font(isParent ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(COLOR.charcoal);
        doc.text(displayDesc, left + 4, y + 4, { width: cols[0].width - 8, align: cols[0].align });

        // Numeric cells
        const vals = [
          r.qty,
          fmtMoney(r.total_cost),
          r.markup_pct != null ? (Number(r.markup_pct) + '%') : '—',
          r.general_requirements_pct != null ? (Number(r.general_requirements_pct) + '%') : '—',
          fmtMoney(r.total_with_markup),
        ];

        cx = left + cols[0].width;
        for (let j = 1; j < cols.length; j++) {
          const c = cols[j];
          const val = vals[j - 1];
          doc.font('Helvetica').fontSize(8).fillColor(isParent ? COLOR.charcoal : COLOR.ash)
            .text(String(val), cx + 4, y + 4, { width: c.width - 8, align: c.align });
          cx += c.width;
        }

        // Bottom border
        doc.strokeColor(COLOR.mist).lineWidth(0.5)
          .moveTo(left, y + actualRowHeight).lineTo(left + tableWidth, y + actualRowHeight).stroke();

        y += actualRowHeight;
      }
      doc.y = y + 10;
      break Y;
    }

    // ── Grand Total footer ──
    const totalY = doc.y;
    if (totalY > doc.page.height - doc.page.margins.bottom - 30) {
      doc.addPage();
      doc.y = doc.page.margins.top;
    }

    // Divider
    doc.strokeColor(COLOR.charcoal).lineWidth(1)
      .moveTo(left, doc.y).lineTo(right, doc.y).stroke();
    doc.moveDown(0.5);

    const totalLabelW = tableWidth * 0.7;
    doc.fontSize(11).font('Helvetica-Bold').fillColor(COLOR.charcoal)
      .text('GRAND TOTAL (Approved)', left, doc.y, { width: totalLabelW, align: 'right' });
    doc.fillColor(COLOR.red).font('Helvetica-Bold').fontSize(13)
      .text(fmtMoney(grandTotal), left + totalLabelW, doc.y - 13, { width: tableWidth - totalLabelW, align: 'right' });

    doc.moveDown(1.5);

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
    const grandTotal = computeProjectGrandTotal(rfps, itemsByRfp);
    const cols = [
      { key: 'category', label: 'CATEGORY', width: 90, align: 'left' },
      { key: 'description', label: 'DESCRIPTION', width: tableWidth - 90 - 38 - 58 - 38 - 38 - 68, align: 'left' },
      { key: 'qty', label: 'QTY', width: 38, align: 'right' },
      { key: 'total_cost', label: 'COST', width: 58, align: 'right' },
      { key: 'markup_pct', label: 'MU%', width: 38, align: 'right' },
      { key: 'gr_pct', label: 'GR%', width: 38, align: 'right' },
      { key: 'total_w_mu', label: 'TOTAL', width: 68, align: 'right' },
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
      const displayDesc = (isParent ? '' : '    ') + (r.description || '');
      const categoryH = doc.heightOfString(r.category || '', { width: cols[0].width - 8, align: 'left' });
      const descH = doc.heightOfString(displayDesc, { width: cols[1].width - 8, align: 'left' });
      const actualRowHeight = Math.max(rowHeight, categoryH + 8, descH + 8);
      if (y + actualRowHeight > pageBottom) {
        doc.addPage();
        y = drawHeader(doc.page.margins.top);
        pageBottom = doc.page.height - doc.page.margins.bottom - 60;
      }
      if (isParent) doc.fillColor(COLOR.cloud).opacity(0.5).rect(left, y, tableWidth, actualRowHeight).fill().opacity(1);

      let cx = left;
      doc.font(isParent ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(COLOR.charcoal)
        .text(r.category || '', cx + 4, y + 4, { width: cols[0].width - 8, align: cols[0].align });
      cx += cols[0].width;
      doc.font(isParent ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).fillColor(COLOR.charcoal)
        .text(displayDesc, cx + 4, y + 4, { width: cols[1].width - 8, align: cols[1].align });
      cx += cols[1].width;

      [
        r.qty,
        fmtMoney(r.total_cost),
        r.markup_pct != null ? `${Number(r.markup_pct)}%` : '—',
        r.general_requirements_pct != null ? `${Number(r.general_requirements_pct)}%` : '—',
        fmtMoney(r.total_with_markup),
      ].forEach((val, idx) => {
        const c = cols[idx + 2];
        doc.font('Helvetica').fontSize(8).fillColor(isParent ? COLOR.charcoal : COLOR.ash)
          .text(String(val), cx + 4, y + 4, { width: c.width - 8, align: c.align });
        cx += c.width;
      });

      doc.strokeColor(COLOR.mist).lineWidth(0.5)
        .moveTo(left, y + actualRowHeight).lineTo(left + tableWidth, y + actualRowHeight).stroke();
      y += actualRowHeight;
    });

    doc.y = y + 10;
    if (doc.y > doc.page.height - doc.page.margins.bottom - 30) {
      doc.addPage();
      doc.y = doc.page.margins.top;
    }
    doc.strokeColor(COLOR.charcoal).lineWidth(1).moveTo(left, doc.y).lineTo(right, doc.y).stroke();
    doc.moveDown(0.5);
    const totalLabelW = tableWidth * 0.7;
    doc.fontSize(11).font('Helvetica-Bold').fillColor(COLOR.charcoal)
      .text('GRAND TOTAL (Approved)', left, doc.y, { width: totalLabelW, align: 'right' });
    doc.fillColor(COLOR.red).font('Helvetica-Bold').fontSize(13)
      .text(fmtMoney(grandTotal), left + totalLabelW, doc.y - 13, { width: tableWidth - totalLabelW, align: 'right' });

    const footerY = doc.page.height - doc.page.margins.bottom - 18;
    doc.fontSize(7).fillColor(COLOR.fog).font('Helvetica')
      .text('Recon Enterprises', left, footerY, { width: tableWidth, align: 'center' });

    doc.end();
  });
}

// ════════════════════════════════════════════════════════════════════════
//  CSV
// ════════════════════════════════════════════════════════════════════════

const CSV_HEADERS = [
  'parent_id',
  'level',
  'vendor',
  'description',
  'qty',
  'unit_cost',
  'total_cost',
  'markup_pct',
  'general_requirements_pct',
  'total_with_markup',
  'final_unit_cost',
  'approved',
];

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
  lines.push(CSV_HEADERS.map(escCsv).join(','));

  // Data rows
  rows.forEach(r => {
    lines.push([
      r.parent_id != null ? String(r.parent_id) : '',
      r.level,
      escCsv(r.vendor),
      escCsv(r.description),
      fmt(r.qty),
      fmt(r.unit_cost),
      fmt(r.total_cost),
      r.markup_pct != null ? String(r.markup_pct) : '',
      r.general_requirements_pct != null ? String(r.general_requirements_pct) : '',
      fmt(r.total_with_markup),
      fmt(r.final_unit_cost),
      r.approved ? '1' : '0',
    ].join(','));
  });

  return lines.join('\r\n') + '\r\n';
}

function renderProjectCsv(project, rfps, itemsByRfp) {
  const headers = ['category', 'category_status', ...CSV_HEADERS];
  const lines = [headers.map(escCsv).join(',')];
  buildProjectExportRows(rfps, itemsByRfp).forEach(r => {
    lines.push([
      escCsv(r.category),
      escCsv(r.category_status),
      r.parent_id != null ? String(r.parent_id) : '',
      r.level,
      escCsv(r.vendor),
      escCsv(r.description),
      fmt(r.qty),
      fmt(r.unit_cost),
      fmt(r.total_cost),
      r.markup_pct != null ? String(r.markup_pct) : '',
      r.general_requirements_pct != null ? String(r.general_requirements_pct) : '',
      fmt(r.total_with_markup),
      fmt(r.final_unit_cost),
      r.approved ? '1' : '0',
    ].join(','));
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
  sheet.columns = [
    { header: 'parent_id',                  key: 'parent_id',                 width: 12 },
    { header: 'level',                      key: 'level',                     width: 10 },
    { header: 'vendor',                     key: 'vendor',                    width: 24 },
    { header: 'description',                key: 'description',               width: 40 },
    { header: 'qty',                        key: 'qty',                       width: 10 },
    { header: 'unit_cost',                  key: 'unit_cost',                 width: 14 },
    { header: 'total_cost',                 key: 'total_cost',                width: 14 },
    { header: 'markup_pct',                 key: 'markup_pct',                width: 10 },
    { header: 'general_requirements_pct',   key: 'general_requirements_pct',  width: 10 },
    { header: 'total_with_markup',          key: 'total_with_markup',         width: 18 },
    { header: 'final_unit_cost',            key: 'final_unit_cost',           width: 15 },
    { header: 'approved',                   key: 'approved',                  width: 10 },
  ];

  // ── Bold header row ──
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, size: 11, name: 'Calibri' };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFC0202B' }, // Recon red
  };
  headerRow.font = { bold: true, size: 11, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  // ── Freeze header row ──
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  // ── Currency format ──
  const moneyFmt = '$#,##0.00';

  // ── Data rows ──
  rows.forEach((r, i) => {
    const rowIdx = i + 2; // 1-indexed, after header
    const row = sheet.getRow(rowIdx);

    row.getCell(1).value = r.parent_id != null ? r.parent_id : null;
    row.getCell(2).value = r.level;
    row.getCell(3).value = r.vendor;
    row.getCell(4).value = r.description;
    row.getCell(5).value = r.qty;
    row.getCell(6).value = r.unit_cost;
    row.getCell(6).numFmt = moneyFmt;
    row.getCell(7).value = r.total_cost;
    row.getCell(7).numFmt = moneyFmt;
    row.getCell(8).value = r.markup_pct != null ? Number(r.markup_pct) : null;
    row.getCell(9).value = r.general_requirements_pct != null ? Number(r.general_requirements_pct) : null;
    row.getCell(10).value = r.total_with_markup;
    row.getCell(10).numFmt = moneyFmt;
    row.getCell(11).value = r.final_unit_cost;
    row.getCell(11).numFmt = moneyFmt;
    row.getCell(12).value = r.approved ? 'Yes' : 'No';

    // Light-gray fill on parent rows
    if (r.level === 'parent') {
      row.eachCell(cell => {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF0F0F0' },
        };
      });
    }
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

async function renderProjectXlsx(project, rfps, itemsByRfp) {
  const rows = buildProjectExportRows(rfps, itemsByRfp);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('RFP');
  sheet.columns = [
    { header: 'category', key: 'category', width: 24 },
    { header: 'category_status', key: 'category_status', width: 16 },
    { header: 'parent_id', key: 'parent_id', width: 12 },
    { header: 'level', key: 'level', width: 10 },
    { header: 'vendor', key: 'vendor', width: 24 },
    { header: 'description', key: 'description', width: 44 },
    { header: 'qty', key: 'qty', width: 10 },
    { header: 'unit_cost', key: 'unit_cost', width: 14 },
    { header: 'total_cost', key: 'total_cost', width: 14 },
    { header: 'markup_pct', key: 'markup_pct', width: 10 },
    { header: 'general_requirements_pct', key: 'general_requirements_pct', width: 12 },
    { header: 'total_with_markup', key: 'total_with_markup', width: 18 },
    { header: 'final_unit_cost', key: 'final_unit_cost', width: 15 },
    { header: 'approved', key: 'approved', width: 10 },
  ];

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, size: 11, name: 'Calibri', color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC0202B' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  const moneyFmt = '$#,##0.00';
  rows.forEach((r, idx) => {
    const row = sheet.getRow(idx + 2);
    row.values = [
      null,
      r.category,
      r.category_status,
      r.parent_id != null ? r.parent_id : null,
      r.level,
      r.vendor,
      r.description,
      r.qty,
      r.unit_cost,
      r.total_cost,
      r.markup_pct != null ? Number(r.markup_pct) : null,
      r.general_requirements_pct != null ? Number(r.general_requirements_pct) : null,
      r.total_with_markup,
      r.final_unit_cost,
      r.approved ? 'Yes' : 'No',
    ];
    [8, 9, 12, 13].forEach(cellNum => { row.getCell(cellNum).numFmt = moneyFmt; });
    if (r.level === 'parent') {
      row.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F0F0' } };
      });
    }
  });

  const totalRow = sheet.getRow(rows.length + 3);
  totalRow.getCell(11).value = 'Grand Total (Approved)';
  totalRow.getCell(12).value = computeProjectGrandTotal(rfps, itemsByRfp);
  totalRow.getCell(12).numFmt = moneyFmt;
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
};
