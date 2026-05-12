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

const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST || 'smtp.office365.com',
  port:   parseInt(process.env.SMTP_PORT || '587', 10),
  secure: process.env.SMTP_SECURE === 'true',
  auth:   {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  tls: {
    ciphers: 'SSLv3',
    rejectUnauthorized: false,
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

module.exports = { sendEmail, sendVerificationEmail, sendPasswordResetEmail };
