/**
 * estimate-email.js — Generate and "send" (write .eml) an estimate email.
 *
 * TODO(R30): Retrofit to use views/emails/layout.ejs branded wrapper
 * for the HTML body instead of plain text → <p> conversion.
 *
 * Used by both the manual /estimates/:id/send route and the AI send_estimate mutation.
 */

const db = require('../db/db');
const email = require('./email');
const pdf = require('./pdf');

/**
 * Generate the estimate PDF, compose an email, and write it to mail-outbox/.
 *
 * @param {number} estimateId — DB id of the estimate
 * @returns {Promise<{filepath: string, sent: boolean}>}
 * @throws {Error} if estimate not found or not in draft status
 */
async function sendEstimateEmail(estimateId) {
  const est = loadEstimateForEmail(estimateId);
  if (!est) throw new Error(`Estimate #${estimateId} not found.`);
  if (est.status !== 'draft') throw new Error(`Estimate ${est.display_number} is "${est.status}" — must be draft to send.`);

  const company = await db.get('SELECT * FROM company_settings WHERE id = 1') || {};
  const buf = await pdf.renderToBuffer(pdf.generateEstimatePDF, { ...est, estimate_number: est.display_number }, company);
  const recipient = est.customer_email || 'unknown@recon.local';
  const subject = `Estimate ${est.display_number} from ${company.company_name || 'Recon Enterprises'}`;
  const text = [
    `Hello ${est.customer_name || ''},`,
    '',
    `Please find attached estimate ${est.display_number}.`,
    `Total: $${(Number(est.total) || 0).toFixed(2)}`,
    '',
    `Thanks,`,
    `${company.company_name || 'Recon Enterprises'}`
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

  return {
    filepath: result.filepath || '',
    sent: true,
    mode: result.mode || 'file'
  };
}

/**
 * Load estimate with joined data needed for email.
 */
async function loadEstimateForEmail(id) {
  const est = await db.get(
    `SELECT e.*,
            w.display_number AS wo_display_number,
            w.wo_number_main, w.wo_number_sub,
            j.title AS job_title,
            c.name AS customer_name,
            c.email AS customer_email
     FROM estimates e
     JOIN work_orders w ON w.id = e.work_order_id
     JOIN jobs j ON j.id = w.job_id
     JOIN customers c ON c.id = j.customer_id
     WHERE e.id = ?`,
    [id]
  );
  if (!est) return null;
  est.lines = await db.all(
    `SELECT * FROM estimate_line_items WHERE estimate_id = ? ORDER BY sort_order ASC, id ASC`,
    [id]
  );
  est.display_number = `EST-${est.wo_display_number}`;
  return est;
}

module.exports = { sendEstimateEmail };
