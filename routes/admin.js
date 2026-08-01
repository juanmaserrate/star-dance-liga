const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database');
const { requireAuth, requireRole } = require('../middleware/auth');

// All routes require role 'admin'
router.use(requireAuth, requireRole('admin'));

// Admin Dashboard
router.get('/dashboard', (req, res) => {
  const totalSkaters = db.prepare(`SELECT COUNT(*) as count FROM students`).get().count;
  const totalRegistrations = db.prepare(`SELECT COUNT(*) as count FROM registrations`).get().count;
  const totalClubs = db.prepare(`SELECT COUNT(*) as count FROM clubs`).get().count;
  const totalTournaments = db.prepare(`SELECT COUNT(*) as count FROM tournaments`).get().count;

  const paidStats = db.prepare(`
    SELECT 
      SUM(CASE WHEN r.payment_status = 'paid' THEN c.fee ELSE 0 END) as total_paid,
      SUM(CASE WHEN r.payment_status = 'pending' THEN c.fee ELSE 0 END) as total_pending
    FROM registrations r
    JOIN categories c ON r.category_id = c.id
  `).get();

  const registrationsByClub = db.prepare(`
    SELECT cl.name as club_name, COUNT(r.id) as count
    FROM registrations r
    JOIN clubs cl ON r.club_id = cl.id
    GROUP BY cl.id
    ORDER BY count DESC
  `).all();

  const recentRegistrations = db.prepare(`
    SELECT r.*, 
    s.first_name, s.last_name, s.dni,
    cl.name as club_name,
    t.name as tournament_name,
    c.name as category_name, c.fee
    FROM registrations r
    JOIN students s ON r.student_id = s.id
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
      totalPending: paidStats.total_pending || 0
    },
    registrationsByClub,
    recentRegistrations,
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// Master Registrations Table (Filterable & Payment toggle)
router.get('/inscripciones', (req, res) => {
  const { tournament_id, club_id, payment_status } = req.query;

  let query = `
    SELECT r.*, 
    s.first_name, s.last_name, s.dni, s.birth_date, s.health_insurance, s.policy_number, s.emergency_contact, s.emergency_phone,
    cl.name as club_name,
    t.name as tournament_name,
    c.name as category_name, c.discipline, c.level, c.fee,
    u.full_name as teacher_name,
    (SELECT COUNT(*) FROM student_documents d WHERE d.student_id = s.id) as doc_count
    FROM registrations r
    JOIN students s ON r.student_id = s.id
    JOIN clubs cl ON r.club_id = cl.id
    JOIN tournaments t ON r.tournament_id = t.id
    JOIN categories c ON r.category_id = c.id
    JOIN users u ON r.teacher_id = u.id
    WHERE 1=1
  `;
  const params = [];

  if (tournament_id) {
    query += ` AND r.tournament_id = ?`;
    params.push(tournament_id);
  }
  if (club_id) {
    query += ` AND r.club_id = ?`;
    params.push(club_id);
  }
  if (payment_status) {
    query += ` AND r.payment_status = ?`;
    params.push(payment_status);
  }

  query += ` ORDER BY r.created_at DESC`;

  const registrations = db.prepare(query).all(...params);
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

// Export CSV / Excel matching stardance.com.ar layout
router.get('/exportar/csv', (req, res) => {
  const { tournament_id, club_id, payment_status } = req.query;

  let query = `
    SELECT 
      t.name as Torneo,
      s.first_name as Nombre,
      s.last_name as Apellido,
      s.dni as DNI,
      COALESCE(s.cuil, '-') as CUIL,
      s.birth_date as Fecha_Nacimiento,
      (CAST(strftime('%Y', 'now') AS INT) - CAST(strftime('%Y', s.birth_date) AS INT)) as Edad,
      cl.name as Club,
      c.name as Categoria,
      c.discipline as Disciplina,
      u.full_name as Profesora_A_Cargo,
      u.email as Email_Profesora,
      u.phone as Celular_Profesora,
      COALESCE(s.health_insurance, '-') as Seguro_ObraSocial,
      COALESCE(s.policy_number, '-') as Nro_Poliza,
      r.payment_status as Estado_Pago
    FROM registrations r
    JOIN students s ON r.student_id = s.id
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

  // Generate CSV with UTF-8 BOM so Excel opens Spanish accents cleanly
  let csv = '\uFEFF'; // UTF-8 BOM
  if (rows.length > 0) {
    const headers = Object.keys(rows[0]);
    csv += headers.join(';') + '\n';
    rows.forEach(row => {
      const values = headers.map(h => `"${String(row[h] || '').replace(/"/g, '""')}"`);
      csv += values.join(';') + '\n';
    });
  } else {
    csv += 'Sin resultados\n';
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="Inscripciones_StarDance_${Date.now()}.csv"`);
  res.send(csv);
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
    `).run(name.trim(), description || '', venue.trim(), event_date, registration_deadline, status || 'upcoming');

    res.redirect(`/admin/torneos/${info.lastInsertRowid}/categorias?success=` + encodeURIComponent('Torneo creado. Ahora añada las categorías.'));
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

  const categories = db.prepare(`SELECT * FROM categories WHERE tournament_id = ? ORDER BY min_age ASC, level ASC`).all(tournament.id);

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
  const { name, discipline, level, min_age, max_age, gender, schedule, fee } = req.body;

  if (!name || !discipline || !level) {
    return res.redirect(`/admin/torneos/${tournamentId}/categorias?error=` + encodeURIComponent('Nombre, disciplina y nivel son requeridos.'));
  }

  try {
    db.prepare(`
      INSERT INTO categories (tournament_id, name, discipline, level, min_age, max_age, gender, schedule, fee)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tournamentId, name.trim(), discipline.trim(), level.trim(),
      parseInt(min_age) || 0, parseInt(max_age) || 99,
      gender || 'Mixto', schedule || '', parseFloat(fee) || 0
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
    (SELECT COUNT(*) FROM users u WHERE u.club_id = c.id AND u.role = 'profesor') as teacher_count
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
    `).run(name.trim(), representative || '', contact_phone || '', city || '');

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
    db.prepare(`
      INSERT INTO users (username, password_hash, full_name, role, club_id, email, phone)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(username.trim().toLowerCase(), password_hash, full_name.trim(), role, club_id || null, email || '', phone || '');

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

module.exports = router;
