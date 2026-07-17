const fs = require('fs');
const path = require('path');
const PDFKit = require('pdfkit');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const RED = '#c8202f';
const CHARCOAL = '#202124';
const GRAY = '#6f7378';
const LIGHT = '#f2f3f4';
const LOGO_PATH = path.join(__dirname, '../../public/logos/recon.png');

function display(value, fallback = '') {
  const text = String(value == null ? '' : value).trim();
  return text || fallback;
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function pdfKitBuffer(render) {
  return new Promise((resolve, reject) => {
    const doc = new PDFKit({ size: 'LETTER', margin: 54, bufferPages: true });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    render(doc);
    doc.end();
  });
}

function drawReconMark(doc) {
  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, 54, 46, { width: 88 });
  } else {
    doc.font('Helvetica-Bold').fontSize(20).fillColor(RED).text('RECON', 54, 48);
  }
}

function drawTopRule(doc, y = 108) {
  doc.save().moveTo(54, y).lineTo(558, y).lineWidth(2.5).strokeColor(RED).stroke().restore();
}

function projectAddress(job) {
  const locality = [job.city, job.state, job.zip].filter(Boolean).join(', ');
  return [job.address, locality].filter(Boolean).join(', ');
}

async function renderCover({ packet, job, company, itemCount }) {
  return pdfKitBuffer(doc => {
    drawReconMark(doc);
    drawTopRule(doc);

    doc.font('Helvetica-Bold').fontSize(32).fillColor(CHARCOAL)
      .text(display(packet.packet_title, 'Product Submittal Package'), 54, 156, { width: 504 });
    doc.font('Helvetica-Bold').fontSize(19).fillColor(RED)
      .text(display(job.title, 'Project'), 54, 212, { width: 504 });

    const details = [
      ['Project', display(job.title)],
      ['Location', projectAddress(job)],
      ['Prepared for', display(packet.prepared_for, job.customer_name)],
      ['Prepared by', display(packet.prepared_by, company.company_name || 'Recon Enterprises')],
      ['Issue date', formatDate(packet.issue_date)],
      ['Revision', display(packet.revision, 'Original issue')],
      ['Submittals', String(itemCount)],
    ].filter(row => row[1]);

    let y = 286;
    details.forEach(([label, value]) => {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(GRAY).text(label.toUpperCase(), 54, y, { width: 115 });
      doc.font('Helvetica').fontSize(11).fillColor(CHARCOAL).text(value, 178, y - 1, { width: 380 });
      y += 30;
    });

    if (packet.cover_notes) {
      y += 10;
      doc.rect(54, y, 504, 1).fillColor('#d8dadd').fill();
      doc.font('Helvetica-Bold').fontSize(9).fillColor(GRAY).text('PACKAGE NOTES', 54, y + 16);
      doc.font('Helvetica').fontSize(10.5).fillColor(CHARCOAL)
        .text(packet.cover_notes, 54, y + 34, { width: 504, height: 110, ellipsis: true });
    }

    doc.font('Helvetica').fontSize(8).fillColor(GRAY)
      .text(display(company.company_name, 'Recon Enterprises'), 54, 708, { width: 504, align: 'center' });
  });
}

async function renderContents({ packet, job, entries }) {
  return pdfKitBuffer(doc => {
    drawReconMark(doc);
    drawTopRule(doc);
    doc.font('Helvetica-Bold').fontSize(24).fillColor(CHARCOAL).text('Table of Contents', 54, 132);
    doc.font('Helvetica').fontSize(10).fillColor(GRAY)
      .text(`${display(job.title, 'Project')} | ${display(packet.revision, 'Original issue')}`, 54, 166);

    let y = 208;
    const drawHeader = () => {
      doc.rect(54, y, 504, 26).fillColor(LIGHT).fill();
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GRAY);
      doc.text('SECTION', 64, y + 9, { width: 72 });
      doc.text('SUBMITTAL', 144, y + 9, { width: 340 });
      doc.text('PAGE', 505, y + 9, { width: 43, align: 'right' });
      y += 34;
    };
    drawHeader();

    entries.forEach((entry, index) => {
      const title = display(entry.title, `Submittal ${index + 1}`);
      const subtitle = [entry.manufacturer, entry.product_name, entry.model_number].filter(Boolean).join(' | ');
      const rowHeight = subtitle ? 46 : 34;
      if (y + rowHeight > 710) {
        doc.addPage();
        drawReconMark(doc);
        drawTopRule(doc);
        doc.font('Helvetica-Bold').fontSize(18).fillColor(CHARCOAL).text('Table of Contents (continued)', 54, 132);
        y = 178;
        drawHeader();
      }
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(RED)
        .text(display(entry.section_number, String(index + 1).padStart(2, '0')), 64, y + 3, { width: 72 });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(CHARCOAL).text(title, 144, y + 3, { width: 340 });
      if (subtitle) {
        doc.font('Helvetica').fontSize(8.5).fillColor(GRAY).text(subtitle, 144, y + 20, { width: 340 });
      }
      doc.font('Helvetica-Bold').fontSize(10).fillColor(CHARCOAL)
        .text(String(entry.packet_page || ''), 505, y + 3, { width: 43, align: 'right' });
      doc.moveTo(54, y + rowHeight - 5).lineTo(558, y + rowHeight - 5).lineWidth(0.5).strokeColor('#d8dadd').stroke();
      y += rowHeight;
    });
  });
}

