const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const {
  buildSubmittalPacket,
  pageCount,
  SUBMITTAL_HEADER_LAYOUT,
} = require('../src/services/submittal-packet-pdf');

const ROOT = path.join(__dirname, '..');

async function productSpecPdf(title, pages = 1) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pages; index += 1) {
    const page = pdf.addPage([612, 792]);
    page.drawText(`${title} - manufacturer page ${index + 1}`, { x: 72, y: 700, size: 18, font });
  }
  return Buffer.from(await pdf.save());
}

test('submittal packet includes cover, contents, dividers, and every product-spec page', async () => {
  const doorSpec = await productSpecPdf('Door Hardware', 2);
  const paintSpec = await productSpecPdf('Interior Paint', 1);
  const packet = await buildSubmittalPacket({
    packet: {
      packet_title: 'Product Submittal Package',
      prepared_for: 'General Contractor',
      prepared_by: 'Eric - Recon Enterprises',
      issue_date: '2026-07-17',
      revision: 'Rev 1',
      cover_notes: 'Submitted for review and approval.',
    },
    job: {
      title: 'Test Apartments',
      address: '100 Main Street',
      city: 'Detroit',
      state: 'MI',
      zip: '48201',
      customer_name: 'Test GC',
    },
    company: { company_name: 'Recon Enterprises' },
    items: [
      {
        section_number: '08 71 00',
        title: 'Door Hardware',
        manufacturer: 'Example Hardware',
        product_name: 'Lever Set',
        model_number: 'L100',
        notes: 'Satin chrome finish.',
        files: [{ file_name: 'door-hardware.pdf', buffer: doorSpec }],
      },
      {
        section_number: '09 91 00',
        title: 'Interior Paint',
        manufacturer: 'Example Coatings',
        files: [{ file_name: 'paint.pdf', buffer: paintSpec }],
      },
    ],
  });

  const parsed = await PDFDocument.load(packet);
  assert.equal(parsed.getPageCount(), 7);
  assert.equal(parsed.getTitle(), 'Product Submittal Package');
  assert.equal(parsed.getAuthor(), 'Recon Enterprises');
  assert.ok(packet.length > doorSpec.length + paintSpec.length);
});

test('submittal packet routes and project navigation are wired', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');
  const routes = fs.readFileSync(path.join(ROOT, 'src/routes/submittals.js'), 'utf8');
  const tabs = fs.readFileSync(path.join(ROOT, 'src/views/jobs/_project_tabs.ejs'), 'utf8');
  const view = fs.readFileSync(path.join(ROOT, 'src/views/jobs/submittals.ejs'), 'utf8');
  const coverImage = path.join(ROOT, 'public/images/submittals/modern-office-cover.jpg');

  assert.match(app, /app\.use\('\/projects', requireAuth, requireManager, submittalRoutes\)/);
  assert.match(routes, /submittals\/packet\.pdf/);
  assert.match(routes, /submittals\/import/);
  assert.match(routes, /storage\.getUploadUrl\(BUCKET, key\)/);
  assert.match(routes, /extractSubmittalMetadata/);
  assert.match(tabs, /key: 'submittals'/);
  assert.match(view, /Build packet PDF/);
  assert.match(view, /Import a prior packet/);
  assert.match(view, /Forge reads text-based PDFs and fills blank details/);
  assert.doesNotMatch(view, /name="title"[^>]*required/);
  assert.match(view, /class="ops-shell"/);
  assert.equal(fs.existsSync(coverImage), true);
});

test('pageCount reads uploaded manufacturer PDFs', async () => {
  assert.equal(await pageCount(await productSpecPdf('Three pages', 3)), 3);
});

test('submittal page header keeps the complete Recon logo above the red rule', () => {
  const logoBottom = SUBMITTAL_HEADER_LAYOUT.logoY + SUBMITTAL_HEADER_LAYOUT.logoHeight;
  assert.ok(logoBottom + 8 <= SUBMITTAL_HEADER_LAYOUT.ruleY);
});
