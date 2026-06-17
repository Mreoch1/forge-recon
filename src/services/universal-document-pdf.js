const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().slice(0, 10);
}

function writeMeta(doc, label, value, x, y, width) {
  doc.font('Helvetica-Bold').fontSize(7).fillColor('#888').text(String(label || '').toUpperCase(), x, y, { width });
  doc.font('Helvetica').fontSize(9).fillColor('#222').text(value || '—', x, y + 11, { width });
}

function renderUniversalDocumentPdf({ document = {}, template = {}, project = {}, contractor = {}, vendor = {}, requirement = {} } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const logo = path.join(__dirname, '..', '..', 'public', 'logos', 'recon-logo.jpg');
    if (fs.existsSync(logo)) {
      doc.image(logo, 54, 46, { width: 82 });
    } else {
      doc.font('Helvetica-Bold').fontSize(18).fillColor('#c0202b').text('FORGE', 54, 58);
    }

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#222').text('Recon Enterprises', 390, 54, { width: 150, align: 'right' });
    doc.font('Helvetica').fontSize(8).fillColor('#555')
      .text('36761 Amrhein Rd', 390, 68, { width: 150, align: 'right' })
      .text('Livonia, MI 48170', 390, 80, { width: 150, align: 'right' })
      .text('office@reconenterprises.net', 390, 92, { width: 150, align: 'right' });

    doc.moveTo(54, 122).lineTo(558, 122).strokeColor('#ddd').stroke();
    doc.font('Helvetica-Bold').fontSize(22).fillColor('#1f1f1f').text(document.title || template.title || 'Universal Document', 54, 148, { width: 420 });
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#c0202b').text(String(document.status || 'generated').toUpperCase(), 54, 176);
    doc.font('Helvetica').fontSize(8).fillColor('#777').text(`Generated ${fmtDate(document.created_at || new Date())}`, 54, 190);

    const metaY = 226;
    writeMeta(doc, 'Project', project.title, 54, metaY, 160);
    writeMeta(doc, 'Contractor / Vendor', contractor.name || vendor.name, 226, metaY, 160);
    writeMeta(doc, 'Scope / Trade', document.scope_name || requirement.scope_name || requirement.trade, 398, metaY, 160);

    doc.moveTo(54, 276).lineTo(558, 276).strokeColor('#ddd').stroke();
    doc.font('Helvetica').fontSize(10).fillColor('#222');
    const body = String(document.body_snapshot || template.body || '').replace(/\r\n/g, '\n');
    const paragraphs = body.split(/\n{2,}/);
    let y = 298;
    paragraphs.forEach((paragraph) => {
      if (y > 690) {
        doc.addPage();
        y = 54;
      }
      doc.text(paragraph, 54, y, { width: 504, lineGap: 3 });
      y = doc.y + 12;
    });

    if (template.signature_required) {
      if (y > 630) {
        doc.addPage();
        y = 54;
      }
      doc.moveTo(54, y + 30).lineTo(274, y + 30).strokeColor('#222').stroke();
      doc.font('Helvetica').fontSize(8).fillColor('#555').text('Authorized signature', 54, y + 36);
      doc.moveTo(320, y + 30).lineTo(460, y + 30).strokeColor('#222').stroke();
      doc.text('Date', 320, y + 36);
    }

    doc.font('Helvetica').fontSize(7).fillColor('#999').text('FORGE universal document', 54, 742, { width: 504, align: 'center' });
    doc.end();
  });
}

module.exports = { renderUniversalDocumentPdf };
