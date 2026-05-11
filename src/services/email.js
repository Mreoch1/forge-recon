/**
 * Email service.
 *
 * v0 mode: writes RFC822 .eml files to mail-outbox/ instead of sending
 * via SMTP. The .eml is exactly what nodemailer would have transmitted —
 * Outlook / Thunderbird / any mail client can open it. Once Michael
 * wires real SMTP credentials (TODO_FOR_MICHAEL), flip EMAIL_MODE=smtp
 * and set SMTP_HOST/PORT/USER/PASS in .env.
 *
 * Public:
 *   sendEmail({ to, subject, text, html, attachments }) -> { filepath, messageId }
 */

const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const MAIL_OUTBOX = path.join(__dirname, '..', '..', 'mail-outbox');
const MODE = process.env.EMAIL_MODE || 'file'; // 'file' or 'smtp'

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function defaultFrom() {
  return process.env.EMAIL_FROM || '"Recon Construction" <noreply@recon.local>';
}

let _transport = null;

function transporter() {
  if (_transport) return _transport;
  if (MODE === 'smtp') {
    _transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === '1',
      auth: process.env.SMTP_USER ? {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      } : undefined,
    });
  } else {
    // streamTransport: returns the formed message as a buffer/stream and
    // does NOT actually send. We capture the buffer and write to disk.
    _transport = nodemailer.createTransport({
      streamTransport: true,
      newline: 'unix',
      buffer: true,
    });
  }
  return _transport;
}

function safeFilenameSlice(s) {
  return String(s || '').replace(/[^a-z0-9]/gi, '_').slice(0, 60);
}

async function sendEmail({ to, subject, text, html, attachments }) {
  const t = transporter();
  const result = await t.sendMail({
    from: defaultFrom(),
    to, subject, text, html,
    attachments: attachments || [],
  });

  if (MODE === 'file') {
    ensureDir(MAIL_OUTBOX);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${ts}__${safeFilenameSlice(subject)}.eml`;
    const filepath = path.join(MAIL_OUTBOX, filename);
    fs.writeFileSync(filepath, result.message);
    return { filepath, messageId: result.messageId, mode: 'file' };
  }
  return { messageId: result.messageId, mode: 'smtp', accepted: result.accepted, rejected: result.rejected };
}

/**
 * Send a password reset email.
 * Falls back to console.log if Resend is not configured.
 */
async function sendPasswordResetEmail(toEmail, toName, resetUrl) {
  const subject = 'Reset your FORGE password';
  const text = `Hi ${toName},\n\nSomeone requested a password reset for your FORGE account. Click the link below to set a new password. The link expires in 1 hour.\n\n${resetUrl}\n\nIf you didn't request this, you can safely ignore this email — no changes will be made to your account.\n\n— FORGE by Recon Enterprises`;
  const html = `<p>Hi ${toName},</p><p>Someone requested a password reset for your FORGE account. Click below to set a new password. The link expires in 1 hour.</p><p style="text-align:center;margin:24px 0"><a href="${resetUrl}" style="display:inline-block;background:#c0202b;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600">Reset password</a></p><p>If you didn't request this, you can safely ignore this email — no changes will be made to your account.</p><p style="color:#888;font-size:12px">— FORGE by Recon Enterprises</p>`;

  // Try Resend first if configured
  const resend = getResend();
  if (resend) {
    try {
      const result = await resend.emails.send({
        from: 'FORGE <support@reconenterprises.net>',
        to: [toEmail],
        subject,
        html,
        text,
      });
      return { ok: true, id: result.id };
    } catch (e) {
      console.error('[email] Resend send failed:', e.message);
      // Fall through to file/console fallback
    }
  }

  // Fallback: log to console (dev/staging convenience)
  console.log('[email] Password reset link for', toEmail, ':', resetUrl);
  console.log('[email] Would have sent:', { to: toEmail, subject, text: text.slice(0, 200) });
  return { ok: true, dev: true };
}

/**
 * Lazy-init Resend client.
 */
let resendClient = null;
function getResend() {
  if (resendClient) return resendClient;
  if (!process.env.RESEND_API_KEY) return null;
  const { Resend } = require('resend');
  resendClient = new Resend(process.env.RESEND_API_KEY);
  return resendClient;
}

module.exports = { sendEmail, sendPasswordResetEmail, MAIL_OUTBOX, MODE };
