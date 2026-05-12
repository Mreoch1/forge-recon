/**
 * estimate-email.js — Generate and send estimate email via nodemailer SMTP.
 *
 * Used by both the manual /estimates/:id/send route and the AI send_estimate mutation.
 */
const supabase = require('../db/supabase');
const email = require('./email');
const pdf = require('./pdf');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function fmtMoney(value) {
  const num = Number(value);
  return `$${(Number.isFinite(num) ? num : 0).toFixed(2)}`;
}

function customerFacingEstimate(estimate) {
  return {
    ...estimate,
    cost_total: undefined,
    lines: (estimate.lines || []).map(li => ({
      trade: li.trade || '',
      description: li.description,
      quantity: li.quantity,
      unit: li.unit,
      unit_price: li.unit_price,
      line_total: li.line_total,
    })),
  };
}

function buildEstimateEmailBody(est, company = {}) {
  const safeCompany = escapeHtml(company.company_name || 'Recon Enterprises');
  const safeCustomer = escapeHtml(est.customer_name || 'there');
  const safeEstimateNumber = escapeHtml(est.display_number);
  const safeWoNumber = escapeHtml(est.wo_display_number || '');
  const safeValidUntil = est.valid_until ? escapeHtml(String(est.valid_until).slice(0, 10)) : '';
  const rows = (est.lines || []).map(li => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #eeeeee;">${escapeHtml(li.description || '')}</td>
      <td style="padding:10px 0;border-bottom:1px solid #eeeeee;text-align:right;white-space:nowrap;">${escapeHtml(li.quantity || 0)} ${escapeHtml(li.unit || '')}</td>
      <td style="padding:10px 0;border-bottom:1px solid #eeeeee;text-align:right;white-space:nowrap;">${fmtMoney(li.line_total)}</td>
    </tr>
  `).join('');

  return `
    <p style="margin-top:0;">Hi ${safeCustomer},</p>
    <p>${safeCompany} prepared estimate <strong>${safeEstimateNumber}</strong>${safeWoNumber ? ` for work order <strong>${safeWoNumber}</strong>` : ''}. The full estimate PDF is attached for your review.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0;border-collapse:collapse;">
      <tr>
        <td style="padding:14px 16px;background:#f5f5f5;border-radius:6px;">
          <span style="display:block;color:#777;font-size:12px;text-transform:uppercase;letter-spacing:.08em;">Estimate total</span>
          <span style="display:block;color:#c0202b;font-size:28px;font-weight:800;line-height:1.2;">${fmtMoney(est.total)}</span>
          ${safeValidUntil ? `<span style="display:block;color:#777;font-size:13px;margin-top:4px;">Valid until ${safeValidUntil}</span>` : ''}
        </td>
      </tr>
    </table>
    ${rows ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:18px 0;">
        <thead>
          <tr>
            <th align="left" style="color:#777;font-size:11px;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid #dddddd;padding-bottom:8px;">Item</th>
            <th align="right" style="color:#777;font-size:11px;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid #dddddd;padding-bottom:8px;">Qty</th>
            <th align="right" style="color:#777;font-size:11px;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid #dddddd;padding-bottom:8px;">Amount</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    ` : ''}
    <p>Please review the attached estimate. If everything looks good, sign and return the PDF to <a href="mailto:Office@reconenterprises.net" style="color:#c0202b;">Office@reconenterprises.net</a>.</p>
    <p style="margin-bottom:0;">Thanks,<br>${safeCompany}</p>
  `;
}

/**
 * Generate the estimate PDF, compose an email, and send it.
 * @param {number} estimateId
 * @returns {Promise<{sent: boolean}>}
 */
async function sendEstimateEmail(estimateId) {
  const est = await loadEstimateForEmail(estimateId);
  if (!est) throw new Error(`Estimate #${estimateId} not found.`);
  if (est.status !== 'draft') throw new Error(`Estimate ${est.display_number} is "${est.status}" — must be draft to send.`);

  const { data: company } = await supabase.from('company_settings').select('*').eq('id', 1).maybeSingle();
  const c = company || {};
  const customerEstimate = customerFacingEstimate(est);
  const buf = await pdf.renderToBuffer(pdf.generateEstimatePDF, { ...customerEstimate, estimate_number: est.display_number }, c);
  const recipient = est.customer_billing_email || est.customer_email;
  if (!recipient) throw new Error(`Estimate ${est.display_number} cannot be sent because the customer has no email address.`);
  const subject = `Estimate ${est.display_number} from ${c.company_name || 'Recon Enterprises'}`;
  const text = [
    `Hello ${est.customer_name || ''},`,
    '',
    `Please find attached estimate ${est.display_number}.`,
    `Total: $${(Number(est.total) || 0).toFixed(2)}`,
    est.valid_until ? `Valid until: ${String(est.valid_until).slice(0, 10)}` : '',
    '',
    `Thanks,`,
    `${c.company_name || 'Recon Enterprises'}`
  ].filter(line => line !== '').join('\n');

  const result = await email.sendEmail({
    to: recipient,
    subject,
    text,
    htmlBody: buildEstimateEmailBody(est, c),
    attachments: [{
      filename: `${est.display_number}.pdf`,
      content: buf,
      contentType: 'application/pdf'
    }]
  });

  return { sent: true, mode: result.mode || 'email', to: recipient, toName: est.customer_name || null };
}

/**
 * Load estimate with joined data needed for email.
 * Supports both legacy job-based and R34 customer-direct WOs.
 */
async function loadEstimateForEmail(id) {
  const { data: est, error } = await supabase
    .from('estimates')
    .select(`
      *,
      work_orders!inner(
        display_number, wo_number_main, wo_number_sub, customer_id, unit_number,
        jobs!left(title, address, city, state, zip, customers!left(name, email, billing_email, phone, address, city, state, zip)),
        customers!left(name, email, billing_email, phone, address, city, state, zip)
      )
    `)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!est) return null;

  const wo = est.work_orders;
  // R34: prefer direct customer, fall back to job->customer for legacy WOs
  const customer = wo.customers || (wo.jobs?.customers);
  est.wo_display_number = wo.display_number;
  est.wo_number_main = wo.wo_number_main;
  est.wo_number_sub = wo.wo_number_sub;
  est.job_title = wo.jobs?.title || null;
  est.job_address = wo.jobs?.address || customer?.address || null;
  est.job_city = wo.jobs?.city || customer?.city || null;
  est.job_state = wo.jobs?.state || customer?.state || null;
  est.job_zip = wo.jobs?.zip || customer?.zip || null;
  est.customer_name = customer?.name || null;
  est.customer_email = customer?.email || null;
  est.customer_billing_email = customer?.billing_email || null;
  est.customer_phone = customer?.phone || null;
  est.customer_address = customer?.address || null;
  est.customer_city = customer?.city || null;
  est.customer_state = customer?.state || null;
  est.customer_zip = customer?.zip || null;
  est.display_number = `EST-${wo.display_number}`;
  delete est.work_orders;

  const { data: lines } = await supabase
    .from('estimate_line_items')
    .select('*')
    .eq('estimate_id', id)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  est.lines = lines || [];

  return est;
}

module.exports = { sendEstimateEmail, _internal: { buildEstimateEmailBody, customerFacingEstimate } };
