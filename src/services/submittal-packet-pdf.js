const fs = require('fs');
const path = require('path');
const PDFKit = require('pdfkit');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const RED = '#c8202f';
const CHARCOAL = '#202124';
const GRAY = '#6f7378';
const LIGHT = '#f2f3f4';
const LOGO_PATH = path.join(__dirname, '../../public/logos/recon.png');
const COVER_IMAGE_PATH = path.join(__dirname, '../../public/images/submittals/modern-office-cover.jpg');
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const SUBMITTAL_HEADER_LAYOUT = Object.freeze({
  logoX: 54,
  logoY: 30,
  logoWidth: 82,
  logoHeight: 88,
  ruleY: 126,
});

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
    doc.image(LOGO_PATH, SUBMITTAL_HEADER_LAYOUT.logoX, SUBMITTAL_HEADER_LAYOUT.logoY, {
      fit: [SUBMITTAL_HEADER_LAYOUT.logoWidth, SUBMITTAL_HEADER_LAYOUT.logoHeight],
      align: 'left',
      valign: 'top',
    });
  } else {
    doc.font('Helvetica-Bold').fontSize(20).fillColor(RED)
      .text('RECON', SUBMITTAL_HEADER_LAYOUT.logoX, 68);
  }
}

function drawTopRule(doc, y = SUBMITTAL_HEADER_LAYOUT.ruleY) {
  doc.save().moveTo(54, y).lineTo(558, y).lineWidth(2.5).strokeColor(RED).stroke().restore();
}

function projectAddress(job) {
  const locality = [job.city, job.state, job.zip].filter(Boolean).join(', ');
  return [job.address, locality].filter(Boolean).join(', ');
}

async function renderCover({ packet, job, company, itemCount }) {
  return pdfKitBuffer(doc => {
    if (fs.existsSync(COVER_IMAGE_PATH)) {
      doc.image(COVER_IMAGE_PATH, 0, 0, {
        cover: [PAGE_WIDTH, PAGE_HEIGHT],
        align: 'center',
        valign: 'center',
      });
    } else {
      doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fillColor('#d9d9d5').fill();
    }

    doc.save().fillColor('#000000').fillOpacity(0.08)
      .rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fill().restore();
    doc.save().fillColor('#111214').fillOpacity(0.88)
      .rect(0, 396, PAGE_WIDTH, PAGE_HEIGHT - 396).fill().restore();
    doc.rect(0, 396, PAGE_WIDTH, 5).fillColor(RED).fill();

    doc.save().fillColor('#ffffff').fillOpacity(0.94)
      .rect(42, 34, 102, 108).fill().restore();
    if (fs.existsSync(LOGO_PATH)) {
      doc.image(LOGO_PATH, 54, 44, { fit: [78, 88], align: 'center', valign: 'center' });
    } else {
      doc.font('Helvetica-Bold').fontSize(18).fillColor(RED).text('RECON', 52, 77, { width: 82, align: 'center' });
    }

    doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff')
      .text('FORGE  /  PROJECT SUBMITTALS', 350, 48, {
        width: 210,
        align: 'right',
        characterSpacing: 1.1,
      });

    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#c9cccf')
      .text('PRODUCT DOCUMENTATION', 50, 430, { width: 512, characterSpacing: 1.5 });
    doc.font('Helvetica-Bold').fontSize(30).fillColor('#ffffff')
      .text(display(packet.packet_title, 'Product Submittal Package'), 50, 452, {
        width: 512,
        height: 72,
        ellipsis: true,
        lineGap: 2,
      });

    doc.font('Helvetica-Bold').fontSize(17).fillColor(RED)
      .text(display(job.title, 'Project'), 50, 536, { width: 512, height: 24, ellipsis: true });
    const address = projectAddress(job);
    if (address) {
      doc.font('Helvetica').fontSize(10).fillColor('#e3e4e5')
        .text(address, 50, 562, { width: 512, height: 18, ellipsis: true });
    }
    doc.rect(50, 592, 512, 1).fillColor('#65686b').fill();

    const preparedFor = display(packet.prepared_for, job.customer_name);
    const preparedBy = display(packet.prepared_by, company.company_name || 'Recon Enterprises');
    const leftDetails = [
      ['Prepared for', preparedFor],
      ['Prepared by', preparedBy],
    ].filter(row => row[1]);
    const rightDetails = [
      ['Issue date', formatDate(packet.issue_date)],
      ['Revision', display(packet.revision, 'Original issue')],
      ['Submittals', String(itemCount)],
    ].filter(row => row[1]);

    leftDetails.forEach(([label, value], index) => {
      const y = 616 + (index * 52);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#9fa3a7')
        .text(label.toUpperCase(), 50, y, { width: 285, characterSpacing: 0.9 });
      doc.font('Helvetica').fontSize(10.5).fillColor('#ffffff')
        .text(value, 50, y + 14, { width: 285, height: 28, ellipsis: true });
    });
    rightDetails.forEach(([label, value], index) => {
      const y = 616 + (index * 38);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#9fa3a7')
        .text(label.toUpperCase(), 382, y, { width: 180, characterSpacing: 0.9 });
      doc.font('Helvetica').fontSize(10.5).fillColor('#ffffff')
        .text(value, 382, y + 13, { width: 180, height: 18, ellipsis: true });
    });

    if (packet.cover_notes) {
      doc.font('Helvetica').fontSize(8.5).fillColor('#b7babd')
        .text(packet.cover_notes, 50, 739, { width: 512, height: 28, ellipsis: true });
    }
  });
}

