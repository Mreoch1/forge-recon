/**
 * Accounting posting service — converted to Supabase SDK.
 *
 * Creates double-entry journal entries from operational events.
 * See accounting-posting.js header doc for JE schemas.
 */
const supabase = require('../db/supabase');
const { writeAudit } = require('./audit');

const CODES = {
  CASH:               '1000',
  ACCOUNTS_RECEIVABLE:'1100',
  ACCOUNTS_PAYABLE:   '2000',
  SALES_TAX_PAYABLE:  '2100',
  SERVICE_REVENUE:    '4000',
  MISC_EXPENSE:       '5900',
  SALES_TAX_BILLS:    '5950',
};

async function lookupAccount(code) {
  const { data } = await supabase.from('accounts').select('id, code, name').eq('code', code).eq('active', true).maybeSingle();
  return data || null;
}

async function isAccountingReady() {
  try {
    const { count } = await supabase.from('accounts').select('*', { count: 'exact', head: true });
    return (count || 0) > 0;
  } catch (e) { return false; }
}

function todayDate() { return new Date().toISOString().slice(0, 10); }

async function postJournalEntry({ entryDate, description, sourceType, sourceId, userId, lines }) {
  if (!Array.isArray(lines) || lines.length < 2) throw new Error('Journal entry needs at least 2 lines.');
  let totalDr = 0, totalCr = 0;
  lines.forEach(l => { totalDr += Number(l.debit) || 0; totalCr += Number(l.credit) || 0; });
  if (Math.abs(totalDr - totalCr) > 0.005)
    throw new Error(`JE imbalance: debits ${totalDr.toFixed(2)} != credits ${totalCr.toFixed(2)}`);

  const { data: je, error: jeErr } = await supabase.from('journal_entries').insert({
    entry_date: entryDate || todayDate(),
    description: description || '',
    source_type: sourceType || null,
    source_id: sourceId || null,
    created_by_user_id: userId || null,
  }).select('id').single();
  if (jeErr) throw jeErr;
  const jeId = je.id;

  for (const l of lines) {
    const { error: liErr } = await supabase.from('journal_lines').insert({
      journal_entry_id: jeId,
      account_id: l.accountId,
      debit: Number(l.debit) || 0,
      credit: Number(l.credit) || 0,
      description: l.description || '',
    });
    if (liErr) throw liErr;
  }

  writeAudit({
    entityType: 'journal_entry', entityId: jeId, action: 'post',
    before: null,
    after: { description, sourceType, sourceId, totalDr, totalCr, lines: lines.length },
    source: 'system', userId,
  });
  return jeId;
}

async function postInvoiceSent(invoice, opts = {}) {
  const userId = opts.userId || null;
  if (!await isAccountingReady()) { console.warn('[accounting] skipping invoice send — chart not seeded'); return null; }
  const [ar, rev, tax] = await Promise.all([
    lookupAccount(CODES.ACCOUNTS_RECEIVABLE),
    lookupAccount(CODES.SERVICE_REVENUE),
    lookupAccount(CODES.SALES_TAX_PAYABLE),
  ]);
  if (!ar || !rev || !tax) { console.warn('[accounting] missing AR/Revenue/Tax — invoice NOT posted'); return null; }
  const { data: existing } = await supabase.from('journal_entries').select('id').eq('source_type', 'invoice').eq('source_id', String(invoice.id)).maybeSingle();
  if (existing) return existing.id;

  const total = Number(invoice.total) || 0;
  const subtotal = Number(invoice.subtotal) || 0;
  const taxAmt = Number(invoice.tax_amount) || 0;
  const desc = `Invoice ${invoice.display_number || invoice.invoice_number || invoice.id}`;
  const lines = [{ accountId: ar.id, debit: total, credit: 0, description: `${desc} — to AR` },
                 { accountId: rev.id, debit: 0, credit: subtotal, description: `${desc} — revenue` }];
  if (taxAmt > 0) lines.push({ accountId: tax.id, debit: 0, credit: taxAmt, description: `${desc} — sales tax` });
  return postJournalEntry({ entryDate: todayDate(), description: desc, sourceType: 'invoice', sourceId: invoice.id, userId, lines });
}

