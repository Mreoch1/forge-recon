const express = require('express');
const supabase = require('../db/supabase');
const { setFlash } = require('../middleware/auth');
const { sanitizePostgrestSearch } = require('../services/sanitize');
const { emptyToNullFormattedPhone } = require('../services/phone');

const router = express.Router();
const PAGE_SIZE = 50;
const VALID_COMPANY_ROLES = ['vendor', 'contractor', 'both'];
const VALID_TRADES = ['drywall', 'plumbing', 'electrical', 'HVAC', 'general', 'other'];

function emptyToNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function validateCompany(body = {}) {
  const errors = {};
  const name = emptyToNull(body.name);
  const company_role = VALID_COMPANY_ROLES.includes(body.company_role) ? body.company_role : 'vendor';
  const trade = emptyToNull(body.trade);

  if (!name) errors.name = 'Company name is required.';
  if (name && name.length > 200) errors.name = 'Company name is too long (maximum 200 characters).';
  if (trade && !VALID_TRADES.includes(trade)) errors.trade = 'Select a valid trade.';

  return {
    errors,
    data: {
      company_role,
      name,
      email: emptyToNull(body.email),
      phone: emptyToNullFormattedPhone(body.phone),
      address: emptyToNull(body.address),
      city: emptyToNull(body.city),
      state: emptyToNull(body.state),
      zip: emptyToNull(body.zip),
      trade,
    },
  };
}

async function findCompanyProfiles(name) {
  const [vendorResult, contractorResult] = await Promise.all([
    supabase.from('vendors').select('id, name, archived').ilike('name', name).order('id', { ascending: true }).limit(1).maybeSingle(),
    supabase.from('contractors').select('id, name, active').ilike('name', name).order('id', { ascending: true }).limit(1).maybeSingle(),
  ]);
  if (vendorResult.error) throw vendorResult.error;
  if (contractorResult.error) throw contractorResult.error;
  return { vendor: vendorResult.data || null, contractor: contractorResult.data || null };
}

async function ensureCompanyFolders(created, userId) {
  if (!created.length) return;
  try {
    const filesSvc = require('../services/files');
    await Promise.all(created.map(({ role, id }) => (
      filesSvc.ensureRootFolder(role, id, userId)
        .catch(error => console.warn(`[files] ensureRootFolder(${role}):`, error.message))
    )));
  } catch (error) {
    console.warn('[companies] file workspace unavailable:', error.message);
  }
}

function normalizeName(name) {
  return String(name || '').trim();
}

