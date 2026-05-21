/**
 * assignment-notify.js — Reusable service for sending email notifications
 * when a user is assigned to something in FORGE.
 *
 * Uses the branded email layout (emails/layout.ejs) and sends via the shared
 * sendEmail() service (email.js / nodemailer SMTP).
 *
 * Exports:
 *   notifyAssignment({ entity_type, entity_id, entity_label, user, assignedBy, deep_link, context })
 *
 * caller example:
 *   const notify = require('../services/assignment-notify');
 *   await notify.notifyAssignment({
 *     entity_type:  'work_order',
 *     entity_id:    wo.id,
 *     entity_label: `${wo.display_number} · ${wo.customer_name}`,
 *     user:         { id: crew.id, name: crew.name, email: crew.email },
 *     assignedBy:   'Jane (admin)',
 *     deep_link:    `https://forge.example.com/work-orders/${wo.id}`,
 *     context:      { scheduled_date: '2026-06-01', address: '123 Main St' },
 *   });
 */

const path = require('path');
const fs   = require('fs');
const ejs  = require('ejs');

const email       = require('./email');
const escapeHtml  = email._internal?.escapeHtml || defaultEscapeHtml;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function defaultEscapeHtml(s) {
  if (typeof s !== 'string') return s == null ? '' : String(s);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const TEMPLATE_PATH = path.join(__dirname, '..', 'views', 'emails', 'assignment.ejs');
const TEMPLATE_CACHE = { source: null, mtime: null };

/**
 * Load (and cache) the EJS template source.
 * Reads from disk every time — Node's fs caches in-memory, so this is fast.
 * In production the file rarely changes; we keep it simple (no watch).
 */
function loadTemplate() {
  return fs.readFileSync(TEMPLATE_PATH, 'utf8');
}

/**
 * Render the assignment notification email body (inner HTML, without layout).
 */
function renderAssignmentBody(opts) {
  const ejsSource = loadTemplate();
  return ejs.render(ejsSource, {
    user_name:    escapeHtml(opts.user?.name || 'there'),
    entity_label: escapeHtml(opts.entity_label || 'an item'),
    assigned_by:  escapeHtml(opts.assignedBy || 'a teammate'),
    deep_link:    opts.deep_link || '',
    context:      opts.context || null,
    entity_type:  opts.entity_type || '',
    host:         process.env.PUBLIC_BASE_URL || 'https://forge-recon.vercel.app',
  });
}

/**
 * Build the plain-text fallback for the assignment notification.
 */
function buildPlainText(opts) {
  const name   = opts.user?.name || 'there';
  const label  = opts.entity_label || 'an item';
  const by     = opts.assignedBy || 'a teammate';
  const link   = opts.deep_link || '';

  const lines = [
    `Hi ${name},`,
    '',
    `You've been assigned ${label} by ${by}.`,
    '',
  ];

  if (opts.context && typeof opts.context === 'object') {
    for (const [k, v] of Object.entries(opts.context)) {
      lines.push(`${k.replace(/_/g, ' ')}: ${v}`);
    }
    lines.push('');
  }

  lines.push(`Open in FORGE: ${link}`);
  lines.push('');
  lines.push('— FORGE by Recon Enterprises');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send an assignment notification email.
 *
 * @param {Object} options
 * @param {string} options.entity_type   — e.g. "work_order", "job", "estimate"
 * @param {number|string} options.entity_id — primary key / UUID
 * @param {string} options.entity_label  — Human-readable label for the subject line & body
 * @param {Object} options.user          — { id, name, email } of the assignee
 * @param {string} options.assignedBy    — display name of who assigned it
 * @param {string} options.deep_link     — full URL to the entity in FORGE
 * @param {Object} [options.context]     — optional extra key-value pairs for the body table
 *
 * @returns {Promise<{success:boolean, skipped?:boolean, reason?:string, messageId?:string}|*>}
 *   Returns sendEmail result on success, or a skipped/failed object on failure.
 *   NEVER throws — failures are logged and returned as an error object.
 */
async function notifyAssignment({
  entity_type,
  entity_id,
  entity_label,
  user,
  assignedBy,
  deep_link,
  context,
} = {}) {
  // ---- Validate user email ------------------------------------------------
  if (!user || !user.email) {
    const reason = 'no_email';
    console.log('[assignment-notify] skipped —', reason, 'for user', user?.id || user?.name || '(unknown)');
    return { skipped: true, reason };
  }

  const toEmail = user.email;
  const subject = `You've been assigned: ${entity_label || 'an item'}`;

  // ---- Render HTML body via EJS template ----------------------------------
  const htmlBody = renderAssignmentBody({
    user,
    entity_type,
    entity_label,
    assignedBy,
    deep_link,
    context,
  });

  // ---- Plain-text fallback ------------------------------------------------
  const text = buildPlainText({
    user,
    entity_label,
    assignedBy,
    deep_link,
    context,
  });

  // ---- Send via shared email service --------------------------------------
  try {
    const result = await email.sendEmail({
      to: toEmail,
      subject,
      htmlBody,
      text,
    });
    console.log(
      '[assignment-notify] sent to', toEmail,
      '| entity:', entity_type, entity_id,
      '| subject:', subject,
      '| messageId:', result.messageId,
    );
    return result;
  } catch (err) {
    console.error(
      '[assignment-notify] FAILED for', toEmail,
      '| entity:', entity_type, entity_id,
      '| error:', err.message,
    );
    // Return a structured error object instead of throwing
    return {
      success: false,
      error: true,
      reason: err.message,
      to: toEmail,
      entity_type,
      entity_id,
    };
  }
}

// ------------------ Internal for testing -----------------------------------
notifyAssignment._internal = {
  renderAssignmentBody,
  buildPlainText,
  escapeHtml,
  TEMPLATE_PATH,
};

module.exports = { notifyAssignment };
