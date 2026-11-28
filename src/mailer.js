'use strict';
// Generic SMTP mailer for instructor password recovery.
// Configured entirely from environment variables; no secrets are stored in the repository.
const nodemailer = require('nodemailer');

function createMailer(env = process.env, logger = console) {
  const host = env.SMTP_HOST;
  const port = Number(env.SMTP_PORT || 587);
  const from = env.MAIL_FROM;
  const baseUrl = (env.PORTAL_BASE_URL || '').replace(/\/+$/, '');
  const configured = !!host && !!from && !!baseUrl && Number.isInteger(port) && port > 0 && port < 65536;

  let transport = null;
  if (configured) {
    const secure = String(env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465;
    transport = nodemailer.createTransport({
      host, port, secure,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS || '' } : undefined,
      // Connection/time limits stop a broken mail server from hanging a sign-in request.
      connectionTimeout: 5_000, greetingTimeout: 5_000, socketTimeout: 10_000,
    });
  }

  return {
    configured,
    baseUrl,
    // Delivery errors are swallowed: the API always answers the same way so it cannot be used
    // to enumerate instructor email addresses. The failure is only recorded in the server log.
    async sendPasswordReset({ to, fullName, link }) {
      if (!configured) { logger.warn('SMTP is not configured; password reset email was not sent.'); return false; }
      try {
        await transport.sendMail({
          from,
          to,
          subject: 'Grade Portal password reset',
          text: [
            `Hello ${fullName},`,
            '',
            'Use this link to choose a new Grade Portal password:',
            link,
            '',
            'The link expires in 30 minutes and can be used once.',
            'If you did not request it, you can ignore this message.',
          ].join('\n'),
        });
        return true;
      } catch (err) {
        logger.error('Password reset email failed:', err.message);
        return false;
      }
    },
  };
}

module.exports = { createMailer };
