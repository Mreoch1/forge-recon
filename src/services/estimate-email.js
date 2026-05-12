/**
 * estimate-email.js — Generate and send estimate email via nodemailer SMTP.
 *
 * Used by both the manual /estimates/:id/send route and the AI send_estimate mutation.
 */
const supabase = require('../db/supabase');
const email = require('./email');
const pdf = require('./pdf');

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
  const buf = await pdf.renderToBuffer(pdf.generateEstimatePDF, { ...est, estimate_number: est.display_number }, c);
  const recipient = est.customer_email || 'unknown@recon.local';
  const subject = `Estimate ${est.display_number} from ${c.company_name || 'Recon Enterprises'}`;
  const text = [
    `Hello ${est.customer_name || ''},`,
    '',
    `Please find attached estimate ${est.display_number}.`,
    `Total: $${(Number(est.total) || 0).toFixed(2)}`,
    '',
    `Thanks,`,
    `${c.company_name || 'Recon Enterprises'}`
  ].join('\n');

  const result = await email.sendEmail({
    to: recipient,
    subject,
    text,
    html: text.split('\n').map(l => `<p>${l}</p>`).join(''),
    attachments: [{
      filename: `${est.display_number}.pdf`,
      content: buf,
      contentType: 'application/pdf'
    }]
  });

  return { sent: true, mode: result.mode || 'email' };
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
        display_number, wo_number_main, wo_number_sub, customer_id,
        jobs!left(title, customers!left(name, email)),
        customers!left(name, email)
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
  est.customer_name = customer?.name || null;
  est.customer_email = customer?.email || null;
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

module.exports = { sendEstimateEmail };
