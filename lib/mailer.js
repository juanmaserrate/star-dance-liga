// Envío de emails centralizado: usa la API HTTP de Resend si RESEND_API_KEY
// está configurada; si no, SMTP (con timeouts); si no hay nada, el llamador
// registra el enlace en consola (modo desarrollo).
const nodemailer = require('nodemailer');

async function sendMail({ to, subject, html }) {
  // 1) Resend HTTP API (recomendado: puerto 443, funciona en Railway)
  if (process.env.RESEND_API_KEY) {
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: process.env.SMTP_FROM || process.env.RESEND_FROM || 'onboarding@resend.dev',
          to,
          subject,
          html
        })
      });
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        console.error(`Resend API error ${resp.status}:`, errBody);
        return false;
      }
      return true;
    } catch (err) {
      console.error('Error sending via Resend API:', err);
      return false;
    }
  }

  // 2) SMTP genérico (con timeouts para no colgar la request)
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        connectionTimeout: 20000,
        greetingTimeout: 20000,
        socketTimeout: 30000,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      });
      await transporter.sendMail({
        from: process.env.SMTP_FROM || `"Liga Star Dance" <${process.env.SMTP_USER}>`,
        to,
        subject,
        html
      });
      return true;
    } catch (err) {
      console.error('Error sending email via SMTP:', err);
      return false;
    }
  }

  return false;
}

function logFallback(label, email, fullUrl) {
  console.log(`\n======================================================`);
  console.log(`${label}:`);
  console.log(`Para: ${email}`);
  console.log(`Link: ${fullUrl}`);
  console.log(`======================================================\n`);
}

function buildUrl(req, path) {
  return `${req.protocol}://${req.get('host')}${path}`;
}

module.exports = { sendMail, logFallback, buildUrl };
