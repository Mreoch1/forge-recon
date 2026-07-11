/**
 * Ginosko Bid Sheet export.
 *
 * Fills Recon's approved RFP pricing for a project into Ginosko
 * Construction's "Exhibit B" bid-sheet Excel template and returns a
 * completed workbook Buffer. The original template file on disk is only
 * ever read, never written back to.
 *
 * ── Template discovery notes (read before changing cell mappings) ──────
 *
 * Template file: src/templates/ginosko-construction-bid-sheet.xlsx
 * Worksheet used: "Construction Bid Sheet" (a second sheet, "- Disclaimer -",
 * exists and is left completely untouched).
 *
 * The workbook has NO separate Markup % or General Requirements % input
 * anywhere. Materials + Labor + Miscellaneous roll straight into
 * Subtotal -> Tax -> Total (rows 74-80). Because there is nowhere else in
 * this workbook to carry FORGE's markup_pct/general_requirements_pct, this
 * export bakes each approved line's *already-marked-up* unit rate into the
 * Materials RATE and Labor RATE cells (qty/hours are left as FORGE's raw
 * quantity). That is intentional — see reconcile() below, which fails loudly
 * if that assumption ever stops holding for a given template revision.
 *
 * Labor: the template expects HOURS x RATE. FORGE's rfp_line_items table
 * has no dedicated "labor hours" column (as of 2026-07) — only quantity /
 * contractor_cost / vendor_cost, and FORGE's quantity for a labor line is a
 * day count, not an hour count. Per the agreed v2 rule: hours = FORGE
 * quantity * LABOR_HOURS_PER_DAY (8), rate = totalWithMarkup / hours, so
 * hours * rate still equals that line's approved total_with_markup exactly
 * — only how it's split between the HOURS and RATE columns changes. If
 * FORGE ever adds an explicit labor-hours field, prefer it over
 * quantity * 8 in buildLeafRows().
 *
 * If Ginosko ships a revised workbook, update ONLY the GINOSKO_TEMPLATE
 * object below (row/column addresses). Nothing else in this file should
 * ever need to hard-code a cell reference.
 * ────────────────────────────────────────────────────────────────────────
 */

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { _internal } = require('./rfp-export');

const { computedLineTotalCost, computedLineTotalWithMarkup, computeProjectGrandTotal } = _internal;

const TEMPLATE_PATH = path.join(__dirname, '..', 'templates', 'ginosko-construction-bid-sheet.xlsx');

// Labor lines in FORGE store a day-count in `quantity`, but the Ginosko
// template's Labor section is headed HOURS x RATE. Per the agreed v1 rule,
// convert day-count to hours by this fixed multiplier before writing the
// workbook (see buildLeafRows()).
const LABOR_HOURS_PER_DAY = 8;

// ── Discovered template layout — the single source of truth for cell refs ──
const GINOSKO_TEMPLATE = {
  worksheetName: 'Construction Bid Sheet',
  projectFields: {
    projectNameCell: 'C3',     // "PROJECT NAME"
    projectAddressCell: 'C4',  // "JOB LOCATION"
    scopeOfWorkCell: 'C15',    // "SCOPE OF WORK" — RFP category/trade name
    startDateCell: 'C5',       // "ESTIMATED START DATE" (best-effort, job.start_date)
    finishDateCell: 'E5',      // "ESTIMATED FINISH DATE" (best-effort, job.end_date)
    bidderNameCell: 'E8',      // "CONTRACTOR COMPANY NAME" (Recon side) — already
                                // static ("Recon Enterprises") in the shipped
                                // template; only repaired here if found blank.
    // No dedicated "bid prepared / export date" cell or separate
    // customer/GC-name cell exists in this template edition — see
    // limitations noted in the route handler / final report.
  },
  materials: {
    startRow: 31,
    endRow: 49,        // 19 entry rows in the template as shipped
    totalRow: 50,
    quantityColumn: 'B',
    descriptionColumn: 'C',
    rateColumn: 'D',
    amountColumn: 'E', // formula column (qty * rate) — never written directly
  },
  labor: {
    startRow: 53,
    endRow: 61,        // 9 entry rows in the template as shipped
    totalRow: 62,
    descriptionColumn: 'B',
    hoursColumn: 'C',
    rateColumn: 'D',
    amountColumn: 'E', // formula column (hours * rate) — never written directly
  },
  miscellaneous: {
    // 7 flat rows with literal $0 values and no qty/rate columns of their
    // own. FORGE has no scope_type that maps to "miscellaneous" today, so
    // per spec this section is intentionally left untouched.
    startRow: 65,
    endRow: 71,
    totalRow: 72,
  },
  summary: {
    materialsRefRow: 74, // "=E50" (materials total)
    laborRefRow: 75,     // "=E62" (labor total)
    miscRefRow: 76,      // "=E72" (misc total)
    subtotalRow: 77,     // "=SUM(E74:E76)"
    taxRateRow: 78,      // plain input value, left untouched (0 in the blank template)
    taxTotalRow: 79,     // "=E77*E78"
    grandTotalRow: 80,   // "=SUM(E77,E79)"
  },
};

