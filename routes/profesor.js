const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../database');
const { requireAuth, requireRole } = require('../middleware/auth');

// Setup multer for document uploads
const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = 'doc_' + Date.now() + '_' + Math.round(Math.random() * 1E9) + ext;
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

// All routes require role 'profesor'
router.use(requireAuth, requireRole('profesor'));

// Dashboard Profesor
router.get('/dashboard', (req, res) => {
  const teacherId = req.session.user.id;

  const totalStudents = db.prepare(`SELECT COUNT(*) as count FROM students WHERE teacher_id = ?`).get(teacherId).count;
  const activeRegistrations = db.prepare(`SELECT COUNT(*) as count FROM registrations WHERE teacher_id = ?`).get(teacherId).count;

  const students = db.prepare(`
    SELECT s.*, 
    (SELECT COUNT(*) FROM student_documents d WHERE d.student_id = s.id) as doc_count,
    (SELECT COUNT(*) FROM registrations r WHERE r.student_id = s.id) as reg_count
    FROM students s
    WHERE s.teacher_id = ?
    ORDER BY s.last_name ASC, s.first_name ASC
  `).all(teacherId);

  const myRegistrations = db.prepare(`
    SELECT r.*, 
    s.first_name, s.last_name, s.dni,
    t.name as tournament_name, t.event_date,
    c.name as category_name, c.discipline, c.level, c.fee
    FROM registrations r
    JOIN students s ON r.student_id = s.id
    JOIN tournaments t ON r.tournament_id = t.id
    JOIN categories c ON r.category_id = c.id
    WHERE r.teacher_id = ?
    ORDER BY r.created_at DESC
  `).all(teacherId);

  res.render('profesor/dashboard', {
    user: req.session.user,
    stats: { totalStudents, activeRegistrations },
    students,
    myRegistrations,
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// Students List Page
router.get('/alumnos', (req, res) => {
  const teacherId = req.session.user.id;
  const students = db.prepare(`
    SELECT s.*, 
    (SELECT COUNT(*) FROM student_documents d WHERE d.student_id = s.id) as doc_count,
    (SELECT COUNT(*) FROM registrations r WHERE r.student_id = s.id) as reg_count
    FROM students s
    WHERE s.teacher_id = ?
    ORDER BY s.last_name ASC, s.first_name ASC
  `).all(teacherId);

  res.render('profesor/alumnos', {
    user: req.session.user,
    students,
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// Form: New Student
router.get('/alumnos/nuevo', (req, res) => {
  res.render('profesor/alumno_form', {
    user: req.session.user,
    student: null,
    error: null
  });
});

// Save New Student
router.post('/alumnos/nuevo', upload.single('documento'), (req, res) => {
  const teacherId = req.session.user.id;
  const clubId = req.session.user.club_id || 1; // Default to club 1 if unassigned

  const {
    first_name, last_name, dni, birth_date, category_default,
    health_insurance, policy_number, medical_notes, emergency_contact, emergency_phone
  } = req.body;

  if (!first_name || !last_name || !dni || !birth_date) {
    return res.render('profesor/alumno_form', {
      user: req.session.user,
      student: req.body,
      error: 'Nombre, Apellido, DNI y Fecha de Nacimiento son obligatorios.'
    });
  }

  try {
    const stmt = db.prepare(`
      INSERT INTO students (
        teacher_id, club_id, first_name, last_name, dni, birth_date,
        category_default, health_insurance, policy_number, medical_notes,
        emergency_contact, emergency_phone
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const info = stmt.run(
      teacherId, clubId, first_name.trim(), last_name.trim(), dni.trim(), birth_date,
      category_default || '', health_insurance || '', policy_number || '', medical_notes || '',
      emergency_contact || '', emergency_phone || ''
    );

    const studentId = info.lastInsertRowid;

    // Handle optional document upload
    if (req.file) {
      const docTitle = req.body.doc_title || 'Apto Médico / Seguro';
      db.prepare(`
        INSERT INTO student_documents (student_id, title, doc_type, file_path)
        VALUES (?, ?, ?, ?)
      `).run(studentId, docTitle, 'apto_medico', '/uploads/' + req.file.filename);
    }

    res.redirect('/profesor/alumnos?success=' + encodeURIComponent('Alumno cargado correctamente en el padrón.'));
  } catch (err) {
    console.error('Error saving student:', err);
    let errMsg = 'Error al registrar el alumno en la base de datos.';
    if (err.message && err.message.includes('UNIQUE constraint failed: students.dni')) {
      errMsg = 'Ya existe un alumno registrado con ese DNI.';
    }
    res.render('profesor/alumno_form', {
      user: req.session.user,
      student: req.body,
      error: errMsg
    });
  }
});

// Edit Student Form
router.get('/alumnos/:id/editar', (req, res) => {
  const teacherId = req.session.user.id;
  const student = db.prepare(`SELECT * FROM students WHERE id = ? AND teacher_id = ?`).get(req.params.id, teacherId);

  if (!student) {
    return res.status(404).render('error', { title: 'Alumno No Encontrado', message: 'No se encontró el alumno especificado.' });
  }

  const documents = db.prepare(`SELECT * FROM student_documents WHERE student_id = ?`).all(student.id);

  res.render('profesor/alumno_form', {
    user: req.session.user,
    student,
    documents,
    error: null
  });
});

// Update Student
router.post('/alumnos/:id/editar', upload.single('documento'), (req, res) => {
  const teacherId = req.session.user.id;
  const studentId = req.params.id;

  const {
    first_name, last_name, dni, birth_date, category_default,
    health_insurance, policy_number, medical_notes, emergency_contact, emergency_phone
  } = req.body;

  try {
    db.prepare(`
      UPDATE students SET
        first_name = ?, last_name = ?, dni = ?, birth_date = ?,
        category_default = ?, health_insurance = ?, policy_number = ?, medical_notes = ?,
        emergency_contact = ?, emergency_phone = ?
      WHERE id = ? AND teacher_id = ?
    `).run(
      first_name.trim(), last_name.trim(), dni.trim(), birth_date,
      category_default || '', health_insurance || '', policy_number || '', medical_notes || '',
      emergency_contact || '', emergency_phone || '',
      studentId, teacherId
    );

    // Save document if uploaded
    if (req.file) {
      const docTitle = req.body.doc_title || 'Documentación Médica / Ficha';
      db.prepare(`
        INSERT INTO student_documents (student_id, title, doc_type, file_path)
        VALUES (?, ?, ?, ?)
      `).run(studentId, docTitle, 'apto_medico', '/uploads/' + req.file.filename);
    }

    res.redirect('/profesor/alumnos?success=' + encodeURIComponent('Datos del alumno actualizados.'));
  } catch (err) {
    console.error('Error updating student:', err);
    res.render('profesor/alumno_form', {
      user: req.session.user,
      student: { ...req.body, id: studentId },
      documents: db.prepare(`SELECT * FROM student_documents WHERE student_id = ?`).all(studentId),
      error: 'Error al actualizar los datos del alumno.'
    });
  }
});

// Form: Enroll Student into Category
router.get('/inscribir', (req, res) => {
  const teacherId = req.session.user.id;

  const students = db.prepare(`SELECT * FROM students WHERE teacher_id = ? ORDER BY last_name ASC`).all(teacherId);
  const activeTournaments = db.prepare(`SELECT * FROM tournaments WHERE status != 'finished' ORDER BY event_date ASC`).all();

  const selectedTournamentId = req.query.tournament_id || (activeTournaments.length > 0 ? activeTournaments[0].id : null);
  let categories = [];

  if (selectedTournamentId) {
    categories = db.prepare(`SELECT * FROM categories WHERE tournament_id = ? ORDER BY min_age ASC, name ASC`).all(selectedTournamentId);
  }

  res.render('profesor/inscribir', {
    user: req.session.user,
    students,
    activeTournaments,
    selectedTournamentId,
    categories,
    preselectedStudentId: req.query.student_id || null,
    error: null
  });
});

// Submit Enrollment
router.post('/inscribir', (req, res) => {
  const teacherId = req.session.user.id;
  const clubId = req.session.user.club_id || 1;
  const { student_id, tournament_id, category_id, notes } = req.body;

  if (!student_id || !tournament_id || !category_id) {
    return res.redirect('/profesor/inscribir?error=' + encodeURIComponent('Debe seleccionar alumno, torneo y categoría.'));
  }

  try {
    db.prepare(`
      INSERT INTO registrations (
        tournament_id, category_id, student_id, club_id, teacher_id, status, payment_status, notes
      ) VALUES (?, ?, ?, ?, ?, 'registered', 'pending', ?)
    `).run(tournament_id, category_id, student_id, clubId, teacherId, notes || '');

    res.redirect('/profesor/dashboard?success=' + encodeURIComponent('Alumno inscripto correctamente en la categoría elegida.'));
  } catch (err) {
    console.error('Error in registration:', err);
    let errorMsg = 'Error al procesar la inscripción.';
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      errorMsg = 'El alumno ya se encuentra inscripto en esa categoría para este torneo.';
    }
    res.redirect('/profesor/inscribir?error=' + encodeURIComponent(errorMsg));
  }
});

// Printable Enrollment Certificate
router.get('/certificado/:id', (req, res) => {
  const teacherId = req.session.user.id;
  const regId = req.params.id;

  const registration = db.prepare(`
    SELECT r.*, 
    s.first_name, s.last_name, s.dni, s.birth_date, s.health_insurance,
    t.name as tournament_name, t.venue, t.event_date,
    c.name as category_name, c.discipline, c.level, c.fee,
    cl.name as club_name
    FROM registrations r
    JOIN students s ON r.student_id = s.id
    JOIN tournaments t ON r.tournament_id = t.id
    JOIN categories c ON r.category_id = c.id
    JOIN clubs cl ON r.club_id = cl.id
    WHERE r.id = ? AND r.teacher_id = ?
  `).get(regId, teacherId);

  if (!registration) {
    return res.status(404).render('error', { title: 'Certificado No Encontrado', message: 'No se encontró la inscripción solicitada.' });
  }

  res.render('profesor/certificado', {
    user: req.session.user,
    reg: registration
  });
});

module.exports = router;
