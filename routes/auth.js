const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const db = require('../database');

// Helper to send email or log link
async function sendResetEmail(email, resetUrl, req) {
  const host = req.get('host');
  const fullUrl = `${req.protocol}://${host}${resetUrl}`;

  // Check if SMTP environment variables are configured
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });

      await transporter.sendMail({
        from: process.env.SMTP_FROM || '"Liga Star Dance" <no-reply@stardance.com.ar>',
        to: email,
        subject: '🔐 Restablecer contraseña - Liga Star Dance',
        html: `
          <div style="font-family: Arial, sans-serif; padding: 20px; color: #12061c;">
            <h2 style="color: #3b1959;">Restablecimiento de Contraseña - Liga Star Dance</h2>
            <p>Hemos recibido una solicitud para cambiar la contraseña de tu cuenta registrada con el email: <strong>${email}</strong>.</p>
            <p>Hacé clic en el siguiente botón para ingresar tu nueva contraseña (válido por 1 hora):</p>
            <div style="margin: 25px 0;">
              <a href="${fullUrl}" style="background: #d4af37; color: #12061c; font-weight: bold; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                🔑 Restablecer mi Contraseña
              </a>
            </div>
            <p style="font-size: 0.85rem; color: #666;">Si no solicitaste este cambio, podés ignorar este correo de forma segura.</p>
          </div>
        `
      });
      return { sent: true, fullUrl };
    } catch (err) {
      console.error('Error sending email via SMTP:', err);
      return { sent: false, fullUrl };
    }
  }

  // Fallback if no SMTP configured: log link to console
  console.log(`\n======================================================`);
  console.log(`🔑 LINK DE RECUPERACIÓN DE CONTRASEÑA GENERADO:`);
  console.log(`Para: ${email}`);
  console.log(`Link: ${fullUrl}`);
  console.log(`======================================================\n`);

  return { sent: false, fullUrl };
}

// Login GET
router.get('/login', (req, res) => {
  if (req.session && req.session.user) {
    return redirectRole(req.session.user.role, res);
  }

  res.render('auth/login', {
    user: null,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

// Login POST
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.render('auth/login', {
      user: null,
      error: 'Por favor complete el usuario y la contraseña.',
      success: null
    });
  }

  try {
    const user = db.prepare(`SELECT * FROM users WHERE username = ?`).get(username.trim().toLowerCase());

    if (!user) {
      return res.render('auth/login', {
        user: null,
        error: 'Usuario o contraseña incorrectos.',
        success: null
      });
    }

    const isValid = bcrypt.compareSync(password, user.password_hash);
    if (!isValid) {
      return res.render('auth/login', {
        user: null,
        error: 'Usuario o contraseña incorrectos.',
        success: null
      });
    }

    let clubName = '';
    if (user.club_id) {
      const club = db.prepare(`SELECT name FROM clubs WHERE id = ?`).get(user.club_id);
      if (club) clubName = club.name;
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role,
      club_id: user.club_id,
      club_name: clubName,
      email: user.email
    };

    redirectRole(user.role, res);
  } catch (err) {
    console.error('Login error:', err);
    res.render('auth/login', {
      user: null,
      error: 'Error interno al autenticar.',
      success: null
    });
  }
});

// GET: Forgot Password Request Form
router.get('/olvide-password', (req, res) => {
  res.render('auth/olvide_password', {
    user: null,
    error: req.query.error || null,
    success: req.query.success || null,
    resetLink: req.query.resetLink || null
  });
});

// POST: Process Forgot Password Request
router.post('/olvide-password', async (req, res) => {
  const { email_or_username } = req.body;

  if (!email_or_username) {
    return res.render('auth/olvide_password', {
      user: null,
      error: 'Ingrese su email o nombre de usuario.',
      success: null,
      resetLink: null
    });
  }

  const queryTerm = email_or_username.trim().toLowerCase();
  const user = db.prepare(`
    SELECT * FROM users 
    WHERE LOWER(username) = ? OR LOWER(email) = ?
  `).get(queryTerm, queryTerm);

  if (!user) {
    // For security, show generic friendly response
    return res.render('auth/olvide_password', {
      user: null,
      error: null,
      success: 'Si el usuario o correo existe en nuestro sistema, se ha generado el enlace de restablecimiento.',
      resetLink: null
    });
  }

  // Delete previous tokens for this user
  db.prepare(`DELETE FROM password_resets WHERE user_id = ?`).run(user.id);

  // Generate random token valid for 1 hour
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO password_resets (user_id, token, expires_at)
    VALUES (?, ?, ?)
  `).run(user.id, token, expiresAt);

  const resetPath = `/auth/restablecer-password?token=${token}`;
  const emailTarget = user.email || `${user.username}@stardance.com.ar`;
  
  const { sent, fullUrl } = await sendResetEmail(emailTarget, resetPath, req);

  let successMsg = `Se ha generado el enlace de restablecimiento para el usuario ${user.username}.`;
  if (sent) {
    successMsg += ` Se envió un correo a ${user.email}.`;
  }

  res.render('auth/olvide_password', {
    user: null,
    error: null,
    success: successMsg,
    resetLink: fullUrl
  });
});

// GET: Reset Password Form with Token
router.get('/restablecer-password', (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.redirect('/auth/login?error=' + encodeURIComponent('Enlace de restablecimiento inválido.'));
  }

  const resetRecord = db.prepare(`SELECT * FROM password_resets WHERE token = ?`).get(token);
  if (!resetRecord) {
    return res.redirect('/auth/login?error=' + encodeURIComponent('El enlace de restablecimiento es inválido o ya fue utilizado.'));
  }

  if (new Date(resetRecord.expires_at) < new Date()) {
    db.prepare(`DELETE FROM password_resets WHERE token = ?`).run(token);
    return res.redirect('/auth/olvide-password?error=' + encodeURIComponent('El enlace ha expirado. Por favor solicite uno nuevo.'));
  }

  res.render('auth/restablecer_password', {
    user: null,
    token,
    error: null
  });
});

// POST: Save New Password
router.post('/restablecer-password', (req, res) => {
  const { token, password, confirm_password } = req.body;

  if (!token || !password || !confirm_password) {
    return res.render('auth/restablecer_password', {
      user: null,
      token,
      error: 'Por favor complete todos los campos.'
    });
  }

  if (password !== confirm_password) {
    return res.render('auth/restablecer_password', {
      user: null,
      token,
      error: 'Las contraseñas no coinciden.'
    });
  }

  if (password.length < 6) {
    return res.render('auth/restablecer_password', {
      user: null,
      token,
      error: 'La contraseña debe tener al menos 6 caracteres.'
    });
  }

  const resetRecord = db.prepare(`SELECT * FROM password_resets WHERE token = ?`).get(token);
  if (!resetRecord || new Date(resetRecord.expires_at) < new Date()) {
    return res.redirect('/auth/login?error=' + encodeURIComponent('El enlace expiró o es inválido.'));
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(passwordHash, resetRecord.user_id);
  db.prepare(`DELETE FROM password_resets WHERE user_id = ?`).run(resetRecord.user_id);

  res.redirect('/auth/login?success=' + encodeURIComponent('✅ Contraseña restablecida con éxito. Ya podés ingresar con tu nueva clave.'));
});

// Logout
router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

function redirectRole(role, res) {
  if (role === 'admin') return res.redirect('/admin/dashboard');
  if (role === 'profesor') return res.redirect('/profesor/dashboard');
  if (role === 'juez') return res.redirect('/juez/planilla');
  res.redirect('/');
}

module.exports = router;
