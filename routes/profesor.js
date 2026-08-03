const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../database');
const { requireAuth, requireRole } = require('../middleware/auth');

// True cuando la petición viene de un fetch del frontend (wizards) y espera JSON.
const isAjax = (req) => req.xhr || (req.get('accept') || '').includes('application/json');

// Setup multer for document uploads
const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = 'DOC_' + Date.now() + '_' + Math.round(Math.random() * 1E9) + ext;
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

// All routes require role 'profesor'
router.use(requireAuth, requireRole('profesor'));

// Helper: Calculate age from birth date in calendar year
function getCalendarAge(birthDateStr) {
  if (!birthDateStr) return 0;
  const birthYear = new Date(birthDateStr).getFullYear();
  const currentYear = new Date().getFullYear();
  return Math.max(0, currentYear - birthYear);
}

// Helper: Lista única de categorías/disciplinas (para elegir la categoría de la alumna)
async function getCategoryOptions() {
  const cats = await db.prepare(`SELECT * FROM categories ORDER BY discipline ASC, min_age ASC, name ASC`).all();
  const seen = new Set();
  const opts = [];
  for (const c of cats) {
    if (!seen.has(c.name)) {
      seen.add(c.name);
      opts.push({ discipline: c.discipline, name: c.name });
    }
  }
  opts.sort((a, b) => a.discipline.localeCompare(b.discipline) || a.name.localeCompare(b.name));
  return opts;
}

