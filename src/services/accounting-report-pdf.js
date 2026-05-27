const PDFDocument = require('pdfkit');
const { Writable } = require('stream');
const pdf = require('./pdf');

const { COLOR, drawHeader } = pdf._internal;

function fmt(n) {
  const num = Number(n);
  if (!isFinite(num)) return '0.00';
  return num.toFixed(2);
}

function money(n) {
  return '$' + fmt(n);
}

function text(v) {
  if (v === null || v === undefined || v === '') return '-';
  return String(v);
}

function ensureSpace(doc, y, height) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (y + height <= bottom) return y;
  doc.addPage();
  return doc.page.margins.top;
}

function drawReportTitle(doc, title, subtitle) {
  const left = doc.page.margins.left;
  doc.moveDown(1.4);
  doc.fillColor(COLOR.charcoal).font('Helvetica-Bold').fontSize(22).text(title, left, doc.y);
  if (subtitle) {
    doc.moveDown(0.25);
    doc.fillColor(COLOR.fog).font('Helvetica').fontSize(9).text(subtitle, left, doc.y);
  }
  doc.moveDown(1);
}

function drawKeyValues(doc, values) {
  if (!values || values.length === 0) return;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const colW = width / Math.min(values.length, 5);
  let x = left;
  const y = doc.y;
  values.forEach((kv, idx) => {
    if (idx > 0 && idx % 5 === 0) {
      doc.y += 42;
      x = left;
    }
    doc.roundedRect(x, doc.y, colW - 8, 34, 4).strokeColor(COLOR.mist).lineWidth(0.8).stroke();
    doc.fillColor(COLOR.fog).font('Helvetica-Bold').fontSize(7).text(kv.label.toUpperCase(), x + 8, doc.y + 7, { width: colW - 24 });
    doc.fillColor(kv.color || COLOR.charcoal).font('Helvetica-Bold').fontSize(11).text(kv.value, x + 8, doc.y + 18, { width: colW - 24 });
    x += colW;
  });
  doc.y = y + (Math.ceil(values.length / 5) * 42);
}

function drawTable(doc, columns, rows, options = {}) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const tableWidth = right - left;
  const headerH = 22;
  const minRowH = 18;
  const widths = columns.map(c => c.width || 1);
  const widthTotal = widths.reduce((s, w) => s + w, 0);
  const resolved = columns.map((c, idx) => ({ ...c, w: tableWidth * widths[idx] / widthTotal }));
  let y = ensureSpace(doc, doc.y, headerH + minRowH);

  function header() {
    doc.rect(left, y, tableWidth, headerH).fillColor(COLOR.cloud).fill();
    let x = left;
    resolved.forEach(c => {
      doc.fillColor(COLOR.fog).font('Helvetica-Bold').fontSize(7.5)
        .text(c.label.toUpperCase(), x + 5, y + 7, { width: c.w - 10, align: c.align || 'left' });
      x += c.w;
    });
    y += headerH;
  }

  header();

  if (!rows || rows.length === 0) {
    doc.fillColor(COLOR.fog).font('Helvetica').fontSize(10).text(options.emptyText || 'No rows.', left, y + 8);
    doc.y = y + 34;
    return;
  }

  rows.forEach(row => {
    let rowH = minRowH;
    resolved.forEach(c => {
      const raw = typeof c.value === 'function' ? c.value(row) : row[c.key];
      const val = text(raw);
      const h = doc.heightOfString(val, { width: c.w - 10, align: c.align || 'left' });
      rowH = Math.max(rowH, h + 10);
    });
    y = ensureSpace(doc, y, rowH + 8);
    if (y === doc.page.margins.top) header();
    let x = left;
    resolved.forEach(c => {
      const raw = typeof c.value === 'function' ? c.value(row) : row[c.key];
      doc.fillColor(c.color && c.color(row) || COLOR.charcoal).font(c.bold && c.bold(row) ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5)
        .text(text(raw), x + 5, y + 5, { width: c.w - 10, align: c.align || 'left' });
      x += c.w;
    });
    doc.strokeColor(COLOR.mist).lineWidth(0.5).moveTo(left, y + rowH).lineTo(right, y + rowH).stroke();
    y += rowH;
  });

  if (options.footerRows) {
    options.footerRows.forEach(row => {
      y = ensureSpace(doc, y, 22);
      doc.rect(left, y, tableWidth, 22).fillColor(COLOR.cloud).fill();
      let x = left;
      resolved.forEach(c => {
        const raw = typeof row[c.key] === 'function' ? row[c.key]() : row[c.key];
        doc.fillColor(COLOR.charcoal).font('Helvetica-Bold').fontSize(8.5)
          .text(text(raw), x + 5, y + 7, { width: c.w - 10, align: c.align || 'left' });
        x += c.w;
      });
      y += 22;
    });
  }

  doc.y = y + 12;
}

function drawSection(doc, title, rows) {
  doc.moveDown(0.5);
  doc.fillColor(COLOR.red).font('Helvetica-Bold').fontSize(12).text(title, doc.page.margins.left, doc.y);
  doc.moveDown(0.25);
  rows.forEach(r => {
    const y = ensureSpace(doc, doc.y, 16);
    doc.y = y;
    doc.fillColor(COLOR.charcoal).font(r.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
      .text(r.label, doc.page.margins.left, y, { width: 300 });
    doc.text(r.value, doc.page.width - doc.page.margins.right - 150, y, { width: 150, align: 'right' });
    doc.y = y + 16;
  });
}

function generateReportPDF({ title, subtitle, company, summary, columns, rows, footerRows, sections }, stream) {
  const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
  doc.pipe(stream);
  drawHeader(doc, company || {});
  drawReportTitle(doc, title, subtitle || ('Generated ' + new Date().toISOString().slice(0, 10)));
  drawKeyValues(doc, summary || []);
  if (sections) {
    sections.forEach(section => drawSection(doc, section.title, section.rows || []));
  } else {
    drawTable(doc, columns || [], rows || [], { footerRows });
  }
  doc.end();
}

function renderToBuffer(report) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sink = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
    });
    sink.on('finish', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);
    try {
      generateReportPDF(report, sink);
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = {
  generateReportPDF,
  renderToBuffer,
  fmt,
  money,
};
