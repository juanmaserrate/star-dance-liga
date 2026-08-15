const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../database');
const { sendMail, logFallback, buildUrl } = require('../lib/mailer');

// Helper to send reset code email or log it
async function sendResetCode(email, code, req) {
  const sent = await sendMail({
    to: email,
    subject: '🔐 Código para restablecer contraseña - Liga Star Dance',
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px; color: #12061c;">
        <h2 style="color: #3b1959;">Liga Star Dance - Código de Verificación</h2>
        <p>Recibimos una solicitud para restablecer la contraseña de la cuenta registrada con el email: <strong>${email}</strong>.</p>
        <p>Usá el siguiente código para definir tu nueva contraseña (válido por 30 minutos):</p>
        <div style="margin: 25px 0; text-align: center;">
          <span style="background: #12061c; color: #d4af37; font-weight: bold; font-size: 1.8rem; letter-spacing: 6px; padding: 14px 24px; border-radius: 8px; display: inline-block;">${code}</span>
        </div>
        <p style="font-size: 0.85rem; color: #666;">Si no solicitaste este cambio, podés ignorar este correo de forma segura.</p>
      </div>
    `
  });

  if (!sent) logFallback('🔑 CÓDIGO DE RECUPERACIÓN GENERADO', email, `Código: ${code}`);

  return sent;
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

// Login POST (con email y contraseña)
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.render('auth/login', {
      user: null,
      error: 'Por favor complete el email y la contraseña.',
      success: null
    });
  }

  try {
    const user = await db.prepare(`SELECT * FROM users WHERE LOWER(email) = ?`).get(email.trim().toLowerCase());

    if (!user) {
      return res.render('auth/login', {
        user: null,
        error: 'Email o contraseña incorrectos.',
        success: null
      });
    }

    const isValid = bcrypt.compareSync(password, user.password_hash);
    if (!isValid) {
      return res.render('auth/login', {
        user: null,
        error: 'Email o contraseña incorrectos.',
        success: null
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
      admin_scope: user.admin_scope || null,
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

// POST: Public Registration (login automático, sin verificación de email)
router.post('/registro', async (req, res) => {
  const { full_name, email, password, phone } = req.body;

  if (!full_name || !email || !password) {
    return res.render('auth/registro', {
      user: null,
      error: 'Complete todos los campos obligatorios.',
      success: null,
      verificationLink: null,
      form: req.body
    });
  }

  if (String(password).length < 6) {
    return res.render('auth/registro', {
      user: null,
      error: 'La contraseña debe tener al menos 6 caracteres.',
      success: null,
      verificationLink: null,
      form: req.body
    });
  }

  // Parsear el club que el profesor crea en el registro (un club con su barrio)
  const rawNames = req.body.club_names || (req.body.club_name ? [req.body.club_name] : []);
  const rawCities = req.body.club_cities || (req.body.club_city ? [req.body.club_city] : []);
  const clubNamesArr = Array.isArray(rawNames) ? rawNames : [rawNames];
  const clubCitiesArr = Array.isArray(rawCities) ? rawCities : [rawCities];

  const cleanClubs = [];
  clubNamesArr.forEach((n, i) => {
    const name = (n || '').trim().toUpperCase();
    if (!name) return;
    cleanClubs.push({
      name,
      city: ((clubCitiesArr[i] || '') || '').trim().toUpperCase()
    });
  });

  if (cleanClubs.length === 0) {
    return res.render('auth/registro', {
      user: null,
      error: 'Debes crear al menos un club / escuela para tu cuenta.',
      success: null,
      verificationLink: null,
      form: req.body
    });
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
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
      VALUES (?, ?, ?, 'profesor', NULL, ?, ?, true) RETURNING id
    `).run(normalizedEmail, passwordHash, full_name.trim().toUpperCase(), normalizedEmail, phone || '');

    const userId = info.lastInsertRowid;
    const repName = full_name.trim().toUpperCase();
    let primaryClubId = null;

    // Crear (o vincular) cada club creado por el profesor en el registro
    for (const cl of cleanClubs) {
      let clubId;
      try {
        const ci = await db.prepare(`
          INSERT INTO clubs (name, representative, contact_phone, city)
          VALUES (?, ?, ?, ?) RETURNING id
        `).run(cl.name, repName, phone || '', cl.city);
        clubId = ci.lastInsertRowid;
      } catch (e) {
        const existing = await db.prepare(`SELECT id FROM clubs WHERE name = ?`).get(cl.name);
        if (existing) {
          clubId = existing.id;
        } else {
          throw e;
        }
      }
      await db.prepare(`INSERT INTO user_clubs (user_id, club_id) VALUES (?, ?) ON CONFLICT DO NOTHING`).run(userId, clubId);
      if (!primaryClubId) primaryClubId = clubId;
    }

    if (primaryClubId) {
      await db.prepare(`UPDATE users SET club_id = ? WHERE id = ?`).run(primaryClubId, userId);
    }

    // Login automático: crear la sesión del nuevo usuario
    let clubName = '';
    if (primaryClubId) {
      const club = await db.prepare(`SELECT name FROM clubs WHERE id = ?`).get(primaryClubId);
      if (club) clubName = club.name;
    }

    req.session.user = {
      id: userId,
      username: normalizedEmail,
      full_name: repName,
      role: 'profesor',
      club_id: primaryClubId,
      club_name: clubName,
      email: normalizedEmail
    };

    res.redirect('/profesor/dashboard?success=' + encodeURIComponent(
      `¡Bienvenido/a ${full_name.trim()}! Tu cuenta fue creada con éxito y ya iniciaste sesión.`
    ));
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
    resetCode: null
  });
});