function searchCompany(company, q) {
  if (!q) return true;
  const haystack = [
    company.name,
    company.email,
    company.phone,
    company.city,
    company.state,
    company.trade,
    company.roles.join(' '),
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(q.toLowerCase());
}

function mergeCompanies(vendors = [], contractors = []) {
  const byName = new Map();

  function getCompany(name) {
    const normalizedName = normalizeName(name);
    if (!normalizedName) return null;
    const key = normalizedName.toLowerCase();
    if (!byName.has(key)) {
      byName.set(key, {
        name: normalizedName,
        roles: [],
        vendor_id: null,
        contractor_id: null,
        email: null,
        phone: null,
        city: null,
        state: null,
        trade: null,
      });
    }
    return byName.get(key);
  }

  (vendors || []).forEach((vendor) => {
    const company = getCompany(vendor.name);
    if (!company) return;
    company.vendor_id = vendor.id;
    if (!company.roles.includes('Vendor')) company.roles.push('Vendor');
    company.email = company.email || vendor.email || null;
    company.phone = company.phone || vendor.phone || null;
    company.city = company.city || vendor.city || null;
    company.state = company.state || vendor.state || null;
  });

  (contractors || []).forEach((contractor) => {
    const company = getCompany(contractor.name);
    if (!company) return;
    company.contractor_id = contractor.id;
    if (!company.roles.includes('Contractor')) company.roles.unshift('Contractor');
    company.email = company.email || contractor.email || null;
    company.phone = company.phone || contractor.phone || null;
    company.city = company.city || contractor.city || null;
    company.state = company.state || contractor.state || null;
    company.trade = company.trade || contractor.trade || null;
  });

  return Array.from(byName.values())
    .sort((a, b) => a.name.localeCompare(b.name));
}

router.get('/', async (req, res) => {
  const q = sanitizePostgrestSearch((req.query.q || '').trim());
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  const [vendorResult, contractorResult] = await Promise.all([
    supabase.from('vendors').select('id, name, email, phone, city, state, archived').neq('archived', 1).order('name', { ascending: true }).limit(2000),
    supabase.from('contractors').select('id, name, email, phone, city, state, trade, active').neq('active', false).order('name', { ascending: true }).limit(2000),
  ]);

  if (vendorResult.error) throw vendorResult.error;
  if (contractorResult.error) throw contractorResult.error;

  const allCompanies = mergeCompanies(vendorResult.data || [], contractorResult.data || []);
  const filteredCompanies = allCompanies.filter(company => searchCompany(company, q));
  const total = filteredCompanies.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * PAGE_SIZE;
  const companies = filteredCompanies.slice(offset, offset + PAGE_SIZE);

  res.render('companies/index', {
    title: 'Companies',
    activeNav: 'companies',
    companies,
    q,
    page: safePage,
    totalPages,
    total,
    contractorCount: filteredCompanies.filter(c => c.contractor_id).length,
    vendorCount: filteredCompanies.filter(c => c.vendor_id).length,
    combinedCount: filteredCompanies.filter(c => c.contractor_id && c.vendor_id).length,
  });
});

router.get('/new', (req, res) => {
  res.render('companies/new', {
    title: 'Add company',
    activeNav: 'companies',
    company: { company_role: 'vendor' },
    errors: {},
  });
});

router.post('/', async (req, res) => {
  const { errors, data } = validateCompany(req.body);
  if (Object.keys(errors).length) {
    return res.status(400).render('companies/new', {
      title: 'Add company', activeNav: 'companies', company: data, errors,
    });
  }

  const wantsVendor = data.company_role === 'vendor' || data.company_role === 'both';
  const wantsContractor = data.company_role === 'contractor' || data.company_role === 'both';
  const profiles = await findCompanyProfiles(data.name);
  const vendorAlreadyActive = wantsVendor && profiles.vendor && profiles.vendor.archived !== true && profiles.vendor.archived !== 1;
  const contractorAlreadyActive = wantsContractor && profiles.contractor && profiles.contractor.active !== false;

  if ((!wantsVendor || vendorAlreadyActive) && (!wantsContractor || contractorAlreadyActive)) {
    errors.name = 'A company with this name and role already exists.';
    return res.status(409).render('companies/new', {
      title: 'Add company', activeNav: 'companies', company: data, errors,
    });
  }

  const contactPayload = {
    name: data.name,
    email: data.email,
    phone: data.phone,
    address: data.address,
    city: data.city,
    state: data.state,
    zip: data.zip,
  };
  const created = [];

  try {
    if (wantsVendor && !vendorAlreadyActive) {
      if (profiles.vendor) {
        const { error } = await supabase.from('vendors')
          .update({ ...contactPayload, archived: 0, updated_at: new Date().toISOString() })
          .eq('id', profiles.vendor.id);
        if (error) throw error;
      } else {
        const { data: vendor, error } = await supabase.from('vendors')
          .insert({ ...contactPayload, archived: 0 })
          .select('id')
          .single();
        if (error) throw error;
        created.push({ role: 'vendor', id: vendor.id });
      }
    }

    if (wantsContractor && !contractorAlreadyActive) {
      if (profiles.contractor) {
        const { error } = await supabase.from('contractors')
          .update({ ...contactPayload, trade: data.trade, active: true, updated_at: new Date().toISOString() })
          .eq('id', profiles.contractor.id);
        if (error) throw error;
      } else {
        const { data: contractor, error } = await supabase.from('contractors')
          .insert({
            ...contactPayload,
            trade: data.trade,
            active: true,
            created_by_user_id: req.session.userId || null,
          })
          .select('id')
          .single();
        if (error) throw error;
        created.push({ role: 'contractor', id: contractor.id });
      }
    }
  } catch (error) {
    // Do not leave half of a newly-created "Both" company behind if the second insert fails.
    await Promise.all(created.map(({ role, id }) => (
      supabase.from(role === 'vendor' ? 'vendors' : 'contractors').delete().eq('id', id)
    )));
    throw error;
  }

  await ensureCompanyFolders(created, req.session.userId);
  setFlash(req, 'success', `Company "${data.name}" added.`);
  res.redirect('/companies');
});

module.exports = router;
