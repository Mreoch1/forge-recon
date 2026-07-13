const PDFDocument = require('pdfkit');
const { Writable } = require('stream');
const { _internal: pdf } = require('./pdf');

const { drawHeader, COLOR, fmtMoney } = pdf;

function safe(v) {
  return String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim();
}

function toNum(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

function addressLines(record) {
  const line1 = safe(record.address);
  const line2 = [record.city, record.state, record.zip].map(safe).filter(Boolean).join(', ').replace(', ', ' ');
  return [line1, line2].filter(Boolean);
}

function renderToBuffer(draw) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = new Writable({
      write(chunk, encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    stream.on('finish', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
    doc.pipe(stream);
    draw(doc);
    doc.end();
  });
}

function ensureSpace(doc, needed) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
    doc.y = doc.page.margins.top;
  }
}

function sectionTitle(doc, title) {
  ensureSpace(doc, 34);
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  doc.moveDown(0.6);
  doc.fillColor(COLOR.charcoal).font('Helvetica-Bold').fontSize(12)
    .text(title.toUpperCase(), left, doc.y, { width });
  doc.strokeColor(COLOR.mist).lineWidth(0.75)
    .moveTo(left, doc.y + 4)
    .lineTo(right, doc.y + 4)
    .stroke();
  doc.moveDown(0.7);
}

function drawInfoColumns(doc, blocks) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const gap = 18;
  const colW = (right - left - gap) / 2;
  let y = doc.y;
  let maxY = y;

  blocks.forEach((block, idx) => {
    const x = left + idx * (colW + gap);
    doc.fillColor(COLOR.fog).font('Helvetica-Bold').fontSize(8)
      .text(block.label.toUpperCase(), x, y, { width: colW });
    let cy = doc.y + 4;
    doc.fillColor(COLOR.charcoal).fontSize(10);
    block.lines.filter(Boolean).forEach((line, i) => {
      doc.font(i === 0 ? 'Helvetica-Bold' : 'Helvetica');
      doc.text(safe(line), x, cy, { width: colW });
      cy = doc.y + 2;
    });
    maxY = Math.max(maxY, cy);
  });

  doc.y = maxY + 8;
}

function drawKeyValueBar(doc, rows) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const colW = width / rows.length;
  const y = doc.y;

  doc.fillColor(COLOR.cloud).rect(left, y, width, 38).fill();
  rows.forEach((row, idx) => {
    const x = left + idx * colW;
    doc.fillColor(COLOR.fog).font('Helvetica-Bold').fontSize(7)
      .text(row.label.toUpperCase(), x + 8, y + 8, { width: colW - 16 });
    doc.fillColor(COLOR.charcoal).font('Helvetica-Bold').fontSize(10)
      .text(row.value || '—', x + 8, y + 21, { width: colW - 16 });
  });
  doc.y = y + 48;
}

function drawAgreementIntro(doc, contractorName) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  ensureSpace(doc, 32);
  doc.fillColor(COLOR.charcoal).font('Helvetica-Bold').fontSize(9)
    .text('Agreement parties', left, doc.y, { width });
  doc.fillColor(COLOR.ash).font('Helvetica').fontSize(9)
    .text(`This subcontract agreement is between Recon Enterprises and ${safe(contractorName) || 'the subcontractor / vendor'} for the scope and pricing listed below.`, left, doc.y + 3, {
      width,
      lineGap: 1.5,
    });
  doc.moveDown(0.8);
}

