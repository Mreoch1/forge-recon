const express = require('express');
const supabase = require('../db/supabase');
const { sanitizePostgrestSearch } = require('../services/sanitize');

const router = express.Router();
const PAGE_SIZE = 50;

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
    supabase.from('vendors').select('id, name, email, phone, city, state').order('name', { ascending: true }).limit(2000),
    supabase.from('contractors').select('id, name, email, phone, city, state, trade').order('name', { ascending: true }).limit(2000),
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

module.exports = router;