async function renderContents({ packet, job, entries }) {
  return pdfKitBuffer(doc => {
    drawReconMark(doc);
    drawTopRule(doc);
    doc.font('Helvetica-Bold').fontSize(24).fillColor(CHARCOAL).text('Table of Contents', 54, 150);
    doc.font('Helvetica').fontSize(10).fillColor(GRAY)
      .text(`${display(job.title, 'Project')} | ${display(packet.revision, 'Original issue')}`, 54, 184);

    let y = 226;
    const drawHeader = () => {
      doc.rect(54, y, 504, 26).fillColor(LIGHT).fill();
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GRAY);
      doc.text('TRADE', 64, y + 9, { width: 128 });
      doc.text('SUBMITTAL', 200, y + 9, { width: 284 });
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
        doc.font('Helvetica-Bold').fontSize(18).fillColor(CHARCOAL).text('Table of Contents (continued)', 54, 150);
        y = 196;
        drawHeader();
      }
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(RED)
        .text(display(entry.section_number, String(index + 1).padStart(2, '0')), 64, y + 3, { width: 128 });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(CHARCOAL).text(title, 200, y + 3, { width: 284 });
      if (subtitle) {
        doc.font('Helvetica').fontSize(8.5).fillColor(GRAY).text(subtitle, 200, y + 20, { width: 284 });
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
      .text(`SUBMITTAL ${String(index + 1).padStart(2, '0')}`, 54, 154);
    doc.font('Helvetica-Bold').fontSize(27).fillColor(CHARCOAL)
      .text(display(item.title, 'Product Submittal'), 54, 182, { width: 504 });
    if (item.section_number) {
      doc.font('Helvetica-Bold').fontSize(13).fillColor(RED)
        .text(`Trade: ${item.section_number}`, 54, 247, { width: 504 });
    }

    const details = [
      ['Manufacturer', item.manufacturer],
      ['Product', item.product_name],
      ['Model / product number', item.model_number],
      ['Project', job.title],
    ].filter(row => display(row[1]));
    let y = 304;
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
    if (index === 0) return;
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

module.exports = { buildSubmittalPacket, pageCount, SUBMITTAL_HEADER_LAYOUT };
