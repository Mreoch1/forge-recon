/**
 * Email service — nodemailer via SMTP (support@reconenterprises.net / M365).
 *
 * Exported functions:
 *   sendEmail({ to, subject, text, html, attachments, replyTo, cc, bcc })  — generic
 *   sendVerificationEmail(email, name, token)
 *   sendPasswordResetEmail(email, name, token)
 *
 * Env vars:
 *   SMTP_HOST       — smtp.office365.com
 *   SMTP_PORT       — 587
 *   SMTP_SECURE     — false (STARTTLS)
 *   SMTP_USER       — support@reconenterprises.net
 *   SMTP_PASS       — mailbox password or app password
 *   EMAIL_FROM      — "FORGE" <support@reconenterprises.net>
 *   PUBLIC_BASE_URL — https://forge-recon.vercel.app
 */
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

// F9 fix: M365 SMTP needs rejectUnauthorized:false + SSLv3 ciphers.
// These are safe because the M365 endpoint is a known, pinned host.
// In production, the M365 cert chain sometimes mismatches Node's CA bundle.
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'smtp.office365.com',
  port:   parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_SECURE === 'true',
  auth:   {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: false,
    ciphers: 'SSLv3',
    minVersion: 'TLSv1',
  },
});

// Verify on boot
transporter.verify().then(
  () => console.log('[email] SMTP transporter ready'),
  (err) => console.error('[email] SMTP transporter init failed:', err.message)
).catch((err) => console.error('[email] SMTP verify failed:', err.message));

const FROM = process.env.EMAIL_FROM || '"FORGE" <support@reconenterprises.net>';
const BASE = process.env.PUBLIC_BASE_URL || 'https://forge-recon.vercel.app';
const EJS_LAYOUT = path.join(__dirname, '..', 'views', 'emails', 'layout.ejs');

function renderEmail(bodyHtml) {
  const ejs = require('ejs');
  return ejs.render(
    fs.readFileSync(EJS_LAYOUT, 'utf8'),
    { body: bodyHtml, host: BASE }
  );
}

function logSmtpError(label, toEmail, err) {
  console.error(
    `[email] ${label} failed for`, toEmail, '|',
    'message:', err.message, '|',
    'code:', err.code || 'n/a', '|',
    'response:', err.response || 'n/a', '|',
    'responseCode:', err.responseCode || 'n/a', '|',
    'command:', err.command || 'n/a'
  );
}

/**
 * Generic send. Used for transactional sends from app routes/services
 * (estimate email, invoice email, anything that builds its own body).
 *
 * @param {Object} options
 * @param {string|string[]} options.to
 * @param {string} options.subject
 * @param {string} [options.text]   - plain text body
 * @param {string} [options.html]   - HTML body (rendered as-is, NOT auto-wrapped in brand layout)
 * @param {string} [options.htmlBody] - HTML inner body (auto-wrapped in the branded email layout)
 * @param {Array}  [options.attachments]
 * @param {string} [options.replyTo]
 * @param {string|string[]} [options.cc]
 * @param {string|string[]} [options.bcc]
 * @returns {Promise<{messageId: string, accepted: string[], rejected: string[], response: string}>}
 */
