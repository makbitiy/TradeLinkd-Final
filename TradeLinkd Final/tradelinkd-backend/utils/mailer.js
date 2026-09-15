const nodemailer = require('nodemailer');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let transporter = null;
let warnedNotConfigured = false;

function getTransporter() {
  if (transporter) return transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  return transporter;
}

// Fire-and-forget email send. Never throws - a failed or unconfigured email
// should never break the API request that triggered it (e.g. sending a message).
async function sendMail({ to, subject, text, html }) {
  if (!to || !EMAIL_RE.test(to)) return;

  const t = getTransporter();
  if (!t) {
    if (!warnedNotConfigured) {
      console.log('[mailer] SMTP not configured (see .env.example) - skipping email notifications. This is fine for local testing.');
      warnedNotConfigured = true;
    }
    return;
  }

  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to, subject, text, html
    });
  } catch (err) {
    console.error('[mailer] failed to send email:', err.message);
  }
}

module.exports = { sendMail };