// Dashboard Profesor → Módulo único "Mis alumnas" con wizards minimizables
router.get('/dashboard', async (req, res) => {
  const teacherId = req.session.user.id;

  const totalStudents = (await db.prepare(`SELECT COUNT(*) as count FROM students WHERE teacher_id = ?`).get(teacherId)).count;
  const activeRegistrations = (await db.prepare(`SELECT COUNT(*) as count FROM registrations WHERE teacher_id = ?`).get(teacherId)).count;

  // Teacher's assigned clubs (para el select de club en el alta)
  const myClubs = await db.prepare(`
    SELECT c.* FROM clubs c
    JOIN user_clubs uc ON c.id = uc.club_id
    WHERE uc.user_id = ?
    ORDER BY c.name ASC
  `).all(teacherId);

  const students = await db.prepare(`
    SELECT s.*,
    c.name as club_name,
    (SELECT COUNT(*) FROM student_documents d WHERE d.student_id = s.id) as doc_count,
    (SELECT COUNT(*) FROM registrations r WHERE r.student_id = s.id) as reg_count
    FROM students s
    JOIN clubs c ON s.club_id = c.id
    WHERE s.teacher_id = ?
    ORDER BY s.last_name ASC, s.first_name ASC
  `).all(teacherId);

  // Add calculated age to students
  students.forEach(s => { s.age = getCalendarAge(s.birth_date); });

  const myRegistrations = await db.prepare(`
    SELECT r.*,
    s.first_name, s.last_name, s.dni,
    t.name as tournament_name, t.event_date,
    c.name as category_name, c.discipline, c.fee,
    cl.name as club_name
    FROM registrations r
    LEFT JOIN students s ON r.student_id = s.id
    JOIN tournaments t ON r.tournament_id = t.id
    JOIN categories c ON r.category_id = c.id
    JOIN clubs cl ON r.club_id = cl.id
    WHERE r.teacher_id = ?
    ORDER BY r.created_at DESC
  `).all(teacherId);

  // Datos para los wizards del módulo "Mis alumnas"
  const activeTournaments = await db.prepare(`SELECT * FROM tournaments WHERE status != 'finished' ORDER BY event_date ASC`).all();
  const allCategories = activeTournaments.length > 0
    ? await db.prepare(`SELECT * FROM categories ORDER BY discipline ASC, min_age ASC, name ASC`).all()
    : [];

  // Opciones únicas de categoría/disciplina para el wizard de carga de alumna
  const categoryOptions = await getCategoryOptions();

  res.render('profesor/mis_alumnas', {
    user: req.session.user,
    stats: { totalStudents, activeRegistrations },
    myClubs,
    students,
    myRegistrations,
    activeTournaments,
    allCategories,
    categoryOptions,
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// Create New Club by Teacher
router.post('/clubes/nuevo', async (req, res) => {
  const teacherId = req.session.user.id;
  const { name, city, contact_phone } = req.body;

  if (!name) return res.redirect('/profesor/dashboard?error=' + encodeURIComponent('El nombre del club es obligatorio.'));

  const uppercaseName = name.trim().toUpperCase();

  try {
    const info = await db.prepare(`
      INSERT INTO clubs (name, representative, contact_phone, city)
      VALUES (?, ?, ?, ?) RETURNING id
    `).run(uppercaseName, req.session.user.full_name.toUpperCase(), contact_phone || '', (city || '').toUpperCase());

    const newClubId = info.lastInsertRowid;
    await db.prepare(`INSERT INTO user_clubs (user_id, club_id) VALUES (?, ?) ON CONFLICT DO NOTHING`).run(teacherId, newClubId);

    res.redirect('/profesor/dashboard?club_id=' + newClubId + '&success=' + encodeURIComponent(`Club ${uppercaseName} creado correctamente.`));
  } catch (err) {
    console.error('Error creating club:', err);
    res.redirect('/profesor/dashboard?error=' + encodeURIComponent('El club ya existe o no pudo crearse.'));
  }
});

// Students Roster Page
router.get('/alumnos', async (req, res) => {
  const teacherId = req.session.user.id;
  const students = await db.prepare(`
    SELECT s.*, c.name as club_name,
    (SELECT COUNT(*) FROM student_documents d WHERE d.student_id = s.id) as doc_count
    FROM students s
    JOIN clubs c ON s.club_id = c.id
    WHERE s.teacher_id = ?
    ORDER BY s.last_name ASC, s.first_name ASC
  `).all(teacherId);

  students.forEach(s => { s.age = getCalendarAge(s.birth_date); });

  res.render('profesor/alumnos', {
    user: req.session.user,
    students,
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// Form: New Student
router.get('/alumnos/nuevo', async (req, res) => {
  const teacherId = req.session.user.id;
  const myClubs = await db.prepare(`
    SELECT c.* FROM clubs c
    JOIN user_clubs uc ON c.id = uc.club_id
    WHERE uc.user_id = ?
    ORDER BY c.name ASC
  `).all(teacherId);

  res.render('profesor/alumno_form', {
    user: req.session.user,
    student: null,
    myClubs,
    categoryOptions: await getCategoryOptions(),
    error: null
  });
});

// Save New Student (All Text UPPERCASE)
router.post('/alumnos/nuevo', upload.single('documento'), async (req, res) => {
  const teacherId = req.session.user.id;
  const ajax = isAjax(req);

  const {
    first_name, last_name, dni, cuil, birth_date, club_id, category_default,
    health_insurance, policy_number, medical_notes, emergency_contact, emergency_phone
  } = req.body;

  if (!first_name || !last_name || !dni || !birth_date || !health_insurance || !policy_number) {
    if (ajax) return res.status(400).json({ ok: false, message: 'Nombre, Apellido, DNI, Fecha Nacimiento, Seguro y N° Póliza son obligatorios.' });

    const myClubs = await db.prepare(`
      SELECT c.* FROM clubs c JOIN user_clubs uc ON c.id = uc.club_id WHERE uc.user_id = ? ORDER BY c.name ASC
    `).all(teacherId);

    return res.render('profesor/alumno_form', {
      user: req.session.user,
      student: req.body,
      myClubs,
      error: 'Nombre, Apellido, DNI, Fecha Nacimiento, Seguro y N° Póliza son obligatorios.'
    });
  }

  try {
    const stmt = db.prepare(`
      INSERT INTO students (
        teacher_id, club_id, first_name, last_name, dni, cuil, birth_date,
        category_default, health_insurance, policy_number, medical_notes,
        emergency_contact, emergency_phone
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
    `);

    const info = await stmt.run(
      teacherId,
      parseInt(club_id) || req.session.user.club_id || 1,
      first_name.trim().toUpperCase(),
      last_name.trim().toUpperCase(),
      dni.trim().toUpperCase(),
      (cuil || '').trim().toUpperCase(),
      birth_date,
      (category_default || '').toUpperCase(),
      health_insurance.trim().toUpperCase(),
      policy_number.trim().toUpperCase(),
      (medical_notes || '').toUpperCase(),
      (emergency_contact || '').toUpperCase(),
      (emergency_phone || '').toUpperCase()
    );

    const studentId = info.lastInsertRowid;

    if (req.file) {
      const docTitle = (req.body.doc_title || 'APTO MÉDICO / SEGURO').toUpperCase();
      await db.prepare(`
        INSERT INTO student_documents (student_id, title, doc_type, file_path)
        VALUES (?, ?, ?, ?)
      `).run(studentId, docTitle, 'apto_medico', '/uploads/' + req.file.filename);
    }

    if (ajax) return res.json({ ok: true, message: 'Patinadora cargada. Ya aparece en tu padrón.' });
    res.redirect('/profesor/alumnos?success=' + encodeURIComponent('Patinadora registrada en el padrón en MAYÚSCULAS.'));
  } catch (err) {
    console.error('Error saving student:', err);
    let errMsg = 'Error al registrar la patinadora.';
    if (err.message && err.message.includes('UNIQUE constraint failed: students.dni')) {
      errMsg = 'Ya existe una patinadora registrada con ese DNI.';
    }
    if (ajax) return res.status(400).json({ ok: false, message: errMsg });

    const myClubs = await db.prepare(`
      SELECT c.* FROM clubs c JOIN user_clubs uc ON c.id = uc.club_id WHERE uc.user_id = ? ORDER BY c.name ASC
    `).all(teacherId);

    res.render('profesor/alumno_form', {
      user: req.session.user,
      student: req.body,
      myClubs,
      error: errMsg
    });
  }
});

// View Student Profile / Details
router.get('/alumnos/:id/ver', async (req, res) => {
  const teacherId = req.session.user.id;
  const student = await db.prepare(`
    SELECT s.*, c.name as club_name, u.full_name as teacher_name
    FROM students s
    JOIN clubs c ON s.club_id = c.id
    JOIN users u ON s.teacher_id = u.id
    WHERE s.id = ? AND s.teacher_id = ?
  `).get(req.params.id, teacherId);

  if (!student) return res.status(404).render('error', { title: 'Patinadora no encontrada', message: 'La deportista solicitada no está registrada bajo tu padrón.' });

  student.age = getCalendarAge(student.birth_date);

  const documents = await db.prepare(`SELECT * FROM student_documents WHERE student_id = ?`).all(student.id);

  const registrations = await db.prepare(`
    SELECT r.*,
    t.name as tournament_name, t.event_date, t.venue,
    c.name as category_name, c.discipline
    FROM registrations r
    JOIN tournaments t ON r.tournament_id = t.id
    JOIN categories c ON r.category_id = c.id
    WHERE r.student_id = ?
    ORDER BY t.event_date DESC
  `).all(student.id);

  res.render('profesor/alumno_detalle', {
    user: req.session.user,
    student,
    documents,
    registrations
  });
});

// Edit Student Form
router.get('/alumnos/:id/editar', async (req, res) => {
  const teacherId = req.session.user.id;
  const student = await db.prepare(`SELECT * FROM students WHERE id = ? AND teacher_id = ?`).get(req.params.id, teacherId);

  if (!student) return res.status(404).render('error', { title: 'Patinadora no encontrada' });

  const myClubs = await db.prepare(`
    SELECT c.* FROM clubs c JOIN user_clubs uc ON c.id = uc.club_id WHERE uc.user_id = ? ORDER BY c.name ASC
  `).all(teacherId);
  const documents = await db.prepare(`SELECT * FROM student_documents WHERE student_id = ?`).all(student.id);

  res.render('profesor/alumno_form', {
    user: req.session.user,
    student,
    myClubs,
    categoryOptions: await getCategoryOptions(),
    documents,
    error: null
  });
});

// Update Student Form
router.post('/alumnos/:id/editar', upload.single('documento'), async (req, res) => {
  const teacherId = req.session.user.id;
  const studentId = req.params.id;

  const {
    first_name, last_name, dni, cuil, birth_date, club_id, category_default,
    health_insurance, policy_number, medical_notes, emergency_contact, emergency_phone
  } = req.body;

  try {
    await db.prepare(`
      UPDATE students SET
        first_name = ?, last_name = ?, dni = ?, cuil = ?, birth_date = ?, club_id = ?,
        category_default = ?, health_insurance = ?, policy_number = ?, medical_notes = ?,
        emergency_contact = ?, emergency_phone = ?
      WHERE id = ? AND teacher_id = ?
    `).run(
      first_name.trim().toUpperCase(),
      last_name.trim().toUpperCase(),
      dni.trim().toUpperCase(),
      (cuil || '').trim().toUpperCase(),
      birth_date,
      parseInt(club_id) || 1,
      (category_default || '').toUpperCase(),
      health_insurance.trim().toUpperCase(),
      policy_number.trim().toUpperCase(),
      (medical_notes || '').toUpperCase(),
      (emergency_contact || '').toUpperCase(),
      (emergency_phone || '').toUpperCase(),
      studentId, teacherId
    );

    if (req.file) {
      const docTitle = (req.body.doc_title || 'APTO MÉDICO / FICHA').toUpperCase();
      await db.prepare(`
        INSERT INTO student_documents (student_id, title, doc_type, file_path)
        VALUES (?, ?, ?, ?)
      `).run(studentId, docTitle, 'apto_medico', '/uploads/' + req.file.filename);
    }

    res.redirect('/profesor/alumnos?success=' + encodeURIComponent('Ficha de patinadora actualizada.'));
  } catch (err) {
    console.error('Error updating student:', err);
    res.redirect('/profesor/alumnos?error=' + encodeURIComponent('Error al actualizar datos.'));
  }
});

// Form: Enrollment Wizard (Individual & Group Registrations)
router.get('/inscribir', async (req, res) => {
  const teacherId = req.session.user.id;

  const students = await db.prepare(`SELECT * FROM students WHERE teacher_id = ? ORDER BY last_name ASC`).all(teacherId);
  students.forEach(s => { s.age = getCalendarAge(s.birth_date); });

  const activeTournaments = await db.prepare(`SELECT * FROM tournaments WHERE status != 'finished' ORDER BY event_date ASC`).all();
  const selectedTournamentId = req.query.tournament_id || (activeTournaments.length > 0 ? activeTournaments[0].id : null);

  let categories = [];
  if (selectedTournamentId) {
    categories = await db.prepare(`SELECT * FROM categories WHERE tournament_id = ? ORDER BY discipline ASC, min_age ASC, name ASC`).all(selectedTournamentId);
  }

  res.render('profesor/inscribir', {
    user: req.session.user,
    students,
    activeTournaments,
    selectedTournamentId,
    categories,
    preselectedStudentId: req.query.student_id || null,
    error: req.query.error || null
  });
});

// Submit Enrollment (Supports Individual & Group Highest Category Rule)
router.post('/inscribir', async (req, res) => {
  const teacherId = req.session.user.id;
  const ajax = isAjax(req);
  const { tournament_id, category_id, is_group, group_name, group_type, student_ids, notes } = req.body;

  if (!tournament_id || !category_id) {
    if (ajax) return res.status(400).json({ ok: false, message: 'Debe seleccionar torneo y categoría.' });
    return res.redirect('/profesor/inscribir?error=' + encodeURIComponent('Debe seleccionar torneo y categoría.'));
  }

  const category = await db.prepare(`SELECT * FROM categories WHERE id = ?`).get(category_id);
  if (!category) {
    if (ajax) return res.status(400).json({ ok: false, message: 'Categoría inválida.' });
    return res.redirect('/profesor/inscribir?error=' + encodeURIComponent('Categoría inválida.'));
  }

  // Get student IDs list
  let selectedStudentIds = [];
  if (Array.isArray(student_ids)) {
    selectedStudentIds = student_ids.filter(id => id);
  } else if (student_ids) {
    selectedStudentIds = [student_ids];
  } else if (req.body.student_id) {
    selectedStudentIds = [req.body.student_id];
  }

  if (selectedStudentIds.length === 0) {
    if (ajax) return res.status(400).json({ ok: false, message: 'Debe seleccionar al menos una patinadora.' });
    return res.redirect('/profesor/inscribir?error=' + encodeURIComponent('Debe seleccionar al menos una patinadora.'));
  }

  // Check for duplicate student IDs
  const uniqueStudentIds = [...new Set(selectedStudentIds)];
  if (uniqueStudentIds.length !== selectedStudentIds.length) {
    if (ajax) return res.status(400).json({ ok: false, message: 'No podés seleccionar a la misma patinadora más de una vez en la misma inscripción.' });
    return res.redirect('/profesor/inscribir?error=' + encodeURIComponent('No podés seleccionar a la misma patinadora más de una vez en la misma inscripción.'));
  }

  // Get main student and primary club
  const primaryStudent = await db.prepare(`SELECT * FROM students WHERE id = ?`).get(selectedStudentIds[0]);
  const clubId = primaryStudent ? primaryStudent.club_id : (req.session.user.club_id || 1);

  const isGroupReg = (is_group === '1' || selectedStudentIds.length > 1);
  const fee = category.fee || 0;

  try {
    const info = await db.prepare(`
      INSERT INTO registrations (
        tournament_id, category_id, student_id, club_id, teacher_id, is_group, group_name, group_type,
        status, payment_status, original_fee, discount_amount, final_fee, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'registered', 'pending', ?, 0, ?, ?) RETURNING id
    `).run(
      tournament_id,
      category_id,
      selectedStudentIds[0],
      clubId,
      teacherId,
      isGroupReg,
      isGroupReg ? ((group_name || 'GRUPO STAR DANCE').toUpperCase()) : null,
      group_type || 'Individual',
      fee,
      fee,
      (notes || '').toUpperCase()
    );

    const regId = info.lastInsertRowid;

    // Insert all group members
    const insertMember = db.prepare(`INSERT INTO registration_members (registration_id, student_id) VALUES (?, ?)`);
    for (const stId of selectedStudentIds) {
      await insertMember.run(regId, parseInt(stId));
    }

    if (ajax) return res.json({ ok: true, message: `Inscripción realizada en la categoría ${category.name}.` });
    res.redirect('/profesor/dashboard?success=' + encodeURIComponent(`Inscripción realizada en la categoría ${category.name}.`));
  } catch (err) {
    console.error('Error in registration:', err);
    let errorMsg = 'Error al procesar la inscripción.';
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      errorMsg = 'Una de las patinadoras ya se encuentra inscripta en esa categoría.';
    }
    if (ajax) return res.status(400).json({ ok: false, message: errorMsg });
    res.redirect('/profesor/inscribir?error=' + encodeURIComponent(errorMsg));
  }
});

// Printable Enrollment Certificate
router.get('/certificado/:id', async (req, res) => {
  const teacherId = req.session.user.id;
  const regId = req.params.id;

  const registration = await db.prepare(`
    SELECT r.*,
    s.first_name, s.last_name, s.dni, s.birth_date, s.health_insurance, s.policy_number,
    t.name as tournament_name, t.venue, t.event_date,
    c.name as category_name, c.discipline, c.division as level, c.fee,
    cl.name as club_name
    FROM registrations r
    LEFT JOIN students s ON r.student_id = s.id
    JOIN tournaments t ON r.tournament_id = t.id
    JOIN categories c ON r.category_id = c.id
    JOIN clubs cl ON r.club_id = cl.id
    WHERE r.id = ? AND r.teacher_id = ?
  `).get(regId, teacherId);

  if (!registration) {
    return res.status(404).render('error', { title: 'Certificado No Encontrado', message: 'No se encontró la inscripción solicitada.' });
  }

  // Get members if group
  const members = await db.prepare(`
    SELECT s.* FROM students s
    JOIN registration_members rm ON s.id = rm.student_id
    WHERE rm.registration_id = ?
  `).all(regId);

  res.render('profesor/certificado', {
    user: req.session.user,
    reg: registration,
    members
  });
});

module.exports = router;
