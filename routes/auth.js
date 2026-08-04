const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../database');
const { sendMail, logFallback, buildUrl } = require('../lib/mailer');

// Helper to send reset-password email or log link
async function sendResetEmail(email, resetUrl, req) {
  const fullUrl = buildUrl(req, resetUrl);

  const sent = await sendMail({
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

  if (!sent) logFallback('🔑 LINK DE RECUPERACIÓN DE CONTRASEÑA GENERADO', email, fullUrl);

  return { sent, fullUrl };
}

// Helper to send verification email or log link
async function sendVerificationEmail(email, verifyUrl, req) {
  const fullUrl = buildUrl(req, verifyUrl);

  const sent = await sendMail({
    to: email,
    subject: '✅ Confirma tu registro - Liga Star Dance',
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px; color: #12061c;">
        <h2 style="color: #3b1959;">Bienvenido/a a la Liga Star Dance</h2>
        <p>Para poder ingresar a la plataforma necesitás <strong>verificar tu correo electrónico</strong>.</p>
        <p>Hacé clic en el siguiente botón para confirmar tu email (válido por 24 horas):</p>
        <div style="margin: 25px 0;">
          <a href="${fullUrl}" style="background: #d4af37; color: #12061c; font-weight: bold; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
            ✅ Verificar mi Email
          </a>
        </div>
        <p style="font-size: 0.85rem; color: #666;">Si no creaste una cuenta en la Liga Star Dance, podés ignorar este correo de forma segura.</p>
      </div>
    `
  });

  if (!sent) logFallback('✅ ENLACE DE VERIFICACIÓN DE EMAIL GENERADO', email, fullUrl);

  return { sent, fullUrl };
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
router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.render('auth/login', {
      user: null,
      error: 'Por favor complete el usuario y la contraseña.',
      success: null
    });
  }

  try {
    const user = await db.prepare(`SELECT * FROM users WHERE username = ?`).get(username.trim().toLowerCase());

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

    if (!user.email_verified) {
      return res.render('auth/login', {
        user: null,
        error: 'Tu cuenta todavía no está verificada. Revisá tu correo y confirmá tu email para poder ingresar, o reenviá el enlace de verificación.',
        success: null,
        unverifiedUsername: user.username
      });
    }

    let clubName = '';
    if (user.club_id) {
      const club = await db.prepare(`SELECT name FROM clubs WHERE id = ?`).get(user.club_id);
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

// GET: Public Registration Form
router.get('/registro', (req, res) => {
  if (req.session && req.session.user) {
    return redirectRole(req.session.user.role, res);
  }

  res.render('auth/registro', {
    user: null,
    error: req.query.error || null,
    success: req.query.success || null,
    verificationLink: null,
    form: null
  });
});

// POST: Public Registration with Email Verification
router.post('/registro', async (req, res) => {
  const { full_name, email, username, password, confirm_password, phone, club_id } = req.body;

  if (!full_name || !email || !username || !password || !confirm_password) {
    return res.render('auth/registro', {
      user: null,
      error: 'Complete todos los campos obligatorios.',
      success: null,
      verificationLink: null,
      form: req.body
    });
  }

  if (password !== confirm_password) {
    return res.render('auth/registro', {
      user: null,
      error: 'Las contraseñas no coinciden.',
      success: null,
      verificationLink: null,
      form: req.body
    });
  }

  if (password.length < 6) {
    return res.render('auth/registro', {
      user: null,
      error: 'La contraseña debe tener al menos 6 caracteres.',
      success: null,
      verificationLink: null,
      form: req.body
    });
  }

  const normalizedUsername = username.trim().toLowerCase();
  const normalizedEmail = email.trim().toLowerCase();

  try {
    const existingUser = await db.prepare(`SELECT id FROM users WHERE username = ?`).get(normalizedUsername);
    if (existingUser) {
      return res.render('auth/registro', {
        user: null,
        error: 'El nombre de usuario ya está en uso. Elegí otro.',
        success: null,
        verificationLink: null,
        form: req.body
      });
    }

    const existingEmail = await db.prepare(`SELECT id FROM users WHERE LOWER(email) = ?`).get(normalizedEmail);
    if (existingEmail) {
      return res.render('auth/registro', {
        user: null,
        error: 'Ya existe una cuenta registrada con ese correo electrónico. Si no recordás tu contraseña, usá "Restablecer contraseña".',
        success: null,
        verificationLink: null,
        form: req.body
      });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const info = await db.prepare(`
      INSERT INTO users (username, password_hash, full_name, role, club_id, email, phone, email_verified)
      VALUES (?, ?, ?, 'profesor', ?, ?, ?, false) RETURNING id
    `).run(normalizedUsername, passwordHash, full_name.trim().toUpperCase(), club_id || null, normalizedEmail, phone || '');

    if (club_id) {
      await db.prepare(`INSERT INTO user_clubs (user_id, club_id) VALUES (?, ?) ON CONFLICT DO NOTHING`).run(info.lastInsertRowid, club_id);
    }

    // Generate verification token (24h)
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await db.prepare(`
      INSERT INTO email_verifications (user_id, token, expires_at)
      VALUES (?, ?, ?)
    `).run(info.lastInsertRowid, token, expiresAt);

    const verifyPath = `/auth/verificar-email?token=${token}`;
    const { sent, fullUrl } = await sendVerificationEmail(normalizedEmail, verifyPath, req);

    let successMsg = `¡Registro exitoso, ${full_name.trim()}! Tu cuenta está creada pero necesita verificación.`;
    if (sent) {
      successMsg += ` Enviamos un correo a ${normalizedEmail}. Abrí el enlace para confirmar tu email y poder ingresar.`;
    } else {
      successMsg += ` Como el servidor de correo no está configurado todavía, este es tu enlace de verificación:`;
    }

    res.render('auth/registro', {
      user: null,
      error: null,
      success: successMsg,
      verificationLink: sent ? null : fullUrl,
      form: null
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.render('auth/registro', {
      user: null,
      error: 'Error interno al crear la cuenta. Intentalo nuevamente.',
      success: null,
      verificationLink: null,
      form: req.body
    });
  }
});

// GET: Verify Email with Token
router.get('/verificar-email', async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.redirect('/auth/login?error=' + encodeURIComponent('Enlace de verificación inválido.'));
  }

  const record = await db.prepare(`SELECT * FROM email_verifications WHERE token = ?`).get(token);
  if (!record) {
    return res.redirect('/auth/login?error=' + encodeURIComponent('El enlace de verificación es inválido o ya fue utilizado.'));
  }

  if (new Date(record.expires_at) < new Date()) {
    await db.prepare(`DELETE FROM email_verifications WHERE token = ?`).run(token);
    return res.redirect('/auth/login?error=' + encodeURIComponent('El enlace de verificación ha expirado. Ingresá con tu usuario y reenviá el enlace.'));
  }

  await db.prepare(`UPDATE users SET email_verified = true WHERE id = ?`).run(record.user_id);
  await db.prepare(`DELETE FROM email_verifications WHERE user_id = ?`).run(record.user_id);

  res.redirect('/auth/login?success=' + encodeURIComponent('✅ Email verificado correctamente. Ya podés ingresar con tu usuario y contraseña.'));
});

// POST: Resend Verification Email
router.post('/reenviar-verificacion', async (req, res) => {
  const { email_or_username } = req.body;

  if (!email_or_username) {
    return res.render('auth/login', {
      user: null,
      error: 'Ingrese su email o nombre de usuario.',
      success: null
    });
  }

  const queryTerm = email_or_username.trim().toLowerCase();
  const user = await db.prepare(`
    SELECT * FROM users
    WHERE LOWER(username) = ? OR LOWER(email) = ?
  `).get(queryTerm, queryTerm);

  if (!user || user.email_verified) {
    return res.redirect('/auth/login?error=' + encodeURIComponent('No se encontró una cuenta pendiente de verificación con esos datos.'));
  }

  await db.prepare(`DELETE FROM email_verifications WHERE user_id = ?`).run(user.id);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await db.prepare(`
    INSERT INTO email_verifications (user_id, token, expires_at)
    VALUES (?, ?, ?)
  `).run(user.id, token, expiresAt);

  const emailTarget = user.email || `${user.username}@stardance.com.ar`;
  const verifyPath = `/auth/verificar-email?token=${token}`;
  const { sent, fullUrl } = await sendVerificationEmail(emailTarget, verifyPath, req);

  res.redirect('/auth/login?success=' + encodeURIComponent(
    sent
      ? `Se reenvió el enlace de verificación a ${user.email}. Revisá tu correo.`
      : `Enlace de verificación regenerado para ${user.username}.`
  ));
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
  const user = await db.prepare(`
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
  await db.prepare(`DELETE FROM password_resets WHERE user_id = ?`).run(user.id);

  // Generate random token valid for 1 hour
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  await db.prepare(`
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
router.get('/restablecer-password', async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.redirect('/auth/login?error=' + encodeURIComponent('Enlace de restablecimiento inválido.'));
  }

  const resetRecord = await db.prepare(`SELECT * FROM password_resets WHERE token = ?`).get(token);
  if (!resetRecord) {
    return res.redirect('/auth/login?error=' + encodeURIComponent('El enlace de restablecimiento es inválido o ya fue utilizado.'));
  }

  if (new Date(resetRecord.expires_at) < new Date()) {
    await db.prepare(`DELETE FROM password_resets WHERE token = ?`).run(token);
    return res.redirect('/auth/olvide-password?error=' + encodeURIComponent('El enlace ha expirado. Por favor solicite uno nuevo.'));
  }

  res.render('auth/restablecer_password', {
    user: null,
    token,
    error: null
  });
});

// POST: Save New Password
router.post('/restablecer-password', async (req, res) => {
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

  const resetRecord = await db.prepare(`SELECT * FROM password_resets WHERE token = ?`).get(token);
  if (!resetRecord || new Date(resetRecord.expires_at) < new Date()) {
    return res.redirect('/auth/login?error=' + encodeURIComponent('El enlace expiró o es inválido.'));
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  await db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(passwordHash, resetRecord.user_id);
  await db.prepare(`DELETE FROM password_resets WHERE user_id = ?`).run(resetRecord.user_id);

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
module.exports.sendResetEmail = sendResetEmail;
module.exports.sendVerificationEmail = sendVerificationEmail;