async function postPaymentReceived(invoice, amount, opts = {}) {
  const userId = opts.userId || null;
  amount = Number(amount) || 0;
  if (amount <= 0) return null;
  if (!await isAccountingReady()) { console.warn('[accounting] skipping payment — chart not seeded'); return null; }
  const [cash, ar] = await Promise.all([lookupAccount(CODES.CASH), lookupAccount(CODES.ACCOUNTS_RECEIVABLE)]);
  if (!cash || !ar) { console.warn('[accounting] missing Cash/AR — payment NOT posted'); return null; }
  const desc = `Payment on invoice ${invoice.display_number || invoice.invoice_number || invoice.id}`;
  return postJournalEntry({
    entryDate: todayDate(), description: desc, sourceType: 'payment', sourceId: invoice.id, userId,
    lines: [{ accountId: cash.id, debit: amount, credit: 0, description: `${desc} — cash in` },
            { accountId: ar.id, debit: 0, credit: amount, description: `${desc} — AR clear` }],
  });
}

async function postInvoiceVoid(invoice, opts = {}) {
  const userId = opts.userId || null;
  if (!await isAccountingReady()) return null;
  const { data: original } = await supabase.from('journal_entries').select('id').eq('source_type', 'invoice').eq('source_id', String(invoice.id)).is('reversed_by_entry_id', null).maybeSingle();
  if (!original) return null;
  const [ar, rev, tax] = await Promise.all([
    lookupAccount(CODES.ACCOUNTS_RECEIVABLE), lookupAccount(CODES.SERVICE_REVENUE), lookupAccount(CODES.SALES_TAX_PAYABLE),
  ]);
  if (!ar || !rev || !tax) return null;
  const total = Number(invoice.total) || 0; const subtotal = Number(invoice.subtotal) || 0; const taxAmt = Number(invoice.tax_amount) || 0;
  const desc = `Void of invoice ${invoice.display_number || invoice.invoice_number || invoice.id}`;
  const lines = [{ accountId: ar.id, debit: 0, credit: total, description: `${desc} — reverse AR` },
                 { accountId: rev.id, debit: subtotal, credit: 0, description: `${desc} — reverse revenue` }];
  if (taxAmt > 0) lines.push({ accountId: tax.id, debit: taxAmt, credit: 0, description: `${desc} — reverse tax` });
  const reversingId = await postJournalEntry({ entryDate: todayDate(), description: desc, sourceType: 'invoice_void', sourceId: invoice.id, userId, lines });
  await supabase.from('journal_entries').update({ reversed_by_entry_id: reversingId }).eq('id', original.id);
  return reversingId;
}

async function postBillApproved(bill, lines, opts = {}) {
  const userId = opts.userId || null;
  if (!await isAccountingReady()) { console.warn('[accounting] skipping bill post — chart not seeded'); return null; }
  const ap = await lookupAccount(CODES.ACCOUNTS_PAYABLE);
  if (!ap) { console.warn('[accounting] missing AP — bill NOT posted'); return null; }
  const { data: existing } = await supabase.from('journal_entries').select('id').eq('source_type', 'bill').eq('source_id', String(bill.id)).maybeSingle();
  if (existing) return existing.id;
  const total = Number(bill.total) || 0; const taxAmount = Number(bill.tax_amount) || 0;
  const desc = `Bill ${bill.bill_number || '#' + bill.id} from vendor`;
  const fallback = await lookupAccount(CODES.MISC_EXPENSE);
  const jeLines = [];
  for (const li of lines) {
    const amt = Number(li.line_total) || 0; if (amt <= 0) continue;
    const { data: acct } = li.account_id ? await supabase.from('accounts').select('id').eq('id', li.account_id).maybeSingle() : { data: null };
    const targetAcct = acct || fallback; if (!targetAcct) continue;
    jeLines.push({ accountId: targetAcct.id, debit: amt, credit: 0, description: `${desc} — ${li.description || 'expense'}` });
  }
  if (jeLines.length === 0) return null;
  if (taxAmount > 0) {
    const taxAcct = await lookupAccount(CODES.SALES_TAX_BILLS);
    if (!taxAcct) { console.warn('[accounting] missing 5950 — bill NOT posted'); return null; }
    jeLines.push({ accountId: taxAcct.id, debit: taxAmount, credit: 0, description: `${desc} — sales tax` });
  }
  jeLines.push({ accountId: ap.id, debit: 0, credit: total, description: `${desc} — to AP` });
  return postJournalEntry({ entryDate: bill.bill_date || todayDate(), description: desc, sourceType: 'bill', sourceId: bill.id, userId, lines: jeLines });
}

