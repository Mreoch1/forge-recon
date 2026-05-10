/**
 * Accounting posting service.
 *
 * Creates double-entry journal entries from operational events:
 *
 *   Invoice sent (status draft -> sent):
 *     DR  Accounts Receivable           invoice.total
 *     CR    Service Revenue             invoice.subtotal
 *     CR    Sales Tax Payable           invoice.tax_amount
 *
 *   Payment received (mark-paid, full or partial):
 *     DR  Cash                          amount
 *     CR    Accounts Receivable         amount
 *
 *   Invoice voided (after sent):
 *     A reversing JE that mirrors the original. Source links back to the
 *     original entry via reversed_by_entry_id.
 *
 *   Bill approved (vendor bill draft -> approved):
 *     DR  Expense Account (per line)    line_total
 *     CR    Accounts Payable            bill.total
 *
 *   Bill paid:
 *     DR  Accounts Payable              amount
 *     CR    Cash                        amount
 *
 * Account lookup uses fixed code constants. If the chart of accounts hasn't
 * been seeded (init-accounting.js), posting silently no-ops with a console
 * warning — operational flow continues. The financial event will need to
 * be re-posted manually once accounts exist.
 *
 * All postings are wrapped in a single transaction with the operational
 * write (caller's responsibility) for atomicity.
 */

const db = require('../db/db');
const { writeAudit } = require('./audit');

// Standard account codes (matches seeded chart in init-accounting.js).
const CODES = {
  CASH:               '1000',
  ACCOUNTS_RECEIVABLE:'1100',
  ACCOUNTS_PAYABLE:   '2000',
  SALES_TAX_PAYABLE:  '2100',  // tax we owe (sale-side)
  SERVICE_REVENUE:    '4000',
  MISC_EXPENSE:       '5900',  // fallback when bill line has no account_id
  SALES_TAX_BILLS:    '5950',  // tax we paid on vendor bills (purchase-side)
};

function lookupAccount(code) {
  return db.get('SELECT id, code, name FROM accounts WHERE code = ? AND active = 1', [code]);
}