async function renderDivider({ item, job, index }) {
  return pdfKitBuffer(doc => {
    drawReconMark(doc);
    drawTopRule(doc);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(GRAY)
      .text(`SUBMITTAL ${String(index + 1).padStart(2, '0')}`, 54, 142);
    doc.font('Helvetica-Bold').fontSize(27).fillColor(CHARCOAL)
      .text(display(item.title, 'Product Submittal'), 54, 170, { width: 504 });
    if (item.section_number) {
      doc.font('Helvetica-Bold').fontSize(13).fillColor(RED)
        .text(`Section ${item.section_number}`, 54, 235, { width: 504 });
    }

    const details = [
      ['Manufacturer', item.manufacturer],
      ['Product', item.product_name],
      ['Model / product number', item.model_number],
      ['Project', job.title],
    ].filter(row => display(row[1]));
    let y = 292;
    details.forEach(([label, value]) => {
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GRAY).text(label.toUpperCase(), 54, y, { width: 145 });
      doc.font('Helvetica').fontSize(11).fillColor(CHARCOAL).text(display(value), 210, y - 1, { width: 348 });
      y += 32;
    });

    if (item.notes) {
      y += 12;
      doc.rect(54, y, 504, 1).fillColor('#d8dadd').fill();
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GRAY).text('NOTES', 54, y + 16);
      doc.font('Helvetica').fontSize(10.5).fillColor(CHARCOAL)
        .text(item.notes, 54, y + 36, { width: 504, height: 180, ellipsis: true });
    }
  });
}

async function pageCount(buffer) {
  const doc = await PDFDocument.load(buffer);
  return doc.getPageCount();
}

async function appendPdf(target, sourceBuffer) {
  const source = await PDFDocument.load(sourceBuffer);
  const pages = await target.copyPages(source, source.getPageIndices());
  pages.forEach(page => target.addPage(page));
}

async function buildSubmittalPacket({ packet, job, company = {}, items = [] }) {
  const preparedItems = [];
  for (const item of items) {
    const files = [];
    for (const file of item.files || []) {
      const count = await pageCount(file.buffer);
      files.push({ ...file, page_count: count });
    }
    preparedItems.push({ ...item, files });
  }

  const cover = await renderCover({ packet, job, company, itemCount: preparedItems.length });
  const provisionalContents = await renderContents({ packet, job, entries: preparedItems });
  const tocPages = await pageCount(provisionalContents);

  let packetPage = 2 + tocPages;
  const entries = preparedItems.map(item => {
    const entry = { ...item, packet_page: packetPage };
    packetPage += 1 + item.files.reduce((sum, file) => sum + file.page_count, 0);
    return entry;
  });
  const contents = await renderContents({ packet, job, entries });

  const output = await PDFDocument.create();
  await appendPdf(output, cover);
  await appendPdf(output, contents);
  for (let index = 0; index < entries.length; index += 1) {
    const item = entries[index];
    await appendPdf(output, await renderDivider({ item, job, index }));
    for (const file of item.files) await appendPdf(output, file.buffer);
  }

  const footerFont = await output.embedFont(StandardFonts.Helvetica);
  const totalPages = output.getPageCount();
  output.getPages().forEach((page, index) => {
    const { width } = page.getSize();
    const label = `Recon Enterprises | ${display(job.title, 'Project')} | ${index + 1} of ${totalPages}`;
    page.drawLine({ start: { x: 54, y: 30 }, end: { x: width - 54, y: 30 }, thickness: 0.5, color: rgb(0.82, 0.83, 0.84) });
    page.drawText(label, { x: 54, y: 17, size: 7.5, font: footerFont, color: rgb(0.42, 0.44, 0.46) });
  });

  output.setTitle(display(packet.packet_title, 'Product Submittal Package'));
  output.setSubject(`Product submittals for ${display(job.title, 'project')}`);
  output.setAuthor(display(company.company_name, 'Recon Enterprises'));
  output.setCreator('FORGE by Recon Enterprises');
  return Buffer.from(await output.save());
}

module.exports = { buildSubmittalPacket, pageCount };
