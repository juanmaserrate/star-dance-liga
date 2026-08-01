const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database');
const { requireAuth, requireRole } = require('../middleware/auth');

// All routes require role 'admin'
router.use(requireAuth, requireRole('admin'));

// Helper: Calculate age from birth date in calendar year
function getCalendarAge(birthDateStr) {
  if (!birthDateStr) return 0;
  const birthYear = new Date(birthDateStr).getFullYear();
  const currentYear = new Date().getFullYear();
  return Math.max(0, currentYear - birthYear);
}

// Admin Dashboard
router.get('/dashboard', (req, res) => {
  const totalSkaters = db.prepare(`SELECT COUNT(*) as count FROM students`).get().count;
  const totalRegistrations = db.prepare(`SELECT COUNT(*) as count FROM registrations`).get().count;
  const totalClubs = db.prepare(`SELECT COUNT(*) as count FROM clubs`).get().count;
  const totalTournaments = db.prepare(`SELECT COUNT(*) as count FROM tournaments`).get().count;

  const paidStats = db.prepare(`
    SELECT 
      SUM(CASE WHEN payment_status = 'paid' THEN final_fee ELSE 0 END) as total_paid,
      SUM(CASE WHEN payment_status = 'pending' THEN final_fee ELSE 0 END) as total_pending,
      SUM(discount_amount) as total_discounts
    FROM registrations
  `).get();

  const totalExpenses = db.prepare(`SELECT SUM(amount) as sum FROM tournament_expenses`).get().sum || 0;

  const registrationsByClub = db.prepare(`
    SELECT cl.name as club_name, COUNT(r.id) as count
    FROM registrations r
    JOIN clubs cl ON r.club_id = cl.id
    GROUP BY cl.id
    ORDER BY count DESC
  `).all();

  const recentRegistrations = db.prepare(`
    SELECT r.*, 
    COALESCE(s.first_name, r.group_name) as first_name,
    COALESCE(s.last_name, '') as last_name,
    cl.name as club_name,
    t.name as tournament_name,
    c.name as category_name
    FROM registrations r
    LEFT JOIN students s ON r.student_id = s.id
    JOIN clubs cl ON r.club_id = cl.id
    JOIN tournaments t ON r.tournament_id = t.id
    JOIN categories c ON r.category_id = c.id
    ORDER BY r.created_at DESC LIMIT 10
  `).all();

  res.render('admin/dashboard', {
    user: req.session.user,
    stats: {
      totalSkaters,
      totalRegistrations,
      totalClubs,
      totalTournaments,
      totalPaid: paidStats.total_paid || 0,
      totalPending: paidStats.total_pending || 0,
      totalDiscounts: paidStats.total_discounts || 0,
      totalExpenses
    },
    registrationsByClub,
    recentRegistrations,
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// Master Registrations Table (With Filters, Payment Toggle & Discount Manager)
router.get('/inscripciones', (req, res) => {
  const { tournament_id, club_id, payment_status } = req.query;

  let query = `
    SELECT r.*, 
    s.first_name, s.last_name, s.dni, s.birth_date, s.health_insurance, s.policy_number, s.emergency_contact, s.emergency_phone,
    cl.name as club_name,
    t.name as tournament_name,
    c.name as category_name, c.discipline, c.division as level, c.fee,
    u.full_name as teacher_name,
    (SELECT COUNT(*) FROM student_documents d WHERE d.student_id = s.id) as doc_count
    FROM registrations r
    LEFT JOIN students s ON r.student_id = s.id
    JOIN clubs cl ON r.club_id = cl.id
    JOIN tournaments t ON r.tournament_id = t.id
    JOIN categories c ON r.category_id = c.id
    JOIN users u ON r.teacher_id = u.id
    WHERE 1=1
  `;
  const params = [];

  if (tournament_id) { query += ` AND r.tournament_id = ?`; params.push(tournament_id); }
  if (club_id) { query += ` AND r.club_id = ?`; params.push(club_id); }
  if (payment_status) { query += ` AND r.payment_status = ?`; params.push(payment_status); }

  query += ` ORDER BY r.created_at DESC`;

  const registrations = db.prepare(query).all(...params);
  registrations.forEach(r => {
    if (r.birth_date) r.age = getCalendarAge(r.birth_date);
  });

  const tournaments = db.prepare(`SELECT * FROM tournaments ORDER BY event_date DESC`).all();
  const clubs = db.prepare(`SELECT * FROM clubs ORDER BY name ASC`).all();

  res.render('admin/inscripciones', {
    user: req.session.user,
    registrations,
    tournaments,
    clubs,
    selectedTournament: tournament_id || '',
    selectedClub: club_id || '',
    selectedPayment: payment_status || '',
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// Toggle Payment Status
router.post('/inscripciones/:id/pago', (req, res) => {
  const regId = req.params.id;
  const reg = db.prepare(`SELECT payment_status FROM registrations WHERE id = ?`).get(regId);

  if (reg) {
    const newStatus = reg.payment_status === 'paid' ? 'pending' : 'paid';
    const paymentDate = newStatus === 'paid' ? new Date().toISOString() : null;
    db.prepare(`UPDATE registrations SET payment_status = ?, payment_date = ? WHERE id = ?`).run(newStatus, paymentDate, regId);
  }

  const referer = req.header('Referer') || '/admin/inscripciones';
  res.redirect(referer);
});

// Apply Discount / Bonificación
router.post('/inscripciones/:id/descuento', (req, res) => {
  const regId = req.params.id;
  const { discount_amount, discount_reason } = req.body;

  const reg = db.prepare(`SELECT original_fee FROM registrations WHERE id = ?`).get(regId);
  if (reg) {
    const disc = parseFloat(discount_amount) || 0;
    const finalFee = Math.max(0, reg.original_fee - disc);

    db.prepare(`
      UPDATE registrations SET discount_amount = ?, discount_reason = ?, final_fee = ?
      WHERE id = ?
    `).run(disc, (discount_reason || '').toUpperCase(), finalFee, regId);
  }

  res.redirect('/admin/inscripciones?success=' + encodeURIComponent('Bonificación / Descuento aplicado correctamente.'));
});

// Export CSV / Excel (UPPERCASE Headers & Fields matching production)
router.get('/exportar/csv', (req, res) => {
  const { tournament_id, club_id, payment_status } = req.query;

  let query = `
    SELECT 
      t.name as TORNEO,
      COALESCE(s.first_name, r.group_name) as NOMBRE,
      COALESCE(s.last_name, 'GRUPO') as APELLIDO,
      COALESCE(s.dni, '-') as DNI,
      COALESCE(s.cuil, '-') as CUIL,
      COALESCE(s.birth_date, '-') as FECHA_NACIMIENTO,
      CASE WHEN s.birth_date IS NOT NULL THEN (CAST(strftime('%Y', 'now') AS INT) - CAST(strftime('%Y', s.birth_date) AS INT)) ELSE 0 END as EDAD,
      cl.name as CLUB,
      c.name as CATEGORÍA,
      c.discipline as DISCIPLINA,
      u.full_name as PROFESORA_A_CARGO,
      u.email as EMAIL_PROFESORA,
      u.phone as CELULAR_PROFESORA,
      COALESCE(s.health_insurance, '-') as SEGURO_OBRA_SOCIAL,
      COALESCE(s.policy_number, '-') as NRO_PÓLIZA,
      r.original_fee as ARANCEL_BASE,
      r.discount_amount as BONIFICACIÓN,
      r.final_fee as ARANCEL_FINAL,
      r.payment_status as ESTADO_PAGO
    FROM registrations r
    LEFT JOIN students s ON r.student_id = s.id
    JOIN clubs cl ON r.club_id = cl.id
    JOIN tournaments t ON r.tournament_id = t.id
    JOIN categories c ON r.category_id = c.id
    JOIN users u ON r.teacher_id = u.id
    WHERE 1=1
  `;
  const params = [];

  if (tournament_id) { query += ` AND r.tournament_id = ?`; params.push(tournament_id); }
  if (club_id) { query += ` AND r.club_id = ?`; params.push(club_id); }
  if (payment_status) { query += ` AND r.payment_status = ?`; params.push(payment_status); }

  query += ` ORDER BY t.name, cl.name, s.last_name`;

  const rows = db.prepare(query).all(...params);

  // Generate CSV with UTF-8 BOM so Excel opens Spanish accents cleanly in UPPERCASE
  let csv = '\uFEFF';
  if (rows.length > 0) {
    const headers = Object.keys(rows[0]);
    csv += headers.join(';') + '\n';
    rows.forEach(row => {
      const values = headers.map(h => `"${String(row[h] || '').toUpperCase().replace(/"/g, '""')}"`);
      csv += values.join(';') + '\n';
    });
  } else {
    csv += 'SIN RESULTADOS\n';
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="INSCRIPCIONES_STAR_DANCE_${Date.now()}.csv"`);
  res.send(csv);
});

// Admin Financial Forecast & Expense Tracker Module
router.get('/finanzas', (req, res) => {
  const tournaments = db.prepare(`SELECT * FROM tournaments ORDER BY event_date DESC`).all();
  const selectedTournamentId = req.query.tournament_id || (tournaments.length > 0 ? tournaments[0].id : null);

  let expenses = [];
  let revenueStats = { total_gross: 0, total_discounts: 0, total_net: 0, total_paid: 0, total_pending: 0 };

  if (selectedTournamentId) {
    expenses = db.prepare(`SELECT * FROM tournament_expenses WHERE tournament_id = ? ORDER BY expense_date DESC`).all(selectedTournamentId);

    revenueStats = db.prepare(`
      SELECT 
        SUM(original_fee) as total_gross,
        SUM(discount_amount) as total_discounts,
        SUM(final_fee) as total_net,
        SUM(CASE WHEN payment_status = 'paid' THEN final_fee ELSE 0 END) as total_paid,
        SUM(CASE WHEN payment_status = 'pending' THEN final_fee ELSE 0 END) as total_pending
      FROM registrations
      WHERE tournament_id = ?
    `).get(selectedTournamentId) || revenueStats;
  }

  const totalExpenses = expenses.reduce((sum, e) => sum + (e.amount || 0), 0);
  const projectedProfit = (revenueStats.total_net || 0) - totalExpenses;

  res.render('admin/finanzas', {
    user: req.session.user,
    tournaments,
    selectedTournamentId,
    expenses,
    revenueStats,
    totalExpenses,
    projectedProfit,
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// Add Tournament Expense
router.post('/finanzas/gastos', (req, res) => {
  const { tournament_id, expense_category, description, amount, expense_date } = req.body;

  if (!tournament_id || !expense_category || !description || !amount) {
    return res.redirect('/admin/finanzas?error=' + encodeURIComponent('Todos los campos del gasto son requeridos.'));
  }

  try {
    db.prepare(`
      INSERT INTO tournament_expenses (tournament_id, expense_category, description, amount, expense_date)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      tournament_id,
      expense_category,
      description.trim().toUpperCase(),
      parseFloat(amount) || 0,
      expense_date || new Date().toISOString().split('T')[0]
    );

    res.redirect(`/admin/finanzas?tournament_id=${tournament_id}&success=` + encodeURIComponent('Gasto registrado en el presupuesto del torneo.'));
  } catch (err) {
    console.error('Error adding expense:', err);
    res.redirect('/admin/finanzas?error=' + encodeURIComponent('Error al registrar gasto.'));
  }
});

// Annual Leaderboards & Scores Overview
router.get('/posiciones', (req, res) => {
  const clubLeaderboard = db.prepare(`
    SELECT cl.name as club_name, cl.city,
    SUM(cs.points) as total_points,
    COUNT(DISTINCT cs.tournament_id) as tournaments_participated
    FROM club_scores cs
    JOIN clubs cl ON cs.club_id = cl.id
    GROUP BY cl.id
    ORDER BY total_points DESC
  `).all();

  res.render('admin/posiciones', {
    user: req.session.user,
    clubLeaderboard
  });
});

// Manage Tournaments List
router.get('/torneos', (req, res) => {
  const tournaments = db.prepare(`
    SELECT t.*, 
    (SELECT COUNT(*) FROM categories c WHERE c.tournament_id = t.id) as category_count,
    (SELECT COUNT(*) FROM registrations r WHERE r.tournament_id = t.id) as reg_count
    FROM tournaments t
    ORDER BY t.event_date DESC
  `).all();

  res.render('admin/torneos', {
    user: req.session.user,
    tournaments,
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// Form: New Tournament
router.get('/torneos/nuevo', (req, res) => {
  res.render('admin/torneo_form', {
    user: req.session.user,
    tournament: null,
    error: null
  });
});

// Save Tournament
router.post('/torneos/nuevo', (req, res) => {
  const { name, description, venue, event_date, registration_deadline, status } = req.body;

  if (!name || !venue || !event_date || !registration_deadline) {
    return res.render('admin/torneo_form', {
      user: req.session.user,
      tournament: req.body,
      error: 'Por favor complete los campos obligatorios del torneo.'
    });
  }

  try {
    const info = db.prepare(`
      INSERT INTO tournaments (name, description, venue, event_date, registration_deadline, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(name.trim().toUpperCase(), (description || '').toUpperCase(), venue.trim().toUpperCase(), event_date, registration_deadline, status || 'upcoming');

    res.redirect(`/admin/torneos/${info.lastInsertRowid}/categorias?success=` + encodeURIComponent('Torneo creado. Configure las categorías.'));
  } catch (err) {
    console.error('Error creating tournament:', err);
    res.render('admin/torneo_form', {
      user: req.session.user,
      tournament: req.body,
      error: 'Error al guardar el torneo.'
    });
  }
});

// Category Builder for a Tournament
router.get('/torneos/:id/categorias', (req, res) => {
  const tournament = db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(req.params.id);
  if (!tournament) return res.status(404).render('error', { title: 'Torneo No Encontrado' });

  const categories = db.prepare(`SELECT * FROM categories WHERE tournament_id = ? ORDER BY discipline ASC, min_age ASC, division ASC`).all(tournament.id);

  res.render('admin/categorias', {
    user: req.session.user,
    tournament,
    categories,
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// Save Category
router.post('/torneos/:id/categorias', (req, res) => {
  const tournamentId = req.params.id;
  const { name, discipline, division, level, min_age, max_age, gender, schedule, fee } = req.body;

  if (!name || !discipline) {
    return res.redirect(`/admin/torneos/${tournamentId}/categorias?error=` + encodeURIComponent('Nombre y disciplina son requeridos.'));
  }

  try {
    db.prepare(`
      INSERT INTO categories (tournament_id, name, discipline, division, level, min_age, max_age, gender, schedule, fee)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tournamentId,
      name.trim().toUpperCase(),
      discipline.trim().toUpperCase(),
      (division || '').toUpperCase(),
      (level || '').toUpperCase(),
      parseInt(min_age) || 0,
      parseInt(max_age) || 99,
      gender || 'MIXTO',
      (schedule || '').toUpperCase(),
      parseFloat(fee) || 0
    );

    res.redirect(`/admin/torneos/${tournamentId}/categorias?success=` + encodeURIComponent('Categoría agregada correctamente al torneo.'));
  } catch (err) {
    console.error('Error creating category:', err);
    res.redirect(`/admin/torneos/${tournamentId}/categorias?error=` + encodeURIComponent('Error al agregar categoría.'));
  }
});

// Manage Clubs
router.get('/clubes', (req, res) => {
  const clubs = db.prepare(`
    SELECT c.*, 
    (SELECT COUNT(*) FROM students s WHERE s.club_id = c.id) as student_count,
    (SELECT COUNT(*) FROM user_clubs uc WHERE uc.club_id = c.id) as teacher_count
    FROM clubs c
    ORDER BY c.name ASC
  `).all();

  res.render('admin/clubes', {
    user: req.session.user,
    clubs,
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// Save Club
router.post('/clubes', (req, res) => {
  const { name, representative, contact_phone, city } = req.body;
  if (!name) return res.redirect('/admin/clubes?error=' + encodeURIComponent('El nombre del club es obligatorio.'));

  try {
    db.prepare(`
      INSERT INTO clubs (name, representative, contact_phone, city)
      VALUES (?, ?, ?, ?)
    `).run(name.trim().toUpperCase(), (representative || '').toUpperCase(), contact_phone || '', (city || '').toUpperCase());

    res.redirect('/admin/clubes?success=' + encodeURIComponent('Club registrado exitosamente.'));
  } catch (err) {
    console.error('Error adding club:', err);
    res.redirect('/admin/clubes?error=' + encodeURIComponent('Error al registrar club.'));
  }
});

// Manage Users (Admins, Teachers, Judges)
router.get('/usuarios', (req, res) => {
  const usersList = db.prepare(`
    SELECT u.*, c.name as club_name
    FROM users u
    LEFT JOIN clubs c ON u.club_id = c.id
    ORDER BY u.role ASC, u.full_name ASC
  `).all();

  const clubs = db.prepare(`SELECT * FROM clubs ORDER BY name ASC`).all();

  res.render('admin/usuarios', {
    user: req.session.user,
    usersList,
    clubs,
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// Create New User
router.post('/usuarios', (req, res) => {
  const { username, password, full_name, role, club_id, email, phone } = req.body;

  if (!username || !password || !full_name || !role) {
    return res.redirect('/admin/usuarios?error=' + encodeURIComponent('Complete todos los campos obligatorios del usuario.'));
  }

  try {
    const password_hash = bcrypt.hashSync(password, 10);
    const info = db.prepare(`
      INSERT INTO users (username, password_hash, full_name, role, club_id, email, phone)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(username.trim().toLowerCase(), password_hash, full_name.trim().toUpperCase(), role, club_id || null, (email || '').toUpperCase(), phone || '');

    if (club_id) {
      db.prepare(`INSERT OR IGNORE INTO user_clubs (user_id, club_id) VALUES (?, ?)`).run(info.lastInsertRowid, club_id);
    }

    res.redirect('/admin/usuarios?success=' + encodeURIComponent(`Usuario ${username} creado correctamente.`));
  } catch (err) {
    console.error('Error creating user:', err);
    let msg = 'Error al crear usuario.';
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      msg = 'El nombre de usuario ya existe.';
    }
    res.redirect('/admin/usuarios?error=' + encodeURIComponent(msg));
  }
});

// View Student Documents (Admin Inspector)
router.get('/alumnos/:id/documentos', (req, res) => {
  const student = db.prepare(`
    SELECT s.*, c.name as club_name, u.full_name as teacher_name
    FROM students s
    JOIN clubs c ON s.club_id = c.id
    JOIN users u ON s.teacher_id = u.id
    WHERE s.id = ?
  `).get(req.params.id);

  if (!student) return res.status(404).render('error', { title: 'Alumno no encontrado' });

  const documents = db.prepare(`SELECT * FROM student_documents WHERE student_id = ?`).all(student.id);

  res.render('admin/alumno_docs', {
    user: req.session.user,
    student,
    documents
  });
});

// CMS Admin Control Panel for Public Home Page
router.get('/cms', (req, res) => {
  const getSetting = (key) => {
    const row = db.prepare(`SELECT value FROM site_settings WHERE key = ?`).get(key);
    return row ? row.value : '';
  };

  const hero_title = getSetting('hero_title') || 'LIGA DE PATINAJE ARTÍSTICO STAR DANCE';
  const hero_subtitle = getSetting('hero_subtitle') || 'Plataforma oficial de gestión de torneos, cuerpo de jueces e inscripciones.';
  const about_title = getSetting('about_title') || 'SOBRE LA LIGA STAR DANCE Y NUESTRO PROPÓSITO';
  const about_content = getSetting('about_content') || 'La Liga Star Dance nace con la misión de impulsar y promover el Patinaje Artístico sobre ruedas...';

  const slides = db.prepare(`SELECT * FROM home_slides ORDER BY order_index ASC`).all();
  const judges = db.prepare(`SELECT * FROM judge_profiles ORDER BY order_index ASC`).all();
  const disciplines = db.prepare(`SELECT * FROM discipline_info ORDER BY order_index ASC`).all();

  res.render('admin/cms', {
    user: req.session.user,
    cms: {
      hero_title,
      hero_subtitle,
      about_title,
      about_content,
      slides,
      judges,
      disciplines
    },
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// Update Hero Title & Subtitle
router.post('/cms/hero', (req, res) => {
  const { hero_title, hero_subtitle } = req.body;
  const setSetting = db.prepare(`INSERT OR REPLACE INTO site_settings (key, value) VALUES (?, ?)`);
  setSetting.run('hero_title', (hero_title || '').toUpperCase());
  setSetting.run('hero_subtitle', hero_subtitle || '');

  res.redirect('/admin/cms?success=' + encodeURIComponent('Banner principal de la Home actualizado.'));
});

// Update About Us / Purpose
router.post('/cms/about', (req, res) => {
  const { about_title, about_content } = req.body;
  const setSetting = db.prepare(`INSERT OR REPLACE INTO site_settings (key, value) VALUES (?, ?)`);
  setSetting.run('about_title', (about_title || '').toUpperCase());
  setSetting.run('about_content', about_content || '');

  res.redirect('/admin/cms?success=' + encodeURIComponent('Sección Sobre la Liga y Propósito actualizada.'));
});

// Add New Slide Banner
router.post('/cms/slides', (req, res) => {
  const { title, subtitle, image_url, button_text, button_link } = req.body;
  if (!title) return res.redirect('/admin/cms?error=' + encodeURIComponent('El título del slide es requerido.'));

  try {
    db.prepare(`
      INSERT INTO home_slides (title, subtitle, image_url, button_text, button_link)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      title.toUpperCase(),
      subtitle || '',
      image_url || '/img/logo.svg',
      (button_text || 'VER MÁS').toUpperCase(),
      button_link || '/torneos'
    );
    res.redirect('/admin/cms?success=' + encodeURIComponent('Nuevo slide/banner agregado a la portada.'));
  } catch (err) {
    console.error('Error adding slide:', err);
    res.redirect('/admin/cms?error=' + encodeURIComponent('Error al agregar slide.'));
  }
});

// Delete Slide Banner
router.post('/cms/slides/:id/eliminar', (req, res) => {
  db.prepare(`DELETE FROM home_slides WHERE id = ?`).run(req.params.id);
  res.redirect('/admin/cms?success=' + encodeURIComponent('Slide eliminado de la portada.'));
});

// Add Judge Profile with Photo & Info
router.post('/cms/jueces', (req, res) => {
  const { name, title, photo_url, bio, specialty } = req.body;
  if (!name || !title) return res.redirect('/admin/cms?error=' + encodeURIComponent('Nombre y título del juez son requeridos.'));

  try {
    db.prepare(`
      INSERT INTO judge_profiles (name, title, photo_url, bio, specialty)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      name.toUpperCase(),
      title.toUpperCase(),
      photo_url || '/img/logo.svg',
      bio || '',
      (specialty || '').toUpperCase()
    );
    res.redirect('/admin/cms?success=' + encodeURIComponent('Perfil de juez agregado al sitio público.'));
  } catch (err) {
    console.error('Error adding judge:', err);
    res.redirect('/admin/cms?error=' + encodeURIComponent('Error al agregar juez.'));
  }
});

// Delete Judge Profile
router.post('/cms/jueces/:id/eliminar', (req, res) => {
  db.prepare(`DELETE FROM judge_profiles WHERE id = ?`).run(req.params.id);
  res.redirect('/admin/cms?success=' + encodeURIComponent('Perfil de juez eliminado.'));
});

// Add Discipline Public Info Card
router.post('/cms/disciplinas', (req, res) => {
  const { name, description, icon } = req.body;
  if (!name || !description) return res.redirect('/admin/cms?error=' + encodeURIComponent('Nombre y descripción son requeridos.'));

  try {
    db.prepare(`
      INSERT INTO discipline_info (name, description, icon)
      VALUES (?, ?, ?)
    `).run(name.toUpperCase(), description, icon || '⛸️');

    res.redirect('/admin/cms?success=' + encodeURIComponent('Tarjeta informativa de disciplina agregada.'));
  } catch (err) {
    console.error('Error adding discipline info:', err);
    res.redirect('/admin/cms?error=' + encodeURIComponent('Error al agregar disciplina.'));
  }
});

module.exports = router;