function isAccountingReady() {
  // Cheap probe: does the accounts table even exist + have rows?
  try {
    const r = db.get("SELECT COUNT(*) AS n FROM accounts");
    return r && r.n > 0;
  } catch (e) {
    return false;
  }
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Internal: create a journal entry with N lines. lines is array of
 * { accountId, debit, credit, description }. Validates that debits == credits.
 * Returns the created entry id.
 */
function postJournalEntry({ entryDate, description, sourceType, sourceId, userId, lines }) {
  if (!Array.isArray(lines) || lines.length < 2) {
    throw new Error('Journal entry needs at least 2 lines.');
  }
  let totalDr = 0, totalCr = 0;
  lines.forEach(l => {
    totalDr += Number(l.debit) || 0;
    totalCr += Number(l.credit) || 0;
  });
  // Allow tiny float drift (sub-penny) but reject larger imbalances.
  if (Math.abs(totalDr - totalCr) > 0.005) {
    throw new Error(`JE imbalance: debits ${totalDr.toFixed(2)} != credits ${totalCr.toFixed(2)}`);
  }

  return db.transaction(() => {
    const r = db.run(
      `INSERT INTO journal_entries (entry_date, description, source_type, source_id, created_by_user_id)
       VALUES (?, ?, ?, ?, ?)`,
      [entryDate || todayDate(), description || '', sourceType || null, sourceId || null, userId || null]
    );
    const jeId = r.lastInsertRowid;
    lines.forEach(l => {
      db.run(
        `INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit, description)
         VALUES (?, ?, ?, ?, ?)`,
        [jeId, l.accountId, Number(l.debit) || 0, Number(l.credit) || 0, l.description || '']
      );
    });
    writeAudit({
      entityType: 'journal_entry',
      entityId: jeId,
      action: 'post',
      before: null,
      after: { description, sourceType, sourceId, totalDr, totalCr, lines: lines.length },
      source: 'system',
      userId,
    });
    return jeId;
  });
}

/** Post the JE for an invoice transitioning draft → sent. */
function postInvoiceSent(invoice, opts = {}) {
  const userId = opts.userId || null;
  if (!isAccountingReady()) {
    console.warn(`[accounting] skipping invoice send post — chart of accounts not seeded`);
    return null;
  }
  const ar = lookupAccount(CODES.ACCOUNTS_RECEIVABLE);
  const rev = lookupAccount(CODES.SERVICE_REVENUE);
  const tax = lookupAccount(CODES.SALES_TAX_PAYABLE);
  if (!ar || !rev || !tax) {
    console.warn('[accounting] missing required accounts (AR/Revenue/Tax) — invoice send NOT posted');
    return null;
  }
  // Skip duplicate posting if a JE already exists for this invoice send
  const existing = db.get(
    `SELECT id FROM journal_entries WHERE source_type='invoice' AND source_id=?`,
    [invoice.id]
  );
  if (existing) return existing.id;

  const total = Number(invoice.total) || 0;
  const subtotal = Number(invoice.subtotal) || 0;
  const taxAmt = Number(invoice.tax_amount) || 0;
  const description = `Invoice ${invoice.display_number || invoice.invoice_number || invoice.id}`;

  const lines = [
    { accountId: ar.id, debit: total, credit: 0, description: `${description} — to AR` },
    { accountId: rev.id, debit: 0, credit: subtotal, description: `${description} — revenue` },
  ];
  if (taxAmt > 0) {
    lines.push({ accountId: tax.id, debit: 0, credit: taxAmt, description: `${description} — sales tax` });
  } else {
    // If no tax, the AR/Revenue lines must balance — adjust subtotal == total
    // (already true when tax = 0). Continue.
  }

  return postJournalEntry({
    entryDate: todayDate(),
    description,
    sourceType: 'invoice',
    sourceId: invoice.id,
    userId,
    lines,
  });
}

/** Post the JE for a payment received against an invoice. */
function postPaymentReceived(invoice, amount, opts = {}) {
  const userId = opts.userId || null;
  amount = Number(amount) || 0;
  if (amount <= 0) return null;
  if (!isAccountingReady()) {
    console.warn(`[accounting] skipping payment post — chart of accounts not seeded`);
    return null;
  }
  const cash = lookupAccount(CODES.CASH);
  const ar = lookupAccount(CODES.ACCOUNTS_RECEIVABLE);
  if (!cash || !ar) {
    console.warn('[accounting] missing required accounts (Cash/AR) — payment NOT posted');
    return null;
  }

  const description = `Payment on invoice ${invoice.display_number || invoice.invoice_number || invoice.id}`;
  return postJournalEntry({
    entryDate: todayDate(),
    description,
    sourceType: 'payment',
    sourceId: invoice.id,
    userId,
    lines: [
      { accountId: cash.id, debit: amount, credit: 0, description: `${description} — cash in` },
      { accountId: ar.id, debit: 0, credit: amount, description: `${description} — AR clear` },
    ],
  });
}

/** Post a reversing JE when an invoice is voided. */
function postInvoiceVoid(invoice, opts = {}) {
  const userId = opts.userId || null;
  if (!isAccountingReady()) return null;
  const original = db.get(
    `SELECT id FROM journal_entries WHERE source_type='invoice' AND source_id=? AND reversed_by_entry_id IS NULL`,
    [invoice.id]
  );
  if (!original) return null;

  const ar = lookupAccount(CODES.ACCOUNTS_RECEIVABLE);
  const rev = lookupAccount(CODES.SERVICE_REVENUE);
  const tax = lookupAccount(CODES.SALES_TAX_PAYABLE);
  if (!ar || !rev || !tax) return null;

  const total = Number(invoice.total) || 0;
  const subtotal = Number(invoice.subtotal) || 0;
  const taxAmt = Number(invoice.tax_amount) || 0;
  const description = `Void of invoice ${invoice.display_number || invoice.invoice_number || invoice.id}`;

  const lines = [
    { accountId: ar.id, debit: 0, credit: total, description: `${description} — reverse AR` },
    { accountId: rev.id, debit: subtotal, credit: 0, description: `${description} — reverse revenue` },
  ];
  if (taxAmt > 0) {
    lines.push({ accountId: tax.id, debit: taxAmt, credit: 0, description: `${description} — reverse tax` });
  }

  const reversingId = postJournalEntry({
    entryDate: todayDate(),
    description,
    sourceType: 'invoice_void',
    sourceId: invoice.id,
    userId,
    lines,
  });
  // Link the original to the reversing entry
  db.run('UPDATE journal_entries SET reversed_by_entry_id = ? WHERE id = ?', [reversingId, original.id]);
  return reversingId;
}

/** Post the JE for a vendor bill being approved (draft -> approved). */
function postBillApproved(bill, lines, opts = {}) {
  const userId = opts.userId || null;
  if (!isAccountingReady()) {
    console.warn('[accounting] skipping bill post — chart of accounts not seeded');
    return null;
  }
  const ap = lookupAccount(CODES.ACCOUNTS_PAYABLE);
  if (!ap) {
    console.warn('[accounting] missing AP account — bill NOT posted');
    return null;
  }
  // Skip duplicate posting
  const existing = db.get(
    `SELECT id FROM journal_entries WHERE source_type='bill' AND source_id=?`,
    [bill.id]
  );
  if (existing) return existing.id;

  const total = Number(bill.total) || 0;
  const taxAmount = Number(bill.tax_amount) || 0;
  const description = `Bill ${bill.bill_number || '#' + bill.id} from vendor`;

  // Each bill line goes to its own expense account (or Misc if not set)
  const fallback = lookupAccount(CODES.MISC_EXPENSE);
  const jeLines = [];
  lines.forEach(li => {
    const amt = Number(li.line_total) || 0;
    if (amt <= 0) return;
    const acct = li.account_id ? db.get('SELECT id FROM accounts WHERE id = ?', [li.account_id]) : null;
    const targetAcct = acct || fallback;
    if (!targetAcct) return;
    jeLines.push({
      accountId: targetAcct.id,
      debit: amt,
      credit: 0,
      description: `${description} — ${li.description || 'expense'}`,
    });
  });
  if (jeLines.length === 0) return null;

  // Tax paid to vendor: separate debit line to a dedicated expense account.
  // Keeps the JE balanced AND keeps tax-paid auditable in the books.
  if (taxAmount > 0) {
    const taxAcct = lookupAccount(CODES.SALES_TAX_BILLS);
    if (!taxAcct) {
      console.warn('[accounting] missing 5950 Sales Tax account — bill will fail to post until init-accounting is re-run');
      return null;
    }
    jeLines.push({
      accountId: taxAcct.id,
      debit: taxAmount,
      credit: 0,
      description: `${description} — sales tax`,
    });
  }

  jeLines.push({ accountId: ap.id, debit: 0, credit: total, description: `${description} — to AP` });

  return postJournalEntry({
    entryDate: bill.bill_date || todayDate(),
    description,
    sourceType: 'bill',
    sourceId: bill.id,
    userId,
    lines: jeLines,
  });
}

/** Post the JE for a vendor bill being paid. */
function postBillPaid(bill, amount, opts = {}) {
  const userId = opts.userId || null;
  amount = Number(amount) || 0;
  if (amount <= 0) return null;
  if (!isAccountingReady()) return null;
  const ap = lookupAccount(CODES.ACCOUNTS_PAYABLE);
  const cash = lookupAccount(CODES.CASH);
  if (!ap || !cash) {
    console.warn('[accounting] missing AP/Cash — bill payment NOT posted');
    return null;
  }
  const description = `Payment on bill ${bill.bill_number || '#' + bill.id}`;
  return postJournalEntry({
    entryDate: todayDate(),
    description,
    sourceType: 'bill_payment',
    sourceId: bill.id,
    userId,
    lines: [
      { accountId: ap.id, debit: amount, credit: 0, description: `${description} — clear AP` },
      { accountId: cash.id, debit: 0, credit: amount, description: `${description} — cash out` },
    ],
  });
}

module.exports = {
  CODES,
  isAccountingReady,
  postJournalEntry,
  postInvoiceSent,
  postPaymentReceived,
  postInvoiceVoid,
  postBillApproved,
  postBillPaid,
};