// POST: Process Forgot Password Request (envía código por email)
router.post('/olvide-password', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.render('auth/olvide_password', {
      user: null,
      error: 'Ingresá tu email registrado.',
      success: null,
      resetCode: null
    });
  }

  const user = await db.prepare(`SELECT * FROM users WHERE LOWER(email) = ?`).get(email.trim().toLowerCase());

  if (!user) {
    // For security, show generic friendly response
    return res.render('auth/olvide_password', {
      user: null,
      error: null,
      success: 'Si el email existe en nuestro sistema, te enviamos un código para restablecer tu contraseña.',
      resetCode: null
    });
  }

  // Delete previous tokens for this user
  await db.prepare(`DELETE FROM password_resets WHERE user_id = ?`).run(user.id);

  // Generate 6-digit code valid for 30 minutes
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  await db.prepare(`
    INSERT INTO password_resets (user_id, token, expires_at)
    VALUES (?, ?, ?)
  `).run(user.id, code, expiresAt);

  const emailTarget = user.email || `${user.username}@stardance.com.ar`;
  const sent = await sendResetCode(emailTarget, code, req);

  let successMsg = `Se generó un código para ${user.email}.`;
  if (sent) {
    successMsg += ' Revisá tu correo e ingresalo en el siguiente paso.';
  } else {
    successMsg += ' Copialo a continuación e ingresalo en el siguiente paso:';
  }

  res.render('auth/olvide_password', {
    user: null,
    error: null,
    success: successMsg,
    resetCode: sent ? null : code
  });
});

// GET: Reset Password Form (con código; admite token legacy del admin)
router.get('/restablecer-password', async (req, res) => {
  const { token } = req.query;
  let email = '';
  let code = '';

  if (token) {
    const resetRecord = await db.prepare(`SELECT * FROM password_resets WHERE token = ?`).get(token);
    if (!resetRecord || new Date(resetRecord.expires_at) < new Date()) {
      await db.prepare(`DELETE FROM password_resets WHERE token = ?`).run(token);
      return res.redirect('/auth/olvide-password?error=' + encodeURIComponent('El código o enlace expiró o es inválido. Solicitalo de nuevo.'));
    }
    const u = await db.prepare(`SELECT email FROM users WHERE id = ?`).get(resetRecord.user_id);
    email = (u && u.email) || '';
    code = token;
  }

  res.render('auth/restablecer_password', {
    user: null,
    email,
    code,
    error: null
  });
});

// POST: Save New Password (valida email + código)
router.post('/restablecer-password', async (req, res) => {
  const { email, code, password, confirm_password } = req.body;

  if (!email || !code || !password || !confirm_password) {
    return res.render('auth/restablecer_password', {
      user: null,
      email: email || '',
      code: code || '',
      error: 'Por favor complete todos los campos.'
    });
  }

  if (password !== confirm_password) {
    return res.render('auth/restablecer_password', {
      user: null,
      email,
      code,
      error: 'Las contraseñas no coinciden.'
    });
  }

  const user = await db.prepare(`SELECT * FROM users WHERE LOWER(email) = ?`).get(email.trim().toLowerCase());
  if (!user) {
    return res.render('auth/restablecer_password', {
      user: null,
      email,
      code,
      error: 'No se encontró una cuenta con ese email.'
    });
  }

  const resetRecord = await db.prepare(`SELECT * FROM password_resets WHERE user_id = ? AND token = ?`).get(user.id, code.trim());
  if (!resetRecord || new Date(resetRecord.expires_at) < new Date()) {
    return res.render('auth/restablecer_password', {
      user: null,
      email,
      code,
      error: 'El código es inválido o expiró. Solicitalo de nuevo.'
    });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  await db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(passwordHash, user.id);
  await db.prepare(`DELETE FROM password_resets WHERE user_id = ?`).run(user.id);

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
  // El rol combinado entra primero por el módulo de profesora; desde ahí tiene
  // el acceso al panel de administración en el menú.
  if (role === 'profesor' || role === 'profesor_admin') return res.redirect('/profesor/dashboard');
  if (role === 'juez') return res.redirect('/juez/planilla');
  res.redirect('/');
}

module.exports = router;
module.exports.sendResetCode = sendResetCode;
module.exports.sendVerificationEmail = sendVerificationEmail;
