/**
 * Contractor / Vendor intake
 *
 * Public token-based intake form plus internal manager/admin review directory.
 */

const crypto = require('crypto');
const express = require('express');
const supabase = require('../db/supabase');
const { requireManager, setFlash } = require('../middleware/auth');
const { sanitizePostgrestSearch } = require('../services/sanitize');
const { emptyToNullFormattedPhone } = require('../services/phone');

const router = express.Router();
const PAGE_SIZE = 25;

const TRADE_OPTIONS = [
  'general', 'demolition', 'rough carpentry', 'finish carpentry', 'drywall',
  'paint', 'flooring', 'plumbing', 'electrical', 'HVAC', 'roofing', 'masonry',
  'concrete', 'site work', 'landscaping', 'windows & doors', 'cabinets',
  'countertops', 'appliances', 'cleaning', 'dumpsters', 'materials supplier',
  'other'
];
const COMPANY_TYPES = ['contractor', 'vendor', 'both', 'other'];
const STATUSES = ['draft', 'submitted', 'reviewing', 'approved', 'archived'];
const UNION_STATUSES = ['unknown', 'non_union', 'union', 'mixed'];
const SECTIONS = ['company', 'experience', 'compliance', 'references', 'review'];

function emptyToNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function toInt(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function toMoney(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(String(value).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function toBool(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function token() {
  return crypto.randomBytes(24).toString('hex');
}

function nextUpdateDate() {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

function checkedList(value) {
  if (Array.isArray(value)) return value.map(String).map(v => v.trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function referencesFromBody(body) {
  const refs = [];
  for (let i = 0; i < 3; i += 1) {
    const name = emptyToNull(body[`ref_${i}_name`]);
    const company = emptyToNull(body[`ref_${i}_company`]);
    const phone = emptyToNullFormattedPhone(body[`ref_${i}_phone`]);
    const email = emptyToNull(body[`ref_${i}_email`]);
    const relationship = emptyToNull(body[`ref_${i}_relationship`]);
    const notes = emptyToNull(body[`ref_${i}_notes`]);
    if (name || company || phone || email || relationship || notes) refs.push({ name, company, phone, email, relationship, notes });
  }
  return refs;
}

function currentSection(section) {
  return SECTIONS.includes(section) ? section : 'company';
}

function nextSection(section) {
  const idx = SECTIONS.indexOf(section);
  return SECTIONS[Math.min(SECTIONS.length - 1, idx + 1)];
}

function publicLink(req, intake) {
  return `${req.protocol}://${req.get('host')}/vendor-intake/${intake.access_token}`;
}

async function findByToken(accessToken) {
  const { data, error } = await supabase
    .from('contractor_vendor_intakes')
    .select('*')
    .eq('access_token', accessToken)
    .maybeSingle();
  if (error) throw error;
  return data;
}

function updateForSection(section, body) {
  if (section === 'company') {
    const companyType = COMPANY_TYPES.includes(body.company_type) ? body.company_type : 'contractor';
    const trades = checkedList(body.trades).filter(t => TRADE_OPTIONS.includes(t));
    const otherTradeName = emptyToNull(body.other_trade_name);
    const otherTradeDesc = emptyToNull(body.other_trade_description);
    return {
      company_name: emptyToNull(body.company_name) || '',
      dba_name: emptyToNull(body.dba_name),
      company_type: companyType,
      trades,
      other_trade_name: trades.includes('other') ? otherTradeName : null,
      other_trade_description: trades.includes('other') ? otherTradeDesc : null,
      service_area: emptyToNull(body.service_area),
      address: emptyToNull(body.address),
      city: emptyToNull(body.city),
      state: emptyToNull(body.state),
      zip: emptyToNull(body.zip),
      office_phone: emptyToNullFormattedPhone(body.office_phone),
      mobile_phone: emptyToNullFormattedPhone(body.mobile_phone),
      email: emptyToNull(body.email),
      website: emptyToNull(body.website),
      primary_contact_name: emptyToNull(body.primary_contact_name),
      primary_contact_title: emptyToNull(body.primary_contact_title),
      primary_contact_phone: emptyToNullFormattedPhone(body.primary_contact_phone),
      primary_contact_email: emptyToNull(body.primary_contact_email),
      billing_contact_name: emptyToNull(body.billing_contact_name),
      billing_contact_phone: emptyToNullFormattedPhone(body.billing_contact_phone),
      billing_contact_email: emptyToNull(body.billing_contact_email),
    };
  }
  if (section === 'experience') {
    return {
      years_in_business: toInt(body.years_in_business),
      employee_count: toInt(body.employee_count),
      field_staff_count: toInt(body.field_staff_count),
      annual_capacity: emptyToNull(body.annual_capacity),
      largest_project_name: emptyToNull(body.largest_project_name),
      largest_project_location: emptyToNull(body.largest_project_location),
      largest_project_value: toMoney(body.largest_project_value),
      largest_project_date: emptyToNull(body.largest_project_date),
      largest_project_description: emptyToNull(body.largest_project_description),
      occupied_multifamily: toBool(body.occupied_multifamily),
      occupied_multifamily_notes: emptyToNull(body.occupied_multifamily_notes),
    };
  }
  if (section === 'compliance') {
    const unionStatus = UNION_STATUSES.includes(body.union_status) ? body.union_status : 'unknown';
    return {
      insurance_gl: toBool(body.insurance_gl),
      insurance_workers_comp: toBool(body.insurance_workers_comp),
      insurance_auto: toBool(body.insurance_auto),
      insurance_expiration_date: emptyToNull(body.insurance_expiration_date),
      bondable: toBool(body.bondable),
      license_numbers: emptyToNull(body.license_numbers),
      union_status: unionStatus,
      prevailing_wage_experience: toBool(body.prevailing_wage_experience),
      hud_mshda_experience: toBool(body.hud_mshda_experience),
      hud_mshda_notes: emptyToNull(body.hud_mshda_notes),
      section3_business: toBool(body.section3_business),
      section3_notes: emptyToNull(body.section3_notes),
      certifications: emptyToNull(body.certifications),
      safety_notes: emptyToNull(body.safety_notes),
      documents_notes: emptyToNull(body.documents_notes),
    };
  }
  if (section === 'references') {
    return { references_json: referencesFromBody(body) };
  }
  return {};
}

function firstContractorTrade(intake) {
  const trade = (intake.trades || [])[0] || 'general';
  const legacy = ['drywall', 'plumbing', 'electrical', 'HVAC', 'general', 'other'];
  return legacy.includes(trade) ? trade : 'other';
}

function renderPublic(res, view, params) {
  res.render(`vendor-intake/${view}`, {
    title: 'Contractor / Vendor Intake',
    tradeOptions: TRADE_OPTIONS,
    companyTypes: COMPANY_TYPES,
    unionStatuses: UNION_STATUSES,
    sections: SECTIONS,
    ...params,
  });
}

router.get('/', (req, res) => res.redirect('/vendor-intake/start'));

router.get('/start', (req, res) => {
  renderPublic(res, 'start', { intake: {}, errors: {} });
});

router.post('/start', async (req, res) => {
  const companyName = emptyToNull(req.body.company_name);
  const email = emptyToNull(req.body.email);
  const errors = {};
  if (!companyName) errors.company_name = 'Company name is required.';
  if (!email) errors.email = 'Email is required.';
  if (Object.keys(errors).length) {
    return res.status(400).render('vendor-intake/start', {
      title: 'Contractor / Vendor Intake',
      intake: req.body,
      errors,
    });
  }

  const insert = {
    access_token: token(),
    company_name: companyName,
    email,
    office_phone: emptyToNullFormattedPhone(req.body.office_phone),
    primary_contact_name: emptyToNull(req.body.primary_contact_name),
    primary_contact_email: email,
    next_update_due_at: nextUpdateDate(),
  };
  const { data: intake, error } = await supabase
    .from('contractor_vendor_intakes')
    .insert(insert)
    .select()
    .single();
  if (error) throw error;
  res.redirect(`/vendor-intake/${intake.access_token}/company`);
});

router.get('/directory', requireManager, async (req, res) => {
  const q = sanitizePostgrestSearch((req.query.q || '').trim());
  const trade = (req.query.trade || '').trim();
  const status = STATUSES.includes(req.query.status) ? req.query.status : '';
  const state = (req.query.state || '').trim().toUpperCase();
  const rating = toInt(req.query.rating);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  let query = supabase
    .from('contractor_vendor_intakes')
    .select('id, company_name, company_type, trades, city, state, email, office_phone, primary_contact_name, insurance_gl, insurance_workers_comp, rating, status, submitted_at, updated_at', { count: 'exact', head: false });

  if (q) {
    const like = `%${q}%`;
    query = query.or(`company_name.ilike.${like},dba_name.ilike.${like},email.ilike.${like},primary_contact_name.ilike.${like},city.ilike.${like},state.ilike.${like}`);
  }
  if (trade && TRADE_OPTIONS.includes(trade)) query = query.contains('trades', [trade]);
  if (status) query = query.eq('status', status);
  if (state) query = query.eq('state', state);
  if (rating) query = query.gte('rating', rating);

  const { data: intakes, count, error } = await query
    .order('submitted_at', { ascending: false, nullsFirst: false })
    .order('updated_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);
  if (error) throw error;

  const { data: summaryRows, error: summaryError } = await supabase
    .from('contractor_vendor_intakes')
    .select('status, rating');
  if (summaryError) throw summaryError;
  const allRows = summaryRows || [];
  const total = allRows.length;
  const submitted = allRows.filter(r => ['submitted', 'reviewing'].includes(r.status)).length;
  const approved = allRows.filter(r => r.status === 'approved').length;
  const rated = allRows.filter(r => r.rating);
  const avgRating = rated.length ? (rated.reduce((sum, r) => sum + Number(r.rating), 0) / rated.length).toFixed(1) : '-';

  res.render('vendor-intake/index', {
    title: 'Trade intake',
    activeNav: 'intake',
    intakes: intakes || [],
    tradeOptions: TRADE_OPTIONS,
    statuses: STATUSES,
    q,
    trade,
    status,
    state,
    rating: rating || '',
    page,
    totalPages: Math.max(1, Math.ceil((count || 0) / PAGE_SIZE)),
    count: count || 0,
    summary: { total, submitted, approved, avgRating },
  });
});

router.get('/directory/:id', requireManager, async (req, res) => {
  const id = req.params.id;
  const [{ data: intake, error }, { data: notes, error: notesError }] = await Promise.all([
    supabase.from('contractor_vendor_intakes').select('*').eq('id', id).maybeSingle(),
    supabase.from('contractor_vendor_intake_notes').select('*, users(name, email)').eq('intake_id', id).order('created_at', { ascending: false }),
  ]);
  if (error) throw error;
  if (notesError) throw notesError;
  if (!intake) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Intake not found.' });

  res.render('vendor-intake/show', {
    title: intake.company_name || 'Trade intake',
    activeNav: 'intake',
    intake,
    notes: notes || [],
    statuses: STATUSES,
    publicUrl: publicLink(req, intake),
  });
});

router.post('/directory/:id/review', requireManager, async (req, res) => {
  const id = req.params.id;
  const status = STATUSES.includes(req.body.status) ? req.body.status : 'reviewing';
  const rating = toInt(req.body.rating);
  const update = {
    status,
    rating: rating && rating >= 1 && rating <= 5 ? rating : null,
    internal_notes: emptyToNull(req.body.internal_notes),
    reviewed_by_user_id: req.session.userId,
    reviewed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('contractor_vendor_intakes').update(update).eq('id', id);
  if (error) throw error;
  setFlash(req, 'success', 'Intake review updated.');
  res.redirect(`/vendor-intake/directory/${id}`);
});

router.post('/directory/:id/notes', requireManager, async (req, res) => {
  const id = req.params.id;
  const body = emptyToNull(req.body.body);
  const noteType = ['note', 'call', 'email', 'review'].includes(req.body.note_type) ? req.body.note_type : 'note';
  if (!body) {
    setFlash(req, 'error', 'Note text is required.');
    return res.redirect(`/vendor-intake/directory/${id}`);
  }
  const { error } = await supabase.from('contractor_vendor_intake_notes').insert({
    intake_id: id,
    user_id: req.session.userId,
    note_type: noteType,
    body,
  });
  if (error) throw error;
  setFlash(req, 'success', 'Note added.');
  res.redirect(`/vendor-intake/directory/${id}`);
});

router.post('/directory/:id/promote', requireManager, async (req, res) => {
  const id = req.params.id;
  const target = ['vendor', 'contractor', 'both'].includes(req.body.target) ? req.body.target : 'contractor';
  const { data: intake, error } = await supabase.from('contractor_vendor_intakes').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!intake) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Intake not found.' });
  const updates = { updated_at: new Date().toISOString(), status: intake.status === 'draft' ? 'reviewing' : intake.status };
  const notes = [
    `Created from trade intake #${intake.id}.`,
    intake.occupied_multifamily ? 'Occupied multifamily experience: yes.' : null,
    intake.prevailing_wage_experience ? 'Prevailing wage experience: yes.' : null,
    intake.hud_mshda_experience ? 'HUD/MSHDA experience: yes.' : null,
    intake.section3_business ? 'Section 3: yes.' : null,
    intake.internal_notes,
  ].filter(Boolean).join('\n');

  if ((target === 'vendor' || target === 'both') && !intake.promoted_vendor_id) {
    const { data: vendor, error: vendorError } = await supabase.from('vendors').insert({
      name: intake.company_name,
      email: intake.email || intake.primary_contact_email,
      phone: intake.office_phone || intake.primary_contact_phone,
      address: intake.address,
      city: intake.city,
      state: intake.state,
      zip: intake.zip,
      notes,
    }).select('id').single();
    if (vendorError) throw vendorError;
    updates.promoted_vendor_id = vendor.id;
    try {
      const filesSvc = require('../services/files');
      await filesSvc.ensureRootFolder('vendor', vendor.id, req.session.userId);
    } catch (e) { /* best effort */ }
  }

  if ((target === 'contractor' || target === 'both') && !intake.promoted_contractor_id) {
    const { data: contractor, error: contractorError } = await supabase.from('contractors').insert({
      name: intake.company_name,
      email: intake.email || intake.primary_contact_email,
      phone: intake.office_phone || intake.primary_contact_phone,
      address: intake.address,
      city: intake.city,
      state: intake.state,
      zip: intake.zip,
      trade: firstContractorTrade(intake),
      license_number: intake.license_numbers,
      insurance_expiry_date: intake.insurance_expiration_date,
      notes,
    }).select('id').single();
    if (contractorError) throw contractorError;
    updates.promoted_contractor_id = contractor.id;
    try {
      const filesSvc = require('../services/files');
      await filesSvc.ensureRootFolder('contractor', contractor.id, req.session.userId);
    } catch (e) { /* best effort */ }
  }

  const { error: updateError } = await supabase.from('contractor_vendor_intakes').update(updates).eq('id', id);
  if (updateError) throw updateError;
  setFlash(req, 'success', 'Intake promoted into the Forge directory.');
  res.redirect(`/vendor-intake/directory/${id}`);
});

router.post('/directory/:id/delete', requireManager, async (req, res) => {
  const id = req.params.id;
  await Promise.all([
    supabase.from('contractor_vendor_intakes').delete().eq('id', id),
    supabase.from('contractor_vendor_intake_notes').delete().eq('intake_id', id),
  ]);
  setFlash(req, 'success', 'Intake deleted.');
  res.redirect('/vendor-intake/directory');
});

router.get('/:token', async (req, res) => {
  const intake = await findByToken(req.params.token);
  if (!intake) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Intake link not found.' });
  res.redirect(`/vendor-intake/${intake.access_token}/company`);
});

router.get('/:token/:section', async (req, res) => {
  const intake = await findByToken(req.params.token);
  if (!intake) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Intake link not found.' });
  const section = currentSection(req.params.section);
  renderPublic(res, 'form', { intake, section, publicUrl: publicLink(req, intake), errors: {} });
});

router.post('/:token/:section', async (req, res) => {
  const intake = await findByToken(req.params.token);
  if (!intake) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Intake link not found.' });
  const section = currentSection(req.params.section);
  const update = { ...updateForSection(section, req.body), updated_at: new Date().toISOString() };
  if (section === 'review' && req.body.intent === 'submit') {
    update.status = 'submitted';
    update.submitted_at = intake.submitted_at || new Date().toISOString();
    update.next_update_due_at = nextUpdateDate();
  }
  const { data: updated, error } = await supabase
    .from('contractor_vendor_intakes')
    .update(update)
    .eq('id', intake.id)
    .select()
    .single();
  if (error) throw error;
  if (req.body.intent === 'save_exit') {
    return renderPublic(res, 'saved', { intake: updated, publicUrl: publicLink(req, updated) });
  }
  if (section === 'review' && req.body.intent === 'submit') {
    return renderPublic(res, 'submitted', { intake: updated, publicUrl: publicLink(req, updated) });
  }
  res.redirect(`/vendor-intake/${updated.access_token}/${nextSection(section)}`);
});

module.exports = router;
