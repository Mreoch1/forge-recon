const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const {
  extractSubmittalMetadata,
  filenameTitle,
  fillBlankMetadata,
} = require('../src/services/submittal-spec-extractor');

async function productSpecPdf() {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('SECTION 08 71 00 - DOOR HARDWARE', { x: 40, y: 740, font, size: 12 });
  page.drawText('Manufacturer: Example Hardware Company', { x: 40, y: 710, font, size: 12 });
  page.drawText('Product: Commercial Lever Set, Model LH-200', { x: 40, y: 680, font, size: 12 });
  page.drawText('Finish: Satin chrome. UL listed.', { x: 40, y: 650, font, size: 12 });
  return Buffer.from(await pdf.save());
}

test('submittal metadata extractor reads PDF text and sanitizes AI suggestions', async () => {
  let prompt = '';
  const aiService = {
    isConfigured: () => true,
    extract: async request => {
      prompt = request.user;
      return {
        ok: true,
        data: {
          section_number: '08 71 00',
          title: 'Commercial Door Hardware',
          manufacturer: 'Example Hardware Company',
          product_name: 'Commercial Lever Set',
          model_number: 'LH-200',
          notes: 'Satin chrome; UL listed.',
        },
      };
    },
  };
  const result = await extractSubmittalMetadata({
    files: [{ fileName: 'door-hardware.pdf', buffer: await productSpecPdf() }],
    userId: 7,
    aiService,
  });
  assert.equal(result.source, 'document');
  assert.match(prompt, /Example Hardware Company/);
  assert.equal(result.data.section_number, 'Doors, Frames & Hardware');
  assert.equal(result.data.model_number, 'LH-200');
});

test('submittal metadata extractor falls back to a filename when PDF text is unavailable', async () => {
  const result = await extractSubmittalMetadata({
    files: [{ fileName: 'Acme_Roof_Drain.pdf', buffer: Buffer.from('not a readable PDF') }],
    aiService: { isConfigured: () => false },
  });
  assert.equal(result.source, 'filename');
  assert.equal(result.data.title, 'Acme Roof Drain');
  assert.ok(result.warnings.length > 0);
});

test('submittal metadata extractor analyzes scanned PDFs through file vision', async () => {
  let attachedFile = null;
  const result = await extractSubmittalMetadata({
    files: [{ fileName: 'vanity-light.pdf', buffer: Buffer.from('image-only pdf bytes') }],
    aiService: {
      canAnalyzeFiles: () => true,
      extractFiles: async request => {
        attachedFile = request.files[0];
        return {
          ok: true,
          data: {
            section_number: '26 51 00',
            title: 'LED Vanity Light',
            manufacturer: 'Example Lighting',
            product_name: 'LED Vanity and T8 Lamp Vanity',
            model_number: 'FL4100 Series',
            notes: 'Satin nickel; Energy Star listed.',
          },
        };
      },
    },
  });

  assert.equal(result.source, 'document');
  assert.equal(result.method, 'file-vision');
  assert.equal(attachedFile.fileName, 'vanity-light.pdf');
  assert.equal(result.data.section_number, 'Electrical');
  assert.equal(result.data.manufacturer, 'Example Lighting');
  assert.equal(result.data.model_number, 'FL4100 Series');
});

test('submittal metadata classifies common products into trade categories', () => {
  const { normalizeExtractedMetadata } = require('../src/services/submittal-spec-extractor');
  assert.equal(normalizeExtractedMetadata({ product_name: 'Commercial broadloom carpet' }).section_number, 'Flooring');
  assert.equal(normalizeExtractedMetadata({ product_name: 'ProMar 200 Interior Latex' }).section_number, 'Paint & Coatings');
  assert.equal(normalizeExtractedMetadata({ title: 'Vanity light bar' }).section_number, 'Electrical');
  assert.equal(normalizeExtractedMetadata({ section_number: '22 40 00', title: 'Lavatory faucet' }).section_number, 'Plumbing');
});

test('stored CSI sections normalize while custom trade categories remain intact', () => {
  const { normalizeStoredTradeCategory } = require('../src/services/submittal-trade-categories');
  assert.equal(normalizeStoredTradeCategory({ section_number: '09 65 00', title: 'LVT flooring' }), 'Flooring');
  assert.equal(normalizeStoredTradeCategory({ section_number: 'Custom Owner Furnishings' }), 'Custom Owner Furnishings');
  assert.equal(normalizeStoredTradeCategory({ section_number: '' }), '');
});

test('submittal metadata extractor does not report success for a title-only result', async () => {
  const result = await extractSubmittalMetadata({
    files: [{ fileName: 'fixture.pdf', buffer: Buffer.from('not a readable pdf') }],
    aiService: {
      canAnalyzeFiles: () => true,
      extractFiles: async () => ({ ok: true, data: { title: 'Fixture' } }),
    },
  });

  assert.equal(result.source, 'filename-ai-failed');
  assert.equal(result.data.title, 'fixture');
});

test('submittal parser dependencies are lazy-loaded so app startup stays isolated', () => {
  const source = require('node:fs').readFileSync(require.resolve('../src/services/submittal-spec-extractor'), 'utf8');
  assert.doesNotMatch(source.split('function loadPdfParser')[0], /require\('pdf-parse'\)/);
  assert.match(source, /require\('@napi-rs\/canvas'\)/);
});

test('submittal auto-fill preserves metadata the user already entered', () => {
  const merged = fillBlankMetadata(
    { title: 'Eric selected title', manufacturer: '', notes: 'Blue finish' },
    { title: 'Extracted title', manufacturer: 'Acme', notes: 'Red finish', model_number: 'A-10' },
  );
  assert.equal(merged.title, 'Eric selected title');
  assert.equal(merged.manufacturer, 'Acme');
  assert.equal(merged.notes, 'Blue finish');
  assert.equal(merged.model_number, 'A-10');
  assert.equal(filenameTitle('Pump_Schedule.pdf'), 'Pump Schedule');
  assert.equal(filenameTitle('door-hardware.pdf'), 'door hardware');
});
