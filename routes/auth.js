const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database');

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

    // Get club info if available
    let clubName = '';
    if (user.club_id) {
      const club = db.prepare(`SELECT name FROM clubs WHERE id = ?`).get(user.club_id);
      if (club) clubName = club.name;
    }

    // Session save
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