class GinoskoReconciliationError extends Error {
  constructor(details) {
    super(
      `Ginosko export does not reconcile with the approved FORGE RFP total. ` +
      `FORGE approved total: $${details.forgeTotal.toFixed(2)}, ` +
      `expected workbook total: $${details.workbookTotal.toFixed(2)}, ` +
      `difference: $${details.diff.toFixed(2)}.`
    );
    this.name = 'GinoskoReconciliationError';
    this.details = details;
  }
}

class GinoskoTemplateMissingError extends Error {
  constructor(templatePath) {
    super(`Ginosko bid sheet template not found at ${templatePath}. Was src/templates/ginosko-construction-bid-sheet.xlsx removed or renamed?`);
    this.name = 'GinoskoTemplateMissingError';
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function normalizeText(v) {
  return String(v == null ? '' : v)
    .replace(/\r\n/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .trim();
}

function sanitizeFilenamePart(s) {
  // Strip only characters that are actually unsafe in filenames
  // (path separators, Windows-reserved chars, control chars). Spaces,
  // dashes, and ampersands are preserved to match Michael's example
  // filename convention for this specific export.
  return String(s || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatDateForCell(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC' });
}

/**
 * Build the "SCOPE OF WORK" label for the workbook. Most projects will have
 * a single RFP category; if a project has multiple, they are joined — the
 * template only has one label field, which is a known limitation.
 */
function buildScopeLabel(rfps) {
  const names = (rfps || [])
    .map(r => normalizeText(r && r.contractor_name))
    .filter(Boolean);
  return names.join('; ');
}

// Windows path-length headroom: Michael's file tree nests these downloads
// several folders deep, so the *filename itself* (not the full path) is
// capped at 207 characters — comfortably under Windows' 260-char MAX_PATH
// once a realistic folder prefix is added, with the .xlsx extension always
// preserved.
const MAX_FILENAME_LENGTH = 207;

function truncateFilenameToLimit(filename, maxLength) {
  if (filename.length <= maxLength) return filename;
  const ext = '.xlsx';
  const base = filename.slice(0, filename.length - ext.length);
  const keep = Math.max(0, maxLength - ext.length);
  const truncatedBase = base.slice(0, keep).replace(/[\s-]+$/, '');
  return `${truncatedBase}${ext}`;
}

/**
 * Build a Ginosko-specific export filename, e.g.
 * "06-41 - Millwork & Finish Carpentry - Ginosko Bid Sheet - Midway Square.xlsx"
 * Always <= MAX_FILENAME_LENGTH characters (extension preserved; the
 * category/scope name — the more identifying part — is kept, the project
 * name is what gets clipped if the combined name runs too long).
 */
function buildGinoskoFilename(job, rfps) {
  const scope = buildScopeLabel(rfps) || 'RFP';
  const projectName = (job && (job.title || job.name)) || `project-${job && job.id}`;
  const raw = `${scope} - Ginosko Bid Sheet - ${projectName}`;
  const sanitized = `${sanitizeFilenamePart(raw)}.xlsx`;
  return truncateFilenameToLimit(sanitized, MAX_FILENAME_LENGTH);
}

/**
 * Flatten every RFP category + line item for the project into leaf rows
 * (approved children when a parent has children; a standalone parent only
 * when it has none), split by scope_type into Materials (supplier) vs
 * Labor (contractor). Parent rows that have children are never themselves
 * exported — this is what prevents double-counting.
 *
 * Uses the exact same per-line total math as the standard RFP exports
 * (rfp-export.js), and — critically — the exact same rule for standalone
 * approved parents: their stored total_cost/total_with_markup is used
 * as-is (not recomputed), matching computeGrandTotal()/computeProjectGrandTotal()
 * so this export's expected total is guaranteed to equal the canonical
 * FORGE approved total by construction.
 */
function buildLeafRows(rfps, itemsByRfp) {
  const materials = [];
  const labor = [];

  function pushLeaf(row, useStoredTotal) {
    const qty = Number(row.quantity) || 0;
    const totalCost = useStoredTotal ? (Number(row.total_cost) || 0) : computedLineTotalCost(row);
    const totalWithMarkup = useStoredTotal ? (Number(row.total_with_markup) || 0) : computedLineTotalWithMarkup(row);
    const isLabor = row.scope_type !== 'supplier';
    // Labor rows: the template's Labor section expects HOURS x RATE, but
    // FORGE's quantity for a labor line is a day count, not an hour count.
    // Per the agreed rule, convert to hours = qty * LABOR_HOURS_PER_DAY and
    // recompute the rate against those hours, so hours * rate is still
    // exactly this line's approved totalWithMarkup (the total never moves).
    const displayQty = isLabor ? qty * LABOR_HOURS_PER_DAY : qty;
    const unitRate = displayQty > 0 ? totalWithMarkup / displayQty : 0;
    const leaf = {
      description: normalizeText(row.description),
      quantity: displayQty,
      unitRate,
      totalCost,
      totalWithMarkup,
    };
    if (!isLabor) materials.push(leaf);
    else labor.push(leaf);
  }

  (rfps || []).forEach(rfp => {
    const group = (itemsByRfp && itemsByRfp[rfp.id]) || { items: [], subItemsMap: {} };
    (group.items || []).forEach(item => {
      if (item.parent_line_item_id) return; // defensive: only top-level items here
      const children = (group.subItemsMap && group.subItemsMap[item.id]) || [];
      if (children.length > 0) {
        // Children are the source of truth. The parent is a rollup header
        // only and must never be exported alongside its children.
        children.filter(c => !!c.approved).forEach(c => pushLeaf(c, false));
      } else if (item.approved) {
        // Standalone approved parent with no children.
        pushLeaf(item, true);
      }
    });
  });

  return { materials, labor };
}

/**
 * Sum of every leaf row's total_with_markup — this is the amount this
 * export is *about* to write into the workbook, before we've written it.
 * Compared against computeProjectGrandTotal() as the reconciliation check.
 */
function sumLeafTotals(leaves) {
  return leaves.reduce((s, l) => s + l.totalWithMarkup, 0);
}

function copyCellStyle(sheet, fromRow, toRow) {
  ['A', 'B', 'C', 'D', 'E', 'F', 'G'].forEach(col => {
    const src = sheet.getCell(`${col}${fromRow}`);
    const dst = sheet.getCell(`${col}${toRow}`);
    dst.style = JSON.parse(JSON.stringify(src.style));
    if (src.numFmt) dst.numFmt = src.numFmt;
  });
}

/**
 * Insert `extra` blank rows immediately before a section's total row,
 * copying cell style from the section's last template entry row and
 * writing a row-relative amount formula into the new rows' amount column.
 * Returns an updated { startRow, endRow, totalRow } for the section.
 */
function insertExtraRows(sheet, section, extra, amountFormulaBuilder) {
  if (extra <= 0) return { ...section };
  const templateRow = section.endRow;
  // spliceRows(pos, 0, ...blankRows) inserts AT `pos`, shifting `pos` and
  // everything below it down by the number of inserted rows.
  sheet.spliceRows(section.totalRow, 0, ...Array.from({ length: extra }, () => []));
  for (let i = 0; i < extra; i++) {
    const newRowNum = section.endRow + 1 + i;
    copyCellStyle(sheet, templateRow, newRowNum);
    sheet.getCell(`${section.amountColumn}${newRowNum}`).value = { formula: amountFormulaBuilder(newRowNum) };
  }
  return {
    ...section,
    endRow: section.endRow + extra,
    totalRow: section.totalRow + extra,
  };
}

function shiftRowNumbers(section, offset) {
  if (!offset) return { ...section };
  const shifted = { ...section };
  Object.keys(shifted).forEach(key => {
    if (typeof shifted[key] === 'number') shifted[key] += offset;
  });
  return shifted;
}

function writeRows(sheet, section, leaves, buildCells) {
  leaves.forEach((leaf, i) => {
    const row = section.startRow + i;
    buildCells(row, leaf);
  });
}

/**
 * Populate the Materials / Labor sections, insert extra rows if the
 * approved line count exceeds the template's built-in capacity, and
 * rewrite the section total + summary formulas to reference the (possibly
 * shifted) row positions. Formula *ranges* are rewritten as needed when
 * rows move — the formulas themselves are never replaced with static
 * numbers, so Excel still recalculates them on open.
 */
function populateSheet(sheet, job, rfps, leaves) {
  const F = GINOSKO_TEMPLATE.projectFields;
  sheet.getCell(F.projectNameCell).value = normalizeText(job && (job.title || job.name));
  const addressParts = [job && job.address, job && job.city, [job && job.state, job && job.zip].filter(Boolean).join(' ')]
    .filter(Boolean);
  sheet.getCell(F.projectAddressCell).value = normalizeText(addressParts.join(', '));
  sheet.getCell(F.scopeOfWorkCell).value = buildScopeLabel(rfps);
  if (job && job.start_date) sheet.getCell(F.startDateCell).value = formatDateForCell(job.start_date);
  if (job && job.end_date) sheet.getCell(F.finishDateCell).value = formatDateForCell(job.end_date);
  const bidderCell = sheet.getCell(F.bidderNameCell);
  if (!bidderCell.value) bidderCell.value = 'Recon Enterprises';

  // ── Materials ──
  let materialsCfg = { ...GINOSKO_TEMPLATE.materials };
  const materialsCapacity = materialsCfg.endRow - materialsCfg.startRow + 1;
  const matExtra = Math.max(0, leaves.materials.length - materialsCapacity);
  materialsCfg = insertExtraRows(sheet, materialsCfg, matExtra, r => `${materialsCfg.quantityColumn}${r}*${materialsCfg.rateColumn}${r}`);
  writeRows(sheet, materialsCfg, leaves.materials, (row, leaf) => {
    sheet.getCell(`${materialsCfg.quantityColumn}${row}`).value = leaf.quantity;
    sheet.getCell(`${materialsCfg.descriptionColumn}${row}`).value = leaf.description;
    sheet.getCell(`${materialsCfg.rateColumn}${row}`).value = leaf.unitRate;
  });

  // ── Labor (shifted down by however many extra materials rows we added) ──
  let laborCfg = shiftRowNumbers(GINOSKO_TEMPLATE.labor, matExtra);
  const laborCapacity = laborCfg.endRow - laborCfg.startRow + 1;
  const laborExtra = Math.max(0, leaves.labor.length - laborCapacity);
  laborCfg = insertExtraRows(sheet, laborCfg, laborExtra, r => `${laborCfg.hoursColumn}${r}*${laborCfg.rateColumn}${r}`);
  writeRows(sheet, laborCfg, leaves.labor, (row, leaf) => {
    sheet.getCell(`${laborCfg.descriptionColumn}${row}`).value = leaf.description;
    sheet.getCell(`${laborCfg.hoursColumn}${row}`).value = leaf.quantity; // no explicit labor-hours field in FORGE yet — see file header
    sheet.getCell(`${laborCfg.rateColumn}${row}`).value = leaf.unitRate;
  });

  // ── Misc + summary (shifted down by materials + labor extra rows) ──
  const totalOffset = matExtra + laborExtra;
  const miscCfg = shiftRowNumbers(GINOSKO_TEMPLATE.miscellaneous, totalOffset);
  const summaryCfg = shiftRowNumbers(GINOSKO_TEMPLATE.summary, totalOffset);

  // Rewrite structural total/summary formulas against the final row
  // positions. When totalOffset is 0 these are textually identical to the
  // template's original formulas (no-op); they only actually change when
  // rows were inserted above them.
  sheet.getCell(`E${materialsCfg.totalRow}`).value = { formula: `SUM(E${materialsCfg.startRow}:E${materialsCfg.endRow})` };
  sheet.getCell(`E${laborCfg.totalRow}`).value = { formula: `SUM(E${laborCfg.startRow}:E${laborCfg.endRow})` };
  sheet.getCell(`E${miscCfg.totalRow}`).value = { formula: `SUM(E${miscCfg.startRow}:E${miscCfg.endRow})` };
  sheet.getCell(`E${summaryCfg.materialsRefRow}`).value = { formula: `E${materialsCfg.totalRow}` };
  sheet.getCell(`E${summaryCfg.laborRefRow}`).value = { formula: `E${laborCfg.totalRow}` };
  sheet.getCell(`E${summaryCfg.miscRefRow}`).value = { formula: `E${miscCfg.totalRow}` };
  sheet.getCell(`E${summaryCfg.subtotalRow}`).value = { formula: `SUM(E${summaryCfg.materialsRefRow}:E${summaryCfg.miscRefRow})` };
  sheet.getCell(`E${summaryCfg.taxTotalRow}`).value = { formula: `E${summaryCfg.subtotalRow}*E${summaryCfg.taxRateRow}` };
  sheet.getCell(`E${summaryCfg.grandTotalRow}`).value = { formula: `SUM(E${summaryCfg.subtotalRow},E${summaryCfg.taxTotalRow})` };

  return { materialsCfg, laborCfg, miscCfg, summaryCfg, matExtra, laborExtra };
}

/**
 * Load the template fresh from disk (read-only — the original file on
 * disk is never modified), populate it for the given project, validate
 * that the amount we're about to ship reconciles with FORGE's approved
 * RFP total, and return { buffer, filename, forgeTotal, workbookTotal,
 * matExtra, laborExtra }.
 *
 * Throws GinoskoTemplateMissingError if the template file is gone, or
 * GinoskoReconciliationError if the computed workbook total doesn't match
 * the FORGE approved total within $0.01 — callers must not send the
 * workbook to the client in that case.
 */
async function buildGinoskoExport(job, rfps, itemsByRfp) {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new GinoskoTemplateMissingError(TEMPLATE_PATH);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(TEMPLATE_PATH);
  const sheet = workbook.getWorksheet(GINOSKO_TEMPLATE.worksheetName);
  if (!sheet) {
    throw new Error(`Ginosko template is missing the expected worksheet "${GINOSKO_TEMPLATE.worksheetName}".`);
  }

  const leaves = buildLeafRows(rfps, itemsByRfp);

  // ── Validate BEFORE sending anything to the client ──
  const forgeTotal = round2(computeProjectGrandTotal(rfps, itemsByRfp));
  const workbookTotal = round2(sumLeafTotals(leaves.materials) + sumLeafTotals(leaves.labor));
  const diff = round2(Math.abs(forgeTotal - workbookTotal));
  if (diff > 0.01) {
    const details = { forgeTotal, workbookTotal, diff };
    console.error('[ginosko-export] reconciliation mismatch', details);
    throw new GinoskoReconciliationError(details);
  }

  const layout = populateSheet(sheet, job, rfps, leaves);

  // Force Excel to recalculate every formula (including the ones we just
  // rewrote) as soon as the file is opened — ExcelJS itself never
  // evaluates formulas, it only stores them.
  workbook.calcProperties = workbook.calcProperties || {};
  workbook.calcProperties.fullCalcOnLoad = true;
  workbook.calcProperties.forceFullCalc = true;
  workbook.calcProperties.calcMode = 'auto';

  const buffer = await workbook.xlsx.writeBuffer();
  const filename = buildGinoskoFilename(job, rfps);

  return {
    buffer,
    filename,
    forgeTotal,
    workbookTotal,
    materialsCount: leaves.materials.length,
    laborCount: leaves.labor.length,
    matExtra: layout.matExtra,
    laborExtra: layout.laborExtra,
  };
}

module.exports = {
  GINOSKO_TEMPLATE,
  TEMPLATE_PATH,
  MAX_FILENAME_LENGTH,
  LABOR_HOURS_PER_DAY,
  GinoskoReconciliationError,
  GinoskoTemplateMissingError,
  buildGinoskoFilename,
  buildScopeLabel,
  buildLeafRows,
  sumLeafTotals,
  buildGinoskoExport,
  _internal: {
    normalizeText,
    sanitizeFilenamePart,
    truncateFilenameToLimit,
    insertExtraRows,
    shiftRowNumbers,
    populateSheet,
  },
};
