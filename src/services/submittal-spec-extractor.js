const MAX_SOURCE_CHARS = 7000;
const MAX_FILES_TO_READ = 3;
const MAX_PAGES_PER_FILE = 6;

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
    return body ? `FILE: ${fileName}\n${body}` : '';
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
  if (!source.text) {
    return {
      data: fallback,
      source: 'filename',
      warnings: source.warnings,
    };
  }
  const provider = aiService || require('./ai');
  if (!provider.isConfigured()) {
    return { data: fallback, source: 'filename-no-ai', warnings: source.warnings };
  }

  const result = await provider.extract({
    taskName: 'submittal-product-spec-extraction',
    userId,
    system: [
      'Extract construction product-submittal metadata from product specification text.',
      'Return only valid JSON with these string fields:',
      '{"section_number":"","title":"","manufacturer":"","product_name":"","model_number":"","notes":""}',
      'Use only facts present in the supplied text. Never invent missing values.',
      'The title should be a concise product or system description, not a filename.',
      'Notes should be concise and include useful selections such as finish, color, rating, listing, size, or performance data.',
      'Use an empty string for unknown fields. Ignore headers, footers, legal boilerplate, and contact details.',
    ].join('\n'),
    user: source.text,
  });

  if (!result.ok) {
    return {
      data: fallback,
      source: 'filename-ai-failed',
      warnings: [...source.warnings, 'Forge could not analyze the product spec automatically.'],
    };
  }

  const extracted = sanitizeMetadata(result.data);
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
  sanitizeMetadata,
};
