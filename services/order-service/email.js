const nodemailer = require('nodemailer');

function getSmtpConfig() {
  const smarthost = process.env.SMTP_SMARTHOST;
  const separator = smarthost?.lastIndexOf(':') ?? -1;
  const [smartHostName, smartHostPort] = separator > 0
    ? [smarthost.slice(0, separator), smarthost.slice(separator + 1)]
    : [smarthost, undefined];
  const host = process.env.SMTP_HOST || smartHostName;
  const port = Number(process.env.SMTP_PORT || smartHostPort || 587);
  const from = process.env.SMTP_FROM;
  const username = process.env.SMTP_USERNAME;
  const password = process.env.SMTP_PASSWORD;
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;

  if (!host || !from || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  if (Boolean(username) !== Boolean(password)) {
    throw new Error('SMTP_USERNAME and SMTP_PASSWORD must be configured together');
  }
  return { host, port, secure, from, username, password };
}

function validateProductionEmailConfig() {
  const config = getSmtpConfig();
  if (!config) {
    throw new Error('[order-service] SMTP_HOST (or SMTP_SMARTHOST), SMTP_FROM, and a valid SMTP_PORT are required in production');
  }
  const publicAppUrl = process.env.PUBLIC_APP_URL || process.env.DASHBOARD_ORIGIN;
  let parsedUrl;
  try {
    parsedUrl = new URL(publicAppUrl);
  } catch {
    throw new Error('[order-service] PUBLIC_APP_URL must be a valid HTTPS URL in production');
  }
  if (parsedUrl.protocol !== 'https:' || !parsedUrl.hostname) {
    throw new Error('[order-service] PUBLIC_APP_URL must be an HTTPS URL in production');
  }
}

async function sendAccountEmail({ to, subject, text, html }) {
  const config = getSmtpConfig();
  if (!config) throw new Error('SMTP email delivery is not configured');
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.username ? { auth: { user: config.username, pass: config.password } } : {}),
  });
  await transporter.sendMail({
    from: config.from,
    to,
    subject,
    text,
    html,
  });
}

module.exports = { sendAccountEmail, validateProductionEmailConfig };