/**
 * Reverse the JE created when a bill was approved (void bill).
 * Swaps debits and credits: debit AP, credit expense accounts.
 */
async function postBillVoid(bill, lines, opts = {}) {
  const userId = opts.userId || null;
  if (!await isAccountingReady()) return null;
  const ap = await lookupAccount(CODES.ACCOUNTS_PAYABLE);
  if (!ap) return null;
  // Find existing JE
  const { data: existing } = await supabase.from('journal_entries').select('id').eq('source_type', 'bill').eq('source_id', String(bill.id)).maybeSingle();
  if (!existing) return null; // nothing to reverse
  const total = Number(bill.total) || 0; const taxAmount = Number(bill.tax_amount) || 0;
  const desc = `Void bill ${bill.bill_number || '#' + bill.id}`;
  const fallback = await lookupAccount(CODES.MISC_EXPENSE);
  const jeLines = [];
  for (const li of lines) {
    const amt = Number(li.line_total) || 0; if (amt <= 0) continue;
    const { data: acct } = li.account_id ? await supabase.from('accounts').select('id').eq('id', li.account_id).maybeSingle() : { data: null };
    const targetAcct = acct || fallback; if (!targetAcct) continue;
    jeLines.push({ accountId: targetAcct.id, debit: 0, credit: amt, description: `${desc} — ${li.description || 'expense'}` });
  }
  if (jeLines.length === 0) return null;
  if (taxAmount > 0) {
    const taxAcct = await lookupAccount(CODES.SALES_TAX_BILLS);
    if (!taxAcct) return null;
    jeLines.push({ accountId: taxAcct.id, debit: 0, credit: taxAmount, description: `${desc} — sales tax reversal` });
  }
  jeLines.push({ accountId: ap.id, debit: total, credit: 0, description: `${desc} — AP reversal` });
  return postJournalEntry({ entryDate: todayDate(), description: desc, sourceType: 'bill_void', sourceId: bill.id, userId, lines: jeLines });
}

async function postBillPaid(bill, amount, opts = {}) {
  const userId = opts.userId || null; amount = Number(amount) || 0;
  if (amount <= 0) return null;
  if (!await isAccountingReady()) return null;
  const [ap, cash] = await Promise.all([lookupAccount(CODES.ACCOUNTS_PAYABLE), lookupAccount(CODES.CASH)]);
  if (!ap || !cash) { console.warn('[accounting] missing AP/Cash — bill payment NOT posted'); return null; }
  const desc = `Payment on bill ${bill.bill_number || '#' + bill.id}`;
  return postJournalEntry({
    entryDate: todayDate(), description: desc, sourceType: 'bill_payment', sourceId: bill.id, userId,
    lines: [{ accountId: ap.id, debit: amount, credit: 0, description: `${desc} — clear AP` },
            { accountId: cash.id, debit: 0, credit: amount, description: `${desc} — cash out` }],
  });
}

module.exports = {
  CODES, isAccountingReady, postJournalEntry,
  postInvoiceSent, postPaymentReceived, postInvoiceVoid, postBillApproved, postBillPaid, postBillVoid,
};
