const MAX_SOURCE_CHARS = 7000;
const MAX_FILES_TO_READ = 3;
const MAX_PAGES_PER_FILE = 6;
const { SUBMITTAL_TRADE_CATEGORIES, classifySubmittalTrade } = require('./submittal-trade-categories');

const METADATA_SYSTEM_PROMPT = [
  'Extract construction product-submittal metadata from the supplied product specification.',
  'Return only valid JSON with these string fields:',
  '{"section_number":"","title":"","manufacturer":"","product_name":"","model_number":"","notes":""}',
  `The section_number field is a trade category, not a CSI number. Choose exactly one of: ${SUBMITTAL_TRADE_CATEGORIES.join('; ')}.`,
  'Examples: carpet and LVT are Flooring; ProMar 200 is Paint & Coatings; a vanity light bar is Electrical.',
  'Use only facts present in the supplied document. Never invent missing values.',
  'The title should be a concise product or system description, not a filename.',
  'If a sheet lists a product family with several models, use the family or series name and summarize the relevant model range instead of choosing one arbitrarily.',
  'Notes should be concise and include useful selections such as finish, color, rating, listing, size, or performance data.',
  'Use an empty string for unknown fields. Ignore headers, footers, legal boilerplate, and contact details.',
].join('\n');

function loadPdfParser() {
  const canvas = require('@napi-rs/canvas');
  globalThis.DOMMatrix ||= canvas.DOMMatrix;
  globalThis.ImageData ||= canvas.ImageData;
  globalThis.Path2D ||= canvas.Path2D;
  return require('pdf-parse').PDFParse;
}

function clean(value, max) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function filenameTitle(fileName) {
  return clean(String(fileName || '')
    .replace(/\.pdf$/i, '')
    .replace(/[-_]+/g, ' '), 240) || 'Product submittal';
}

function sanitizeMetadata(value = {}) {
  return {
    section_number: clean(value.section_number, 80),
    title: clean(value.title, 240),
    manufacturer: clean(value.manufacturer, 180),
    product_name: clean(value.product_name, 180),
    model_number: clean(value.model_number, 180),
    notes: clean(value.notes, 3000),
  };
}

function hasProductDetails(value = {}) {
  const metadata = sanitizeMetadata(value);
  return Object.entries(metadata).some(([key, detail]) => key !== 'title' && Boolean(detail));
}

function normalizeExtractedMetadata(value = {}) {
  const metadata = sanitizeMetadata(value);
  return { ...metadata, section_number: classifySubmittalTrade(metadata) };
}

function fillBlankMetadata(current = {}, suggested = {}) {
  const existing = sanitizeMetadata(current);
  const extracted = sanitizeMetadata(suggested);
  return Object.fromEntries(Object.keys(existing).map(key => [key, existing[key] || extracted[key]]));
}

async function textFromPdf(buffer, fileName) {
  const PDFParse = loadPdfParser();
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText({ first: MAX_PAGES_PER_FILE });
    const body = String(result?.text || '').replace(/\u0000/g, '').trim();
    const substantiveText = body.replace(/--\s*\d+\s+of\s+\d+\s*--/gi, '').trim();
    return substantiveText ? `FILE: ${fileName}\n${body}` : '';
  } finally {
    await parser.destroy().catch(() => {});
  }
}

async function extractSourceText(files) {
  const chunks = [];
  const warnings = [];
  for (const file of (files || []).slice(0, MAX_FILES_TO_READ)) {
    try {
      const chunk = await textFromPdf(file.buffer, file.fileName);
      if (chunk) chunks.push(chunk);
      else warnings.push(`${file.fileName} does not contain readable text.`);
    } catch (error) {
      warnings.push(`${file.fileName} could not be read for auto-fill.`);
    }
    if (chunks.join('\n\n').length >= MAX_SOURCE_CHARS) break;
  }
  return { text: chunks.join('\n\n').slice(0, MAX_SOURCE_CHARS), warnings };
}

async function extractSubmittalMetadata({ files, userId, aiService }) {
  const fallback = sanitizeMetadata({ title: filenameTitle(files?.[0]?.fileName) });
  const source = await extractSourceText(files);
  const provider = aiService || require('./ai');
  if (!source.text) {
    if (provider.canAnalyzeFiles?.() && typeof provider.extractFiles === 'function') {
      const fileResult = await provider.extractFiles({
        taskName: 'submittal-product-spec-pdf-vision',
        userId,
        system: METADATA_SYSTEM_PROMPT,
        user: 'Read the attached product-spec PDF, including scanned or image-only pages, and extract its product-submittal details.',
        files,
      });
      if (fileResult.ok) {
        const rawExtracted = sanitizeMetadata(fileResult.data);
        if (hasProductDetails(rawExtracted)) {
          const extracted = normalizeExtractedMetadata(rawExtracted);
          return {
            data: { ...extracted, title: extracted.title || fallback.title },
            source: 'document',
            method: 'file-vision',
            warnings: [],
          };
        }
      }
      return {
        data: fallback,
        source: 'filename-ai-failed',
        warnings: [...source.warnings, 'Forge could not identify product details in the scanned PDF.'],
      };
    }
    return { data: fallback, source: 'filename', warnings: source.warnings };
  }
  if (!provider.isConfigured()) {
    return { data: fallback, source: 'filename-no-ai', warnings: source.warnings };
  }

  const result = await provider.extract({
    taskName: 'submittal-product-spec-extraction',
    userId,
    system: METADATA_SYSTEM_PROMPT,
    user: source.text,
  });

  if (!result.ok) {
    return {
      data: fallback,
      source: 'filename-ai-failed',
      warnings: [...source.warnings, 'Forge could not analyze the product spec automatically.'],
    };
  }

  const rawExtracted = sanitizeMetadata(result.data);
  if (!hasProductDetails(rawExtracted)) {
    return {
      data: fallback,
      source: 'filename-ai-failed',
      warnings: [...source.warnings, 'Forge could not identify product details in the product spec.'],
    };
  }
  const extracted = normalizeExtractedMetadata(rawExtracted);
  return {
    data: { ...extracted, title: extracted.title || fallback.title },
    source: 'document',
    warnings: source.warnings,
  };
}

module.exports = {
  extractSourceText,
  extractSubmittalMetadata,
  filenameTitle,
  fillBlankMetadata,
  normalizeExtractedMetadata,
  sanitizeMetadata,
};
