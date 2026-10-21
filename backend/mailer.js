/* ============================================================
   Outgoing mail — currently just payslips, but kept generic enough for
   anything else that needs to email an attachment later. Reads SMTP
   settings from .env (see .env.example); if they're not filled in,
   sendMail() throws a clear, specific error instead of a confusing
   nodemailer stack trace, so "Send Payslips" can report it plainly.
   ============================================================ */
'use strict';
const nodemailer = require('nodemailer');

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    throw new Error('Mail is not configured yet — set SMTP_HOST/SMTP_USER/SMTP_PASS in backend/.env.');
  }
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: +(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transporter;
}

// { to, subject, text, html, attachments: [{filename, content (Buffer)}] }
async function sendMail(opts) {
  const t = getTransporter();
  return t.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    ...opts,
  });
}

function mailConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

module.exports = { sendMail, mailConfigured };