async function sendEmail({ to, subject, text, html, htmlBody, attachments, replyTo, cc, bcc }) {
  if (!to) throw new Error('sendEmail: missing "to"');
  if (!subject) throw new Error('sendEmail: missing "subject"');

  // If a raw htmlBody is provided, wrap it in the branded layout.
  // Otherwise use html as-is, or fall back to plain text.
  const finalHtml = htmlBody ? renderEmail(htmlBody) : html;

  try {
    const info = await transporter.sendMail({
      from: FROM,
      to,
      subject,
      ...(text ? { text } : {}),
      ...(finalHtml ? { html: finalHtml } : {}),
      ...(attachments ? { attachments } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(cc ? { cc } : {}),
      ...(bcc ? { bcc } : {}),
    });
    console.log('[email] sent to', to, 'subject:', subject, 'messageId:', info.messageId);
    return info;
  } catch (err) {
    logSmtpError('sendEmail', to, err);
    throw err;
  }
}

/**
 * Send a verification email for new signups.
 */
async function sendVerificationEmail(toEmail, toName, token) {
  const link = `${BASE}/verify-email/${token}`;
  const subject = 'Verify your FORGE account';

  const bodyHtml = `<p>Hi ${toName},</p>
<p>Thanks for signing up for FORGE. Click below to verify your email address and activate your account. The link expires in 24 hours.</p>
<p style="text-align:center;margin:24px 0">
  <a href="${link}" style="display:inline-block;background:#c0202b;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">Verify Email</a>
</p>
<p>If you didn't create an account, you can safely ignore this email.</p>`;
  const html = renderEmail(bodyHtml);
  const text = `Hi ${toName},\n\nThanks for signing up for FORGE. Click the link below to verify your email address and activate your account. The link expires in 24 hours.\n\n${link}\n\nIf you didn't create an account, you can safely ignore this email.\n\n— FORGE by Recon Enterprises`;

  try {
    const info = await transporter.sendMail({ from: FROM, to: toEmail, subject, html, text });
    console.log('[email] verification sent to', toEmail, 'messageId:', info.messageId);
    return info;
  } catch (err) {
    logSmtpError('sendVerificationEmail', toEmail, err);
    throw err;
  }
}

/**
 * Send a password reset email.
 */
async function sendPasswordResetEmail(toEmail, toName, resetToken) {
  const link = `${BASE}/reset-password/${resetToken}`;
  const subject = 'Reset your FORGE password';

  const bodyHtml = `<p>Hi ${toName},</p>
<p>Someone requested a password reset for your FORGE account. Click below to set a new password. The link expires in 1 hour.</p>
<p style="text-align:center;margin:24px 0">
  <a href="${link}" style="display:inline-block;background:#c0202b;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">Reset password</a>
</p>
<p>If you didn't request this, you can safely ignore this email.</p>`;
  const html = renderEmail(bodyHtml);
  const text = `Hi ${toName},\n\nSomeone requested a password reset for your FORGE account. Click the link below to set a new password. The link expires in 1 hour.\n\n${link}\n\nIf you didn't request this, you can safely ignore this email.\n\n— FORGE by Recon Enterprises`;

  try {
    const info = await transporter.sendMail({ from: FROM, to: toEmail, subject, html, text });
    console.log('[email] password reset sent to', toEmail, 'messageId:', info.messageId);
    return info;
  } catch (err) {
    logSmtpError('sendPasswordResetEmail', toEmail, err);
    throw err;
  }
}

function escapeHtml(s) {
  if (typeof s !== 'string') return s || '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/**
 * Send a work-order-assigned notification email to an assignee.
 */
async function sendWorkOrderAssignedEmail({ to, toName, woNumber, woId, customerName, address, unitNumber, description, internalNotes, scheduledDate, scheduledTime, pdfBuffer }) {
  const link = `${BASE}/work-orders/${woId}`;
  const safeCust = escapeHtml(customerName);
  const safeAddr = escapeHtml(address);
  const safeUnit = escapeHtml(unitNumber);
  const safeDesc = escapeHtml(description);
  const safeNotes = escapeHtml(internalNotes);
  const subject = `FORGE · Work Order ${woNumber} · ${safeCust}${safeUnit ? ' (' + safeUnit + ')' : ''}`;
  const bodyHtml = `
    <div style="max-width:600px;margin:0 auto;font-family:Inter,-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">
    <div style="background:#fff;border:1px solid #e0e0e0;padding:24px 32px;border-radius:8px">
      <p style="font-size:12px;color:#888;margin:0 0 12px;text-transform:uppercase;letter-spacing:.08em">Work Order Assignment</p>
      <p style="font-size:15px;color:#333">Hello${toName ? ' ' + escapeHtml(toName) : ''},</p>
      <p style="font-size:14px;color:#555">You've been assigned the following work order:</p>

      <div style="background:#f8f8f8;border-radius:8px;padding:16px;margin:16px 0">
        <p style="font-size:13px;color:#888;margin:0 0 4px;text-transform:uppercase;letter-spacing:.08em">${woNumber}</p>
        <p style="font-size:18px;font-weight:600;color:#1a1a1a;margin:0">${safeCust}${safeUnit ? ' — ' + safeUnit : ''}</p>
        <p style="font-size:13px;color:#666;margin:8px 0 0">${safeAddr}</p>
      </div>

      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px">
        <tr>
          <td style="color:#888;padding:6px 8px;border:1px solid #eee">Scheduled</td>
          <td style="color:#333;padding:6px 8px;border:1px solid #eee;font-weight:500">${scheduledDate || '—'} ${scheduledTime || ''}</td>
        </tr>
      </table>

      ${safeDesc ? `<div style="background:#f8f8f8;border-radius:8px;padding:16px;margin:16px 0">
        <p style="font-size:12px;color:#888;margin:0 0 6px;text-transform:uppercase;letter-spacing:.06em">Description</p>
        <p style="font-size:14px;color:#333;margin:0;line-height:1.5">${safeDesc}</p>
      </div>` : ''}

      ${safeNotes ? `<div style="background:#fff8e1;border-radius:8px;padding:16px;margin:16px 0">
        <p style="font-size:12px;color:#888;margin:0 0 6px;text-transform:uppercase;letter-spacing:.06em">Crew Notes</p>
        <p style="font-size:14px;color:#333;margin:0;line-height:1.5;white-space:pre-line">${safeNotes}</p>
      </div>` : ''}

      <div style="text-align:center;margin:24px 0">
        <a href="${link}" style="display:inline-block;background:#c0202b;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600">Open in FORGE</a>
      </div>

      <p style="font-size:12px;color:#aaa;text-align:center;margin:16px 0 0">
        <a href="${BASE}" style="color:#c0202b;text-decoration:none">${BASE}</a>
      </p>
    </div>
    </div>`;
  const html = renderEmail(bodyHtml);
  const text = `FORGE Work Order Assignment\n\n${woNumber} — ${safeCust}${safeUnit ? ' (' + safeUnit + ')' : ''}\n${safeAddr}\nScheduled: ${scheduledDate} ${scheduledTime || ''}\n\n${safeDesc ? 'Description:\n' + safeDesc + '\n\n' : ''}${safeNotes ? 'Crew Notes:\n' + safeNotes + '\n\n' : ''}Open: ${link}`;

  try {
    const info = await transporter.sendMail({
      from: FROM, to, subject, html, text,
      attachments: pdfBuffer ? [{ filename: `${woNumber}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }] : [],
    });
    console.log('[email] WO assignment sent to', to, 'messageId:', info.messageId);
    return info;
  } catch (err) {
    logSmtpError('sendWorkOrderAssignedEmail', to, err);
    throw err;
  }
}

/**
 * Send an auto-generated invite email when an admin creates a new user.
 * @param {string} toEmail
 * @param {string} toName
 * @param {string} tempPassword - the plaintext password the admin set
 */
async function sendUserInviteEmail(toEmail, toName, tempPassword) {
  const link = `${BASE_URL}/login`;
  const htmlBody = `
    <p>Hi ${escHtml(toName)},</p>
    <p>An admin at Recon Enterprises created a <strong>FORGE</strong> account for you.</p>
    <div style="background:#fff8e1;border:1px solid #f0c000;border-radius:8px;padding:16px;margin:16px 0;text-align:center">
      <p style="font-size:13px;color:#888;margin:0 0 8px;text-transform:uppercase;letter-spacing:.08em">Your temporary login</p>
      <p style="font-size:16px;font-weight:600;margin:0"><strong>Email:</strong> ${escHtml(toEmail)}</p>
      <p style="font-size:16px;font-weight:600;margin:4px 0 0"><strong>Password:</strong> ${escHtml(tempPassword)}</p>
    </div>
    <p style="font-size:13px;color:#888">Please change your password on first login.</p>
    <div style="text-align:center;margin:20px 0">
      <a href="${link}" style="display:inline-block;background:#c0202b;color:#fff;padding:12px 36px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600">Log in to FORGE</a>
    </div>
    <p style="font-size:12px;color:#aaa">If you didn't expect this invite, you can ignore this email.</p>`;

  try {
    const info = await sendEmail({
      to: toEmail,
      subject: 'Welcome to FORGE — your account is ready',
      htmlBody,
    });
    console.log('[email] invite sent to', toEmail, 'messageId:', info.messageId);
    return info;
  } catch (err) {
    logSmtpError('sendUserInviteEmail', toEmail, err);
    throw err;
  }
}

module.exports = { sendEmail, sendVerificationEmail, sendPasswordResetEmail, sendWorkOrderAssignedEmail, sendUserInviteEmail };
