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
router.get('/dashboard', async (req, res) => {
  const totalSkaters = (await db.prepare(`SELECT COUNT(*) as count FROM students`).get()).count;
  const totalRegistrations = (await db.prepare(`SELECT COUNT(*) as count FROM registrations`).get()).count;
  const totalClubs = (await db.prepare(`SELECT COUNT(*) as count FROM clubs`).get()).count;
  const totalTournaments = (await db.prepare(`SELECT COUNT(*) as count FROM tournaments`).get()).count;

  const paidStats = await db.prepare(`
    SELECT
      SUM(CASE WHEN payment_status = 'paid' THEN final_fee ELSE 0 END) as total_paid,
      SUM(CASE WHEN payment_status = 'pending' THEN final_fee ELSE 0 END) as total_pending,
      SUM(discount_amount) as total_discounts
    FROM registrations
  `).get();

  const totalExpenses = (await db.prepare(`SELECT SUM(amount) as sum FROM tournament_expenses`).get()).sum || 0;

  const registrationsByClub = await db.prepare(`
    SELECT cl.name as club_name, COUNT(r.id) as count
    FROM registrations r
    JOIN clubs cl ON r.club_id = cl.id
    GROUP BY cl.id
    ORDER BY count DESC
  `).all();

  const recentRegistrations = await db.prepare(`
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

  const studentsList = await db.prepare(`
    SELECT s.*,
    c.name as club_name,
    u.full_name as teacher_name,
    (SELECT COUNT(*) FROM student_documents d WHERE d.student_id = s.id) as doc_count,
    (SELECT COUNT(*) FROM registrations r WHERE r.student_id = s.id) as reg_count
    FROM students s
    JOIN clubs c ON s.club_id = c.id
    JOIN users u ON s.teacher_id = u.id
    ORDER BY s.last_name ASC, s.first_name ASC
  `).all();
  studentsList.forEach(s => { s.age = getCalendarAge(s.birth_date); });

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
    studentsList,
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// Master Registrations Table (With Filters, Payment Toggle & Discount Manager)
router.get('/inscripciones', async (req, res) => {
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

  const registrations = await db.prepare(query).all(...params);
  registrations.forEach(r => {
    if (r.birth_date) r.age = getCalendarAge(r.birth_date);
  });

  const tournaments = await db.prepare(`SELECT * FROM tournaments ORDER BY event_date DESC`).all();
  const clubs = await db.prepare(`SELECT * FROM clubs ORDER BY name ASC`).all();

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
router.post('/inscripciones/:id/pago', async (req, res) => {
  const regId = req.params.id;
  const reg = await db.prepare(`SELECT payment_status FROM registrations WHERE id = ?`).get(regId);

  if (reg) {
    const newStatus = reg.payment_status === 'paid' ? 'pending' : 'paid';
    const paymentDate = newStatus === 'paid' ? new Date().toISOString() : null;
    await db.prepare(`UPDATE registrations SET payment_status = ?, payment_date = ? WHERE id = ?`).run(newStatus, paymentDate, regId);
  }

  const referer = req.header('Referer') || '/admin/inscripciones';
  res.redirect(referer);
});

// Apply Discount / Bonificación
router.post('/inscripciones/:id/descuento', async (req, res) => {
  const regId = req.params.id;
  const { discount_amount, discount_reason } = req.body;

  const reg = await db.prepare(`SELECT original_fee FROM registrations WHERE id = ?`).get(regId);
  if (reg) {
    const disc = parseFloat(discount_amount) || 0;
    const finalFee = Math.max(0, reg.original_fee - disc);

    await db.prepare(`
      UPDATE registrations SET discount_amount = ?, discount_reason = ?, final_fee = ?
      WHERE id = ?
    `).run(disc, (discount_reason || '').toUpperCase(), finalFee, regId);
  }

  res.redirect('/admin/inscripciones?success=' + encodeURIComponent('Bonificación / Descuento aplicado correctamente.'));
});

// Export CSV / Excel (UPPERCASE Headers & Fields matching production)
router.get('/exportar/csv', async (req, res) => {
  const { tournament_id, club_id, payment_status } = req.query;

  let query = `
    SELECT
      t.name as TORNEO,
      COALESCE(s.first_name, r.group_name) as NOMBRE,
      COALESCE(s.last_name, 'GRUPO') as APELLIDO,
      COALESCE(s.dni, '-') as DNI,
      COALESCE(s.cuil, '-') as CUIL,
      COALESCE(s.birth_date, '-') as FECHA_NACIMIENTO,
      CASE WHEN s.birth_date IS NOT NULL THEN (EXTRACT(YEAR FROM CURRENT_DATE)::int - EXTRACT(YEAR FROM s.birth_date::date)::int) ELSE 0 END as EDAD,
      cl.name as CLUB,
      c.name as "CATEGORÍA",
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

  const rows = await db.prepare(query).all(...params);

  // Generate CSV with UTF-8 BOM so Excel opens Spanish accents cleanly in UPPERCASE
  let csv = '﻿';
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
router.get('/finanzas', async (req, res) => {
  const tournaments = await db.prepare(`SELECT * FROM tournaments ORDER BY event_date DESC`).all();
  const selectedTournamentId = req.query.tournament_id || (tournaments.length > 0 ? tournaments[0].id : null);

  let expenses = [];
  let revenueStats = { total_gross: 0, total_discounts: 0, total_net: 0, total_paid: 0, total_pending: 0 };

  if (selectedTournamentId) {
    expenses = await db.prepare(`SELECT * FROM tournament_expenses WHERE tournament_id = ? ORDER BY expense_date DESC`).all(selectedTournamentId);

    revenueStats = await db.prepare(`
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
router.post('/finanzas/gastos', async (req, res) => {
  const { tournament_id, expense_category, description, amount, expense_date } = req.body;

  if (!tournament_id || !expense_category || !description || !amount) {
    return res.redirect('/admin/finanzas?error=' + encodeURIComponent('Todos los campos del gasto son requeridos.'));
  }

  try {
    await db.prepare(`
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
router.get('/posiciones', async (req, res) => {
  const clubLeaderboard = await db.prepare(`
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
router.get('/torneos', async (req, res) => {
  const tournaments = await db.prepare(`
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
router.post('/torneos/nuevo', async (req, res) => {
  const { name, description, venue, event_date, registration_deadline, status } = req.body;

  if (!name || !venue || !event_date || !registration_deadline) {
    return res.render('admin/torneo_form', {
      user: req.session.user,
      tournament: req.body,
      error: 'Por favor complete los campos obligatorios del torneo.'
    });
  }

  try {
    const info = await db.prepare(`
      INSERT INTO tournaments (name, description, venue, event_date, registration_deadline, status)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING id
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
router.get('/torneos/:id/categorias', async (req, res) => {
  const tournament = await db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(req.params.id);
  if (!tournament) return res.status(404).render('error', { title: 'Torneo No Encontrado' });

  const categories = await db.prepare(`SELECT * FROM categories WHERE tournament_id = ? ORDER BY discipline ASC, min_age ASC, division ASC`).all(tournament.id);

  res.render('admin/categorias', {
    user: req.session.user,
    tournament,
    categories,
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// Save Category
router.post('/torneos/:id/categorias', async (req, res) => {
  const tournamentId = req.params.id;
  const { name, discipline, division, level, min_age, max_age, gender, schedule, fee } = req.body;

  if (!name || !discipline) {
    return res.redirect(`/admin/torneos/${tournamentId}/categorias?error=` + encodeURIComponent('Nombre y disciplina son requeridos.'));
  }

  try {
    await db.prepare(`
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
router.get('/clubes', async (req, res) => {
  const clubs = await db.prepare(`
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
router.post('/clubes', async (req, res) => {
  const { name, representative, contact_phone, city } = req.body;
  if (!name) return res.redirect('/admin/clubes?error=' + encodeURIComponent('El nombre del club es obligatorio.'));

  try {
    await db.prepare(`
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
router.get('/usuarios', async (req, res) => {
  const usersList = await db.prepare(`
    SELECT u.*, c.name as club_name
    FROM users u
    LEFT JOIN clubs c ON u.club_id = c.id
    ORDER BY u.role ASC, u.full_name ASC
  `).all();

  const clubs = await db.prepare(`SELECT * FROM clubs ORDER BY name ASC`).all();

  res.render('admin/usuarios', {
    user: req.session.user,
    usersList,
    clubs,
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// Create New User
router.post('/usuarios', async (req, res) => {
  const { username, password, full_name, role, club_id, email, phone } = req.body;

  if (!username || !password || !full_name || !role) {
    return res.redirect('/admin/usuarios?error=' + encodeURIComponent('Complete todos los campos obligatorios del usuario.'));
  }

  try {
    const password_hash = bcrypt.hashSync(password, 10);
    const info = await db.prepare(`
      INSERT INTO users (username, password_hash, full_name, role, club_id, email, phone)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id
    `).run(username.trim().toLowerCase(), password_hash, full_name.trim().toUpperCase(), role, club_id || null, (email || '').toUpperCase(), phone || '');

    if (club_id) {
      await db.prepare(`INSERT INTO user_clubs (user_id, club_id) VALUES (?, ?) ON CONFLICT DO NOTHING`).run(info.lastInsertRowid, club_id);
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

// Master Skaters Directory for Admin (Padrón Único de Patinadoras)
router.get('/alumnos', async (req, res) => {
  const { buscar, club_id } = req.query;

  let query = `
    SELECT s.*,
    c.name as club_name,
    u.full_name as teacher_name,
    (SELECT COUNT(*) FROM student_documents d WHERE d.student_id = s.id) as doc_count,
    (SELECT COUNT(*) FROM registrations r WHERE r.student_id = s.id) as reg_count
    FROM students s
    JOIN clubs c ON s.club_id = c.id
    JOIN users u ON s.teacher_id = u.id
    WHERE 1=1
  `;
  const params = [];

  if (buscar) {
    const q = `%${buscar.trim().toUpperCase()}%`;
    query += ` AND (UPPER(s.first_name) LIKE ? OR UPPER(s.last_name) LIKE ? OR s.dni LIKE ? OR s.cuil LIKE ?)`;
    params.push(q, q, q, q);
  }

  if (club_id) {
    query += ` AND s.club_id = ?`;
    params.push(club_id);
  }

  query += ` ORDER BY s.last_name ASC, s.first_name ASC`;

  const students = await db.prepare(query).all(...params);
  students.forEach(s => { s.age = getCalendarAge(s.birth_date); });

  const clubs = await db.prepare(`SELECT * FROM clubs ORDER BY name ASC`).all();

  res.render('admin/alumnos', {
    user: req.session.user,
    students,
    clubs,
    buscar: buscar || '',
    selectedClub: club_id || '',
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// Form: New Skater by Admin
router.get('/alumnos/nuevo', async (req, res) => {
  const clubs = await db.prepare(`SELECT * FROM clubs ORDER BY name ASC`).all();
  const teachers = await db.prepare(`SELECT * FROM users WHERE role = 'profesor' OR role = 'admin' ORDER BY full_name ASC`).all();

  res.render('admin/alumno_form', {
    user: req.session.user,
    student: null,
    clubs,
    teachers,
    error: null
  });
});

// Save New Skater by Admin
router.post('/alumnos/nuevo', async (req, res) => {
  const {
    first_name, last_name, dni, cuil, birth_date, club_id, teacher_id,
    health_insurance, policy_number, medical_notes, emergency_contact, emergency_phone
  } = req.body;

  if (!first_name || !last_name || !dni || !birth_date || !health_insurance || !policy_number) {
    const clubs = await db.prepare(`SELECT * FROM clubs ORDER BY name ASC`).all();
    const teachers = await db.prepare(`SELECT * FROM users WHERE role = 'profesor' OR role = 'admin' ORDER BY full_name ASC`).all();
    return res.render('admin/alumno_form', {
      user: req.session.user,
      student: req.body,
      clubs,
      teachers,
      error: 'Nombre, Apellido, DNI, Fecha Nacimiento, Seguro y Póliza son requeridos.'
    });
  }

  try {
    await db.prepare(`
      INSERT INTO students (
        teacher_id, club_id, first_name, last_name, dni, cuil, birth_date,
        category_default, health_insurance, policy_number, medical_notes,
        emergency_contact, emergency_phone
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      parseInt(teacher_id) || req.session.user.id,
      parseInt(club_id) || 1,
      first_name.trim().toUpperCase(),
      last_name.trim().toUpperCase(),
      dni.trim().toUpperCase(),
      (cuil || '').trim().toUpperCase(),
      birth_date,
      'GENERAL',
      health_insurance.trim().toUpperCase(),
      policy_number.trim().toUpperCase(),
      (medical_notes || '').toUpperCase(),
      (emergency_contact || '').toUpperCase(),
      (emergency_phone || '').toUpperCase()
    );

    res.redirect('/admin/alumnos?success=' + encodeURIComponent('Patinadora registrada exitosamente en el padrón único.'));
  } catch (err) {
    console.error('Error adding skater by admin:', err);
    let msg = 'Error al registrar la deportista.';
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      msg = 'Ya existe una patinadora registrada en el padrón con ese DNI (Unicidad activa).';
    }
    const clubs = await db.prepare(`SELECT * FROM clubs ORDER BY name ASC`).all();
    const teachers = await db.prepare(`SELECT * FROM users WHERE role = 'profesor' OR role = 'admin' ORDER BY full_name ASC`).all();
    res.render('admin/alumno_form', {
      user: req.session.user,
      student: req.body,
      clubs,
      teachers,
      error: msg
    });
  }
});

// Form: Edit Skater by Admin
router.get('/alumnos/:id/editar', async (req, res) => {
  const student = await db.prepare(`SELECT * FROM students WHERE id = ?`).get(req.params.id);
  if (!student) return res.status(404).render('error', { title: 'Patinadora no encontrada' });

  const clubs = await db.prepare(`SELECT * FROM clubs ORDER BY name ASC`).all();
  const teachers = await db.prepare(`SELECT * FROM users WHERE role = 'profesor' OR role = 'admin' ORDER BY full_name ASC`).all();

  res.render('admin/alumno_form', {
    user: req.session.user,
    student,
    clubs,
    teachers,
    error: null
  });
});

// Save Edited Skater Data by Admin
router.post('/alumnos/:id/editar', async (req, res) => {
  const studentId = req.params.id;
  const {
    first_name, last_name, dni, cuil, birth_date, club_id, teacher_id,
    health_insurance, policy_number, medical_notes, emergency_contact, emergency_phone
  } = req.body;

  try {
    await db.prepare(`
      UPDATE students SET
        first_name = ?, last_name = ?, dni = ?, cuil = ?, birth_date = ?, club_id = ?, teacher_id = ?,
        health_insurance = ?, policy_number = ?, medical_notes = ?, emergency_contact = ?, emergency_phone = ?
      WHERE id = ?
    `).run(
      first_name.trim().toUpperCase(),
      last_name.trim().toUpperCase(),
      dni.trim().toUpperCase(),
      (cuil || '').trim().toUpperCase(),
      birth_date,
      parseInt(club_id) || 1,
      parseInt(teacher_id) || req.session.user.id,
      health_insurance.trim().toUpperCase(),
      policy_number.trim().toUpperCase(),
      (medical_notes || '').toUpperCase(),
      (emergency_contact || '').toUpperCase(),
      (emergency_phone || '').toUpperCase(),
      studentId
    );

    res.redirect('/admin/alumnos?success=' + encodeURIComponent(`Datos de ${first_name.toUpperCase()} ${last_name.toUpperCase()} actualizados correctamente.`));
  } catch (err) {
    console.error('Error updating skater by admin:', err);
    res.redirect('/admin/alumnos?error=' + encodeURIComponent('Error al actualizar datos de la patinadora.'));
  }
});

// Mark User as Verified Manually
router.post('/usuarios/:id/verificar', async (req, res) => {
  await db.prepare(`UPDATE users SET email_verified = true WHERE id = ?`).run(req.params.id);
  res.redirect('/admin/usuarios?success=' + encodeURIComponent('✅ Usuario marcado como email verificado.'));
});

// Resend Verification Email from Admin
router.post('/usuarios/:id/reenviar-verificacion', async (req, res) => {
  const { sendVerificationEmail } = require('./auth');
  const user = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.params.id);

  if (!user) return res.redirect('/admin/usuarios?error=' + encodeURIComponent('Usuario no encontrado.'));
  if (!user.email) return res.redirect('/admin/usuarios?error=' + encodeURIComponent('El usuario no tiene correo electrónico registrado.'));
  if (user.email_verified) return res.redirect('/admin/usuarios?error=' + encodeURIComponent('El usuario ya tiene el email verificado.'));

  const crypto = require('crypto');
  await db.prepare(`DELETE FROM email_verifications WHERE user_id = ?`).run(user.id);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await db.prepare(`
    INSERT INTO email_verifications (user_id, token, expires_at)
    VALUES (?, ?, ?)
  `).run(user.id, token, expiresAt);

  const { sent, fullUrl } = await sendVerificationEmail(user.email, `/auth/verificar-email?token=${token}`, req);

  res.redirect('/admin/usuarios?success=' + encodeURIComponent(
    sent
      ? `✉️ Email de verificación reenviado a ${user.email}.`
      : `🔗 Enlace de verificación regenerado (SMTP no configurado): ${fullUrl}`
  ));
});

// Admin Quick Password Reset Email Sender
router.post('/usuarios/:id/restablecer', async (req, res) => {
  const userId = req.params.id;
  const user = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);

  if (!user) {
    return res.redirect('/admin/usuarios?error=' + encodeURIComponent('Usuario no encontrado.'));
  }

  if (!user.email) {
    return res.redirect('/admin/usuarios?error=' + encodeURIComponent(`El usuario ${user.full_name} (@${user.username}) no tiene un correo electrónico registrado. Por favor agregue su email primero.`));
  }

  const crypto = require('crypto');
  const nodemailer = require('nodemailer');

  await db.prepare(`DELETE FROM password_resets WHERE user_id = ?`).run(user.id);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  await db.prepare(`
    INSERT INTO password_resets (user_id, token, expires_at)
    VALUES (?, ?, ?)
  `).run(user.id, token, expiresAt);

  const resetPath = `/auth/restablecer-password?token=${token}`;
  const host = req.get('host');
  const fullUrl = `${req.protocol}://${host}${resetPath}`;

  // Check if SMTP is configured
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
        from: process.env.SMTP_FROM || `"Liga Star Dance" <${process.env.SMTP_USER}>`,
        to: user.email,
        subject: '🔐 Restablecimiento de contraseña por Administración - Liga Star Dance',
        html: `
          <div style="font-family: Arial, sans-serif; padding: 20px; color: #12061c;">
            <h2 style="color: #3b1959;">Liga Star Dance - Recuperación de Contraseña</h2>
            <p>Hola <strong>${user.full_name}</strong>,</p>
            <p>La administración de la Liga Star Dance ha generado una solicitud para restablecer la contraseña de tu cuenta (@<strong>${user.username}</strong>).</p>
            <p>Hacé clic en el siguiente botón para definir tu nueva contraseña:</p>
            <div style="margin: 25px 0;">
              <a href="${fullUrl}" style="background: #d4af37; color: #12061c; font-weight: bold; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">
                🔑 Crear Nueva Contraseña
              </a>
            </div>
            <p style="font-size: 0.85rem; color: #666;">Este enlace es válido por 24 horas.</p>
          </div>
        `
      });

      return res.redirect('/admin/usuarios?success=' + encodeURIComponent(`✅ Correo enviado automáticamente a ${user.email} con las instrucciones.`));
    } catch (err) {
      console.error('Error sending email:', err);
      return res.redirect('/admin/usuarios?error=' + encodeURIComponent(`Error de envío por SMTP: ${err.message}`));
    }
  }

  // Fallback if local without SMTP
  console.log(`\n======================================================`);
  console.log(`✉️ EMAIL AUTOMÁTICO SIMULADO PARA: ${user.email}`);
  console.log(`Link: ${fullUrl}`);
  console.log(`======================================================\n`);

  res.redirect('/admin/usuarios?success=' + encodeURIComponent(`✉️ Correo de recuperación procesado automáticamente para ${user.email} (Link activo: ${fullUrl}).`));
});

// View Student Documents (Admin Inspector)
router.get('/alumnos/:id/documentos', async (req, res) => {
  const student = await db.prepare(`
    SELECT s.*, c.name as club_name, u.full_name as teacher_name
    FROM students s
    JOIN clubs c ON s.club_id = c.id
    JOIN users u ON s.teacher_id = u.id
    WHERE s.id = ?
  `).get(req.params.id);

  if (!student) return res.status(404).render('error', { title: 'Alumno no encontrado' });

  const documents = await db.prepare(`SELECT * FROM student_documents WHERE student_id = ?`).all(student.id);

  res.render('admin/alumno_docs', {
    user: req.session.user,
    student,
    documents
  });
});

// CMS Admin Control Panel for Public Home Page
router.get('/cms', async (req, res) => {
  const getSetting = async (key) => {
    const row = await db.prepare(`SELECT value FROM site_settings WHERE key = ?`).get(key);
    return row ? row.value : '';
  };

  const hero_title = (await getSetting('hero_title')) || 'LIGA DE PATINAJE ARTÍSTICO STAR DANCE';
  const hero_subtitle = (await getSetting('hero_subtitle')) || 'Plataforma oficial de gestión de torneos, cuerpo de jueces e inscripciones.';
  const about_title = (await getSetting('about_title')) || 'SOBRE LA LIGA STAR DANCE Y NUESTRO PROPÓSITO';
  const about_content = (await getSetting('about_content')) || 'La Liga Star Dance nace con la misión de impulsar y promover el Patinaje Artístico sobre ruedas...';

  const slides = await db.prepare(`SELECT * FROM home_slides ORDER BY order_index ASC`).all();
  const judges = await db.prepare(`SELECT * FROM judge_profiles ORDER BY order_index ASC`).all();
  const disciplines = await db.prepare(`SELECT * FROM discipline_info ORDER BY order_index ASC`).all();

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
router.post('/cms/hero', async (req, res) => {
  const { hero_title, hero_subtitle } = req.body;
  const setSetting = db.prepare(`INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  await setSetting.run('hero_title', (hero_title || '').toUpperCase());
  await setSetting.run('hero_subtitle', hero_subtitle || '');

  res.redirect('/admin/cms?success=' + encodeURIComponent('Banner principal de la Home actualizado.'));
});

// Update About Us / Purpose
router.post('/cms/about', async (req, res) => {
  const { about_title, about_content } = req.body;
  const setSetting = db.prepare(`INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  await setSetting.run('about_title', (about_title || '').toUpperCase());
  await setSetting.run('about_content', about_content || '');

  res.redirect('/admin/cms?success=' + encodeURIComponent('Sección Sobre la Liga y Propósito actualizada.'));
});

// Add New Slide Banner
router.post('/cms/slides', async (req, res) => {
  const { title, subtitle, image_url, button_text, button_link } = req.body;
  if (!title) return res.redirect('/admin/cms?error=' + encodeURIComponent('El título del slide es requerido.'));

  try {
    await db.prepare(`
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
router.post('/cms/slides/:id/eliminar', async (req, res) => {
  await db.prepare(`DELETE FROM home_slides WHERE id = ?`).run(req.params.id);
  res.redirect('/admin/cms?success=' + encodeURIComponent('Slide eliminado de la portada.'));
});

// Add Judge Profile with Photo & Info
router.post('/cms/jueces', async (req, res) => {
  const { name, title, photo_url, bio, specialty } = req.body;
  if (!name || !title) return res.redirect('/admin/cms?error=' + encodeURIComponent('Nombre y título del juez son requeridos.'));

  try {
    await db.prepare(`
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
router.post('/cms/jueces/:id/eliminar', async (req, res) => {
  await db.prepare(`DELETE FROM judge_profiles WHERE id = ?`).run(req.params.id);
  res.redirect('/admin/cms?success=' + encodeURIComponent('Perfil de juez eliminado.'));
});

// Add Discipline Public Info Card
router.post('/cms/disciplinas', async (req, res) => {
  const { name, description, icon } = req.body;
  if (!name || !description) return res.redirect('/admin/cms?error=' + encodeURIComponent('Nombre y descripción son requeridos.'));

  try {
    await db.prepare(`
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