function drawScopeTable(doc, items) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const tableW = right - left;
  const cols = [
    { key: 'category', label: 'CATEGORY', width: 92, align: 'left' },
    { key: 'description', label: 'DESCRIPTION', width: tableW - 92 - 36 - 40 - 72 - 78, align: 'left' },
    { key: 'quantity', label: 'QTY', width: 36, align: 'right' },
    { key: 'unit', label: 'UNIT', width: 40, align: 'left' },
    { key: 'unit_cost', label: 'UNIT $', width: 72, align: 'right' },
    { key: 'line_total', label: 'LINE $', width: 78, align: 'right' },
  ];

  ensureSpace(doc, 54);
  let y = doc.y;
  doc.fillColor(COLOR.cloud).rect(left, y, tableW, 22).fill();
  doc.fillColor(COLOR.fog).font('Helvetica-Bold').fontSize(7);
  let x = left;
  cols.forEach(c => {
    doc.text(c.label, x + 5, y + 8, { width: c.width - 10, align: c.align });
    x += c.width;
  });
  y += 22;

  doc.font('Helvetica').fontSize(8.5).fillColor(COLOR.charcoal);
  items.forEach(item => {
    const values = {
      category: safe(item.category),
      description: safe(item.description),
      quantity: String(toNum(item.quantity) || ''),
      unit: safe(item.unit || 'ea'),
      unit_cost: fmtMoney(toNum(item.unit_cost)),
      line_total: fmtMoney(toNum(item.total_cost)),
    };
    let rowH = 22;
    cols.forEach(c => {
      const h = doc.heightOfString(values[c.key], { width: c.width - 10, align: c.align });
      rowH = Math.max(rowH, h + 12);
    });
    if (y + rowH > doc.page.height - doc.page.margins.bottom - 72) {
      doc.addPage();
      y = doc.page.margins.top;
      doc.fillColor(COLOR.cloud).rect(left, y, tableW, 22).fill();
      doc.fillColor(COLOR.fog).font('Helvetica-Bold').fontSize(7);
      x = left;
      cols.forEach(c => {
        doc.text(c.label, x + 5, y + 8, { width: c.width - 10, align: c.align });
        x += c.width;
      });
      y += 22;
      doc.font('Helvetica').fontSize(8.5).fillColor(COLOR.charcoal);
    }
    x = left;
    cols.forEach(c => {
      doc.fillColor(COLOR.charcoal).font(c.key === 'description' ? 'Helvetica-Bold' : 'Helvetica');
      doc.text(values[c.key], x + 5, y + 6, { width: c.width - 10, align: c.align });
      x += c.width;
    });
    doc.strokeColor(COLOR.mist).lineWidth(0.5).moveTo(left, y + rowH).lineTo(right, y + rowH).stroke();
    y += rowH;
  });

  doc.y = y + 10;
}

function drawTerms(doc) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const terms = [
    ['Scope of Work', 'Subcontractor shall furnish labor, materials, supervision, tools, equipment, insurance, permits, and services necessary to complete the scope listed above and any referenced project documents, drawings, specifications, addenda, and approved clarifications.'],
    ['Contract Price and Payment', 'The contract sum is fixed unless changed by written change order approved by Recon Enterprises before extra work begins. Payment is subject to completed, accepted work, required lien waivers, insurance documentation, and invoice approval.'],
    ['Schedule and Coordination', 'Subcontractor shall coordinate with the project manager, follow site rules, maintain manpower needed for the project schedule, and promptly notify Recon Enterprises of conflicts, delays, or field conditions affecting the work.'],
    ['Insurance, Licensing, and Compliance', 'Subcontractor shall maintain required licenses and general liability, workers compensation, and auto insurance. Subcontractor shall comply with applicable OSHA, HUD/MSHDA, Section 3, prevailing wage, occupied multifamily, and site-specific requirements when they apply to the project.'],
    ['Quality, Cleanup, and Warranty', 'Work shall be performed in a good and workmanlike manner, kept clean and protected, and corrected promptly if defective or incomplete. Subcontractor is responsible for damage caused by its work or personnel.'],
    ['No Assignment', 'Subcontractor may not assign or subcontract this agreement without written approval from Recon Enterprises.'],
    ['Indemnity', 'To the fullest extent permitted by law, Subcontractor shall defend, indemnify, and hold harmless Recon Enterprises, the owner, and project parties from claims arising from Subcontractor work, omissions, safety violations, or personnel.'],
    ['Entire Agreement', 'This short-form agreement, attached scope, approved RFP pricing, and written change orders form the agreement between the parties. Any handwritten or emailed modifications must be accepted in writing by Recon Enterprises.'],
  ];

  sectionTitle(doc, 'Terms and Conditions');
  terms.forEach(([title, body], idx) => {
    ensureSpace(doc, 58);
    doc.fillColor(COLOR.charcoal).font('Helvetica-Bold').fontSize(9)
      .text(`${idx + 1}. ${title}`, left, doc.y, { width });
    doc.fillColor(COLOR.ash).font('Helvetica').fontSize(8.5).text(body, left, doc.y, {
      width,
      lineGap: 1.5,
    });
    doc.moveDown(0.45);
  });
}

function drawSignatures(doc) {
  ensureSpace(doc, 132);
  sectionTitle(doc, 'Acceptance');
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const gap = 24;
  const colW = (right - left - gap) / 2;
  doc.fillColor(COLOR.ash).font('Helvetica').fontSize(9)
    .text('Please sign, date, and return this agreement to Office@reconenterprises.net.', left, doc.y, {
      width: right - left,
    });
  const y = doc.y + 28;
  [
    { label: 'Subcontractor / Vendor' },
    { label: 'Recon Enterprises' },
  ].forEach((sig, idx) => {
    const x = left + idx * (colW + gap);
    doc.strokeColor(COLOR.charcoal).lineWidth(0.8).moveTo(x, y).lineTo(x + colW, y).stroke();
    doc.fillColor(COLOR.fog).font('Helvetica-Bold').fontSize(7)
      .text('AUTHORIZED SIGNATURE', x, y + 5, { width: colW });
    doc.strokeColor(COLOR.mist).lineWidth(0.8).moveTo(x, y + 44).lineTo(x + colW, y + 44).stroke();
    doc.fillColor(COLOR.fog).font('Helvetica-Bold').fontSize(7)
      .text('PRINT NAME / TITLE', x, y + 49, { width: colW });
    doc.strokeColor(COLOR.mist).lineWidth(0.8).moveTo(x, y + 78).lineTo(x + colW, y + 78).stroke();
    doc.fillColor(COLOR.fog).font('Helvetica-Bold').fontSize(7)
      .text('DATE', x, y + 83, { width: colW });
    doc.fillColor(COLOR.charcoal).font('Helvetica-Bold').fontSize(9)
      .text(sig.label, x, y - 22, { width: colW });
  });
  doc.y = y + 104;
}

function renderSubcontractAgreementPdf({ company, project, customer, contractor, vendorName, items, contractTotal, createdBy }) {
  return renderToBuffer(doc => {
    drawHeader(doc, company || {});

    doc.moveDown(1.2);
    doc.fillColor(COLOR.charcoal).font('Helvetica-Bold').fontSize(24).text('SUBCONTRACT AGREEMENT');
    doc.fillColor(COLOR.red).font('Helvetica').fontSize(11).text(`${safe(project.title)} · ${safe(vendorName)}`);
    doc.fillColor(COLOR.fog).fontSize(8).text('Draft short-form construction contract. Review before issuing for signature.');
    doc.moveDown(1.1);

    drawInfoColumns(doc, [
      {
        label: 'Project',
        lines: [
          project.title,
          ...addressLines(project),
          project.description ? `Scope: ${safe(project.description).slice(0, 180)}` : '',
        ],
      },
      {
        label: 'Subcontractor / Vendor',
        lines: [
          contractor?.name || vendorName,
          contractor?.email,
          contractor?.phone,
          ...(contractor ? addressLines(contractor) : []),
        ],
      },
    ]);

    drawInfoColumns(doc, [
      {
        label: 'Customer / Owner',
        lines: [
          customer?.name || project.customer_name,
        ],
      },
      {
        label: 'Recon Contact',
        lines: [
          project.project_manager_name || createdBy || 'Recon Enterprises',
          project.project_manager_email,
          company?.phone,
          company?.email,
        ],
      },
    ]);

    drawAgreementIntro(doc, contractor?.name || vendorName);

    drawKeyValueBar(doc, [
      { label: 'Contract sum', value: fmtMoney(contractTotal) },
      { label: 'Pricing source', value: 'Approved RFP contractor cost' },
      { label: 'Generated', value: new Date().toISOString().slice(0, 10) },
    ]);

    sectionTitle(doc, 'Scope and Pricing');
    if (items && items.length) {
      drawScopeTable(doc, items);
    } else {
      doc.fillColor(COLOR.fog).font('Helvetica').fontSize(10)
        .text('No approved awarded RFP scope was found for this contractor.');
      doc.moveDown(1);
    }

    const right = doc.page.width - doc.page.margins.right;
    const totalX = right - 220;
    doc.fillColor(COLOR.charcoal).font('Helvetica-Bold').fontSize(11)
      .text('CONTRACT SUM', totalX, doc.y, { width: 120, align: 'right' });
    doc.fillColor(COLOR.red).text(fmtMoney(contractTotal), totalX + 126, doc.y - 13, { width: 94, align: 'right' });
    doc.x = doc.page.margins.left;
    doc.y = Math.max(doc.y, doc.page.margins.top) + 10;

    drawTerms(doc);
    drawSignatures(doc);

    doc.fillColor(COLOR.fog).font('Helvetica').fontSize(7)
      .text(`Generated by FORGE${createdBy ? ` for ${createdBy}` : ''}`, doc.page.margins.left, doc.page.height - 34, {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
        align: 'center',
      });
  });
}

module.exports = { renderSubcontractAgreementPdf };
