const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('../database');
const { formatEventDates } = require('../lib/dates');
const { formatCategoryName } = require('../lib/categories');
const inscEdit = require('../lib/inscripcion_editar');
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

// Locals globales del módulo: mis clubes (dropdown del banner) y contador de notificaciones (campana)
router.use(async (req, res, next) => {
  try {
    if (req.session && req.session.user) {
      const teacherId = req.session.user.id;
      res.locals.myClubs = await db.prepare(`
        SELECT c.* FROM clubs c
        JOIN user_clubs uc ON c.id = uc.club_id
        WHERE uc.user_id = ?
        ORDER BY c.name ASC
      `).all(teacherId);
      const n = await db.prepare(`SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = false`).get(teacherId);
      res.locals.unreadCount = n ? n.count : 0;
    }
  } catch (e) {
    console.error('Error loading profesor locals:', e);
  }
  next();
});

// Helper: Calculate age from birth date in calendar year
function getCalendarAge(birthDateStr) {
  if (!birthDateStr) return 0;
  const birthYear = new Date(birthDateStr).getFullYear();
  const currentYear = new Date().getFullYear();
  return Math.max(0, currentYear - birthYear);
}

// Helper: resuelve el rango de años de la categoría de edad elegida en la
// inscripción (ej: "INFANTIL" → "12-13"). Usa primero las franjas configuradas
// para ese torneo y, si el torneo no las tiene, cae al catálogo oficial.
function getBandRange(bandsByDiscipline, discipline, bandName) {
  if (!bandName) return null;
  const norm = (s) => String(s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  const target = norm(bandName);

  // 1) Franjas configuradas para el torneo (lo que edita el administrador).
  const key = Object.keys(bandsByDiscipline || {}).find(k => norm(k) === norm(discipline));
  const configured = key ? bandsByDiscipline[key] : null;
  if (configured) {
    const band = configured.find(a => norm(a.name) === target);
    if (band) return `${band.min}-${band.max}`;
  }

  // 2) Catálogo oficial como respaldo.
  const catalogo = require('../data/catalogo_categorias.json');
  for (const g of catalogo) {
    if (norm(g.discipline) !== norm(discipline)) continue;
    if (!Array.isArray(g.ages)) continue;
    const band = g.ages.find(a => norm(a.name) === target);
    if (band) return `${band.min}-${band.max}`;
  }
  return null;
}

// Helper: separa "MARTINEZ SOFIA" / "MARTINEZ, SOFIA" en apellido y nombre
function splitFullName(raw) {
  let s = String(raw || '').trim().toUpperCase().replace(/\s+/g, ' ');
  let last = s;
  let first = '';
  if (s.includes(',')) {
    const parts = s.split(',');
    last = (parts[0] || '').trim();
    first = (parts[1] || '').trim();
  } else {
    const i = s.indexOf(' ');
    if (i > -1) {
      last = s.slice(0, i);
      first = s.slice(i + 1);
    }
  }
  return { last_name: last, first_name: first };
}

// Helper: si el profe carga la edad en vez de la fecha, se deriva la fecha de nacimiento
function deriveBirthDate(edad, birthDate) {
  if (birthDate) return birthDate;
  const e = parseInt(edad);
  if (!isNaN(e) && e > 0 && e < 100) {
    const now = new Date();
    const d = new Date(now.getFullYear() - e, now.getMonth(), now.getDate());
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return null;
}

// Helper: Lista única de categorías/disciplinas (para elegir la categoría de la alumna)
async function getCategoryOptions() {
  const cats = await db.prepare(`
    SELECT * FROM categories
    WHERE COALESCE(is_active, true) = true
    ORDER BY discipline ASC, order_index ASC, name ASC
  `).all();
  const seen = new Set();
  const opts = [];
  for (const c of cats) {
    if (!seen.has(c.name)) {
      seen.add(c.name);
      opts.push({ discipline: c.discipline, name: c.name, label: formatCategoryName(c.name, c.discipline) });
    }
  }
  // Se respeta el orden que trae la consulta (disciplina + order_index): si se
  // reordenara por nombre, el desplegable volvería a salir alfabético.
  return opts;
}

// Dashboard Profesor → Módulo único "Mis alumnas" (padrón + altas + inscripciones)
router.get('/dashboard', async (req, res) => {
  const teacherId = req.session.user.id;
  const selectedClubId = req.query.club_id ? parseInt(req.query.club_id) || null : null;

  // Teacher's assigned clubs (para el select de club en el alta)
  const myClubs = await db.prepare(`
    SELECT c.* FROM clubs c
    JOIN user_clubs uc ON c.id = uc.club_id
    WHERE uc.user_id = ?
    ORDER BY c.name ASC
  `).all(teacherId);

  const clubFilterSql = selectedClubId ? ` AND s.club_id = ?` : '';
  const clubFilterParams = selectedClubId ? [selectedClubId] : [];

  const students = await db.prepare(`
    SELECT s.*,
    c.name as club_name,
    (SELECT COUNT(*) FROM student_documents d WHERE d.student_id = s.id) as doc_count,
    (SELECT COUNT(*) FROM registrations r WHERE r.student_id = s.id) as reg_count
    FROM students s
    JOIN clubs c ON s.club_id = c.id
    WHERE s.teacher_id = ?${clubFilterSql}
    ORDER BY s.last_name ASC, s.first_name ASC
  `).all(teacherId, ...clubFilterParams);

  // Add calculated age to students
  students.forEach(s => { s.age = getCalendarAge(s.birth_date); });

  const regFilterSql = selectedClubId ? ` AND r.club_id = ?` : '';
  const regFilterParams = selectedClubId ? [selectedClubId] : [];

  const myRegistrations = await db.prepare(`
    SELECT r.*,
    s.first_name, s.last_name, s.dni, s.birth_date,
    t.name as tournament_name, t.event_date, t.date_from, t.date_to,
    c.name as category_name, c.discipline, c.level,
    cl.name as club_name
    FROM registrations r
    LEFT JOIN students s ON r.student_id = s.id
    JOIN tournaments t ON r.tournament_id = t.id
    JOIN categories c ON r.category_id = c.id
    JOIN clubs cl ON r.club_id = cl.id
    WHERE r.teacher_id = ?${regFilterSql}
    ORDER BY r.created_at DESC
  `).all(teacherId, ...regFilterParams);

  // Franjas de edad configuradas por torneo, para mostrar el rango junto a la
  // categoría de edad de cada inscripción (se cachean por torneo).
  const tc = require('../lib/tournament_config');
  const bandsCache = {};
  const bandsFor = async (tournamentId) => {
    if (!bandsCache[tournamentId]) {
      bandsCache[tournamentId] = await tc.getAgeBandsByDiscipline(tournamentId);
    }
    return bandsCache[tournamentId];
  };

  // En las inscripciones grupales se muestra cada patinadora con su propia edad.
  const registrationRows = [];
  for (const r of myRegistrations) {
    r.datesLabel = formatEventDates(r.date_from || r.event_date, r.date_to);
    r.bandRange = getBandRange(await bandsFor(r.tournament_id), r.discipline, r.age_band);
    // Edad guardada en la inscripción (la que cargó la profesora); si es una
    // inscripción vieja sin edad, se calcula de la fecha de nacimiento.
    r.reg_age = r.age;
    if (r.is_group) {
      const members = await db.prepare(`
        SELECT s.first_name, s.last_name, s.birth_date
        FROM students s
        JOIN registration_members rm ON s.id = rm.student_id
        WHERE rm.registration_id = ?
      `).all(r.id);
      if (members.length === 0) {
        registrationRows.push({ ...r, age: r.reg_age || getCalendarAge(r.birth_date), member_count: 0 });
      } else {
        members.forEach((m, idx) => {
          registrationRows.push({
            ...r,
            first_name: m.first_name,
            last_name: m.last_name,
            birth_date: m.birth_date,
            age: getCalendarAge(m.birth_date),
            member_index: idx,
            member_count: members.length
          });
        });
      }
    } else {
      registrationRows.push({ ...r, age: r.reg_age || getCalendarAge(r.birth_date), member_count: 1 });
    }
  }

  // Datos del módulo "Mis alumnas"
  const activeTournaments = await db.prepare(`SELECT * FROM tournaments WHERE status != 'finished' ORDER BY COALESCE(date_from, event_date) ASC`).all();
  activeTournaments.forEach(t => { t.datesLabel = formatEventDates(t.date_from || t.event_date, t.date_to); });

  const allCategories = activeTournaments.length > 0
    ? await db.prepare(`SELECT * FROM categories ORDER BY discipline ASC, order_index ASC, name ASC`).all()
    : [];

  // Opciones únicas de categoría/disciplina para la carga de alumna
  const categoryOptions = await getCategoryOptions();

  res.render('profesor/mis_alumnas', {
    user: req.session.user,
    selectedClubId,
    myClubs,
    students,
    myRegistrations: registrationRows,
    activeTournaments,
    allCategories,
    categoryOptions,
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// Create New Club by Teacher (sin teléfono: nombre + barrio)
router.post('/clubes/nuevo', async (req, res) => {
  const teacherId = req.session.user.id;
  const { name, city } = req.body;

  if (!name) return res.redirect('/profesor/clubes?error=' + encodeURIComponent('El nombre del club es obligatorio.'));

  const uppercaseName = name.trim().toUpperCase();

  try {
    const info = await db.prepare(`
      INSERT INTO clubs (name, representative, contact_phone, city)
      VALUES (?, ?, '', ?) RETURNING id
    `).run(uppercaseName, req.session.user.full_name.toUpperCase(), (city || '').toUpperCase());

    const newClubId = info.lastInsertRowid;
    await db.prepare(`INSERT INTO user_clubs (user_id, club_id) VALUES (?, ?) ON CONFLICT DO NOTHING`).run(teacherId, newClubId);

    res.redirect('/profesor/clubes?success=' + encodeURIComponent(`Club ${uppercaseName} creado correctamente.`));
  } catch (err) {
    console.error('Error creating club:', err);
    res.redirect('/profesor/clubes?error=' + encodeURIComponent('El club ya existe o no pudo crearse.'));
  }
});

// Remove a Club from the teacher's list (does not delete the club itself)
router.post('/clubes/quitar', async (req, res) => {
  const teacherId = req.session.user.id;
  const clubId = parseInt(req.body.club_id) || 0;

  await db.prepare(`DELETE FROM user_clubs WHERE user_id = ? AND club_id = ?`).run(teacherId, clubId);

  res.redirect('/profesor/clubes?success=' + encodeURIComponent('Club eliminado de tu lista. Las alumnas ya cargadas conservan su club.'));
});

// Módulo "Mis Clubes": gestionar mis clubes (listar / crear / quitar)
router.get('/clubes', async (req, res) => {
  const teacherId = req.session.user.id;

  res.render('profesor/clubes', {
    user: req.session.user,
    activeNav: 'clubes',
    topbarSection: 'Mis Clubes',
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// Students Roster Page → unificado en el módulo "Mis alumnas"
router.get('/alumnos', (req, res) => {
  res.redirect('/profesor/dashboard');
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
    full_name, first_name, last_name, dni, cuil, birth_date, edad, club_id, category_default,
    health_insurance, policy_number, medical_notes, emergency_contact, emergency_phone
  } = req.body;

  const names = full_name ? splitFullName(full_name) : { first_name: (first_name || '').trim().toUpperCase(), last_name: (last_name || '').trim().toUpperCase() };
  const resolvedBirthDate = deriveBirthDate(edad, birth_date);

  if (!names.first_name || !names.last_name || !dni || !resolvedBirthDate || !health_insurance || !policy_number) {
    if (ajax) return res.status(400).json({ ok: false, message: 'Nombre y Apellido, DNI, Fecha Nacimiento (o Edad), Seguro y N° Póliza son obligatorios.' });

    const myClubs = await db.prepare(`
      SELECT c.* FROM clubs c JOIN user_clubs uc ON c.id = uc.club_id WHERE uc.user_id = ? ORDER BY c.name ASC
    `).all(teacherId);

    return res.render('profesor/alumno_form', {
      user: req.session.user,
      student: req.body,
      myClubs,
      error: 'Nombre y Apellido, DNI, Fecha Nacimiento (o Edad), Seguro y N° Póliza son obligatorios.'
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
      names.first_name,
      names.last_name,
      dni.trim().toUpperCase(),
      (cuil || '').trim().toUpperCase(),
      resolvedBirthDate,
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
    res.redirect('/profesor/dashboard?success=' + encodeURIComponent('Patinadora registrada en el padrón en MAYÚSCULAS.'));
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
    t.name as tournament_name, t.event_date, t.date_from, t.date_to, t.venue,
    c.name as category_name, c.discipline
    FROM registrations r
    JOIN tournaments t ON r.tournament_id = t.id
    JOIN categories c ON r.category_id = c.id
    WHERE r.student_id = ?
    ORDER BY t.event_date DESC
  `).all(student.id);
  registrations.forEach(r => { r.datesLabel = formatEventDates(r.date_from || r.event_date, r.date_to); });

  res.render('profesor/alumno_detalle', {
    user: req.session.user,
    student,
    documents,
    registrations,
    myClubs: await db.prepare(`
      SELECT c.* FROM clubs c JOIN user_clubs uc ON c.id = uc.club_id WHERE uc.user_id = ? ORDER BY c.name ASC
    `).all(teacherId)
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
    full_name, first_name, last_name, dni, cuil, birth_date, edad, club_id, category_default,
    health_insurance, policy_number, medical_notes, emergency_contact, emergency_phone
  } = req.body;

  const names = full_name ? splitFullName(full_name) : { first_name: (first_name || '').trim().toUpperCase(), last_name: (last_name || '').trim().toUpperCase() };
  const resolvedBirthDate = deriveBirthDate(edad, birth_date);

  try {
    await db.prepare(`
      UPDATE students SET
        first_name = ?, last_name = ?, dni = ?, cuil = ?, birth_date = ?, club_id = ?,
        category_default = ?, health_insurance = ?, policy_number = ?, medical_notes = ?,
        emergency_contact = ?, emergency_phone = ?
      WHERE id = ? AND teacher_id = ?
    `).run(
      names.first_name,
      names.last_name,
      dni.trim().toUpperCase(),
      (cuil || '').trim().toUpperCase(),
      resolvedBirthDate || birth_date,
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

    res.redirect('/profesor/dashboard?success=' + encodeURIComponent('Ficha de patinadora actualizada.'));
  } catch (err) {
    console.error('Error updating student:', err);
    res.redirect('/profesor/dashboard?error=' + encodeURIComponent('Error al actualizar datos.'));
  }
});

// Bulk Edit: aplica un campo común a todas las patinadoras seleccionadas
router.post('/alumnos/masiva', async (req, res) => {
  const teacherId = req.session.user.id;
  const ids = Array.isArray(req.body.student_ids)
    ? req.body.student_ids
    : (req.body.student_ids ? [req.body.student_ids] : []);
  const { field, value } = req.body;

  if (ids.length === 0) {
    return res.redirect('/profesor/dashboard?error=' + encodeURIComponent('Seleccioná al menos una patinadora para la edición masiva.'));
  }

  const allowedFields = ['club_id', 'category_default', 'health_insurance', 'policy_number'];
  if (!allowedFields.includes(field)) {
    return res.redirect('/profesor/dashboard?error=' + encodeURIComponent('Campo de edición masiva no válido.'));
  }
  if (value === undefined || String(value).trim() === '') {
    return res.redirect('/profesor/dashboard?error=' + encodeURIComponent('Indicá el nuevo valor para el campo seleccionado.'));
  }

  try {
    const update = db.prepare(field === 'club_id'
      ? `UPDATE students SET club_id = ? WHERE id = ? AND teacher_id = ?`
      : `UPDATE students SET ${field} = ? WHERE id = ? AND teacher_id = ?`);
    for (const id of ids) {
      if (field === 'club_id') {
        await update.run(parseInt(value) || null, id, teacherId);
      } else {
        await update.run(String(value).trim().toUpperCase(), id, teacherId);
      }
    }
    res.redirect('/profesor/dashboard?success=' + encodeURIComponent(`Edición masiva aplicada a ${ids.length} patinadora(s).`));
  } catch (err) {
    console.error('Error in bulk edit:', err);
    res.redirect('/profesor/dashboard?error=' + encodeURIComponent('Error al aplicar la edición masiva.'));
  }
});

// Helper: elimina patinadoras propias (una o varias) junto con sus inscripciones,
// documentos y archivos subidos. La base de datos se encarga del resto con
// ON DELETE CASCADE (student_documents, registrations y registration_members).
async function deleteOwnStudents(teacherId, ids) {
  const arr = Array.isArray(ids) ? ids : [ids];
  let removed = 0;
  for (const raw of arr) {
    const id = parseInt(raw);
    if (!id) continue;
    const s = await db.prepare(`SELECT id FROM students WHERE id = ? AND teacher_id = ?`).get(id, teacherId);
    if (!s) continue;
    const docs = await db.prepare(`SELECT file_path FROM student_documents WHERE student_id = ?`).all(id);
    await db.prepare(`DELETE FROM students WHERE id = ?`).run(id);
    docs.forEach((d) => {
      if (!d || !d.file_path) return;
      try { fs.unlinkSync(path.join(uploadsDir, path.basename(d.file_path))); } catch (e) { /* archivo ya no existe */ }
    });
    removed++;
  }
  return removed;
}

// Borrar varias patinadoras seleccionadas (checkboxes del padrón)
router.post('/alumnos/eliminar', async (req, res) => {
  const removed = await deleteOwnStudents(req.session.user.id, req.body.student_ids);
  if (removed === 0) {
    return res.redirect('/profesor/dashboard?error=' + encodeURIComponent('No se pudo eliminar: seleccioná patinadoras de tu padrón.'));
  }
  res.redirect('/profesor/dashboard?success=' + encodeURIComponent(removed === 1 ? '1 patinadora eliminada.' : removed + ' patinadoras eliminadas.'));
});

// Borrar una sola patinadora
router.post('/alumnos/:id/eliminar', async (req, res) => {
  const removed = await deleteOwnStudents(req.session.user.id, [req.params.id]);
  if (removed === 0) {
    return res.redirect('/profesor/dashboard?error=' + encodeURIComponent('No se encontró la patinadora en tu padrón.'));
  }
  res.redirect('/profesor/dashboard?success=' + encodeURIComponent('Patinadora eliminada.'));
});

// Form: Enrollment Wizard (Individual & Group Registrations)
router.get('/inscribir', async (req, res) => {
  const teacherId = req.session.user.id;

  const students = await db.prepare(`SELECT s.*, c.name AS club_name FROM students s JOIN clubs c ON c.id = s.club_id WHERE s.teacher_id = ? ORDER BY s.last_name ASC`).all(teacherId);
  students.forEach(s => { s.age = getCalendarAge(s.birth_date); });
  const tc = require('../lib/tournament_config');

  const activeTournaments = await db.prepare(`SELECT * FROM tournaments WHERE status != 'finished' ORDER BY COALESCE(date_from, event_date) ASC`).all();
  activeTournaments.forEach(t => { t.datesLabel = formatEventDates(t.date_from || t.event_date, t.date_to); });

  // Torneo por defecto: el primero de los activos que YA tenga categorías cargadas
  // (si el seleccionado no tiene categorías, el botón Confirmar no podría registrarse).
  let selectedTournamentId = req.query.tournament_id ? parseInt(req.query.tournament_id) || null : null;
  if (selectedTournamentId) {
    const hasCats = await db.prepare(`SELECT COUNT(*) as count FROM categories WHERE tournament_id = ?`).get(selectedTournamentId);
    if (!hasCats || !hasCats.count) selectedTournamentId = null;
  }
  if (!selectedTournamentId) {
    for (const t of activeTournaments) {
      const hasCats = await db.prepare(`SELECT COUNT(*) as count FROM categories WHERE tournament_id = ?`).get(t.id);
      if (hasCats && hasCats.count) { selectedTournamentId = t.id; break; }
    }
  }

  const myClubs = await db.prepare(`
    SELECT c.* FROM clubs c JOIN user_clubs uc ON c.id = uc.club_id WHERE uc.user_id = ? ORDER BY c.name ASC
  `).all(teacherId);

  let categories = [];
  if (selectedTournamentId) {
    // Solo las categorías vigentes: las históricas (is_active = false) se
    // conservan para las inscripciones ya hechas, pero no se ofrecen más.
    categories = await db.prepare(`
      SELECT * FROM categories
      WHERE tournament_id = ? AND COALESCE(is_active, true) = true
      ORDER BY discipline ASC, order_index ASC, name ASC
    `).all(selectedTournamentId);
    categories.forEach(c => { c.label = formatCategoryName(c.name, c.discipline); });
  }

  // Disciplinas habilitadas del torneo, en el orden configurado por el admin
  // (LIBRE, FREE DANCE, SOLO DANCE, DÚO, TRÍO, CUARTETO, SMALL, SHOW,
  // PRECISIÓN, PAREJAS MIXTAS, ADULTOS). Solo se ofrecen las que ya tienen
  // categorías cargadas en este torneo; si no, el profesor no podría confirmar.
  const withCategories = new Set(categories.map(c => c.discipline).filter(Boolean));
  const configured = selectedTournamentId ? await tc.getDisciplines(selectedTournamentId) : [];
  const disciplines = configured
    .map(d => d.discipline)
    .filter(d => withCategories.has(d));

  // Categorías de edad (franjas) por disciplina, configurables por torneo.
  const ageBandsByDiscipline = selectedTournamentId
    ? await tc.getAgeBandsByDiscipline(selectedTournamentId)
    : {};

  // Reglamentos por disciplina: en ADULTOS la categoría depende de si compite
  // por el reglamento interno de Star Dance o por el del CAP.
  const rulesetsByDiscipline = selectedTournamentId
    ? await tc.getRulesetsByDiscipline(selectedTournamentId)
    : {};

  // Pares alumna+categoría ya ocupados EN ESTE TORNEO, para avisar en pantalla
  // antes de confirmar. Es solo de este torneo: en otro la inscripción es válida.
  const yaInscriptas = selectedTournamentId
    ? await db.prepare(`
        SELECT DISTINCT student_id, category_id FROM (
          SELECT r.student_id, r.category_id
          FROM registrations r
          WHERE r.tournament_id = ? AND r.student_id IS NOT NULL
            AND COALESCE(r.status, '') <> 'cancelled'
          UNION
          SELECT rm.student_id, r.category_id
          FROM registrations r
          JOIN registration_members rm ON rm.registration_id = r.id
          WHERE r.tournament_id = ? AND COALESCE(r.status, '') <> 'cancelled'
        ) x
      `).all(selectedTournamentId, selectedTournamentId)
    : [];

  res.render('profesor/inscribir', {
    user: req.session.user,
    students,
    myClubs,
    activeTournaments,
    selectedTournamentId,
    categories,
    disciplines,
    ageBandsByDiscipline,
    rulesetsByDiscipline,
    yaInscriptas,
    preselectedStudentId: req.query.student_id || null,
    error: req.query.error || null
  });
});

// Submit Enrollment (Supports Individual & Group Highest Category Rule)
router.post('/inscribir', async (req, res) => {
  const teacherId = req.session.user.id;
  const ajax = isAjax(req);
  const { tournament_id, category_id, is_group, group_name, group_type, student_ids, notes, club_id, age_band, age } = req.body;

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

  // No se puede anotar dos veces a la misma patinadora en la misma categoría
  // del mismo torneo. Se mira solo ese torneo: en otro torneo, o en otra
  // categoría de este, la inscripción es válida.
  const duplicadas = await inscEdit.findDuplicateInCategory(
    tournament_id, category_id, selectedStudentIds
  );
  if (duplicadas.length) {
    const msg = inscEdit.duplicateMessage(duplicadas);
    if (ajax) return res.status(409).json({ ok: false, message: msg });
    return res.redirect('/profesor/inscribir?tournament_id=' + encodeURIComponent(tournament_id) +
      '&error=' + encodeURIComponent(msg));
  }

  // Get main student and primary club
  const primaryStudent = await db.prepare(`SELECT * FROM students WHERE id = ?`).get(selectedStudentIds[0]);

  // Club de la inscripción: el profesor puede elegirlo manualmente (club_id);
  // si no lo manda o no es uno de sus clubes, se usa el club de la primera patinadora.
  const teacherClubs = await db.prepare(`SELECT club_id FROM user_clubs WHERE user_id = ?`).all(teacherId);
  const teacherClubIds = teacherClubs.map(c => c.club_id);
  let clubId = parseInt(club_id) || null;
  if (clubId && !teacherClubIds.includes(clubId)) clubId = null;
  if (!clubId) clubId = primaryStudent ? primaryStudent.club_id : (teacherClubIds[0] || req.session.user.club_id || 1);

  const isGroupReg = (is_group === '1' || selectedStudentIds.length > 1);

  // Edad de la inscripción: la que mandó el formulario (precargada de la ficha
  // de la alumna y editable a mano); si no viene, se calcula de la fecha de nacimiento.
  let regAge = parseInt(age, 10);
  if (!Number.isFinite(regAge) || regAge <= 0 || regAge > 120) {
    regAge = primaryStudent ? getCalendarAge(primaryStudent.birth_date) : null;
  }
  if (!regAge) regAge = null;

  try {
    const info = await db.prepare(`
      INSERT INTO registrations (
        tournament_id, category_id, student_id, club_id, teacher_id, is_group, group_name, group_type,
        status, notes, age_band, age
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'registered', ?, ?, ?) RETURNING id
    `).run(
      tournament_id,
      category_id,
      selectedStudentIds[0],
      clubId,
      teacherId,
      isGroupReg,
      isGroupReg ? ((group_name || 'GRUPO STAR DANCE').toUpperCase()) : null,
      group_type || 'Individual',
      (notes || '').toUpperCase(),
      (age_band || '').toUpperCase() || null,
      regAge
    );

    const regId = info.lastInsertRowid;

    // Insert all group members
    const insertMember = db.prepare(`INSERT INTO registration_members (registration_id, student_id) VALUES (?, ?)`);
    for (const stId of selectedStudentIds) {
      await insertMember.run(regId, parseInt(stId));
    }

    // Notificación en la campana del profesor
    const mainStudent = await db.prepare(`SELECT first_name, last_name FROM students WHERE id = ?`).get(selectedStudentIds[0]);
    const tournamentName = await db.prepare(`SELECT name FROM tournaments WHERE id = ?`).get(tournament_id);
    const alumnaName = mainStudent ? `${mainStudent.last_name} ${mainStudent.first_name}`.trim() : 'TU GRUPO';
    const msg = isGroupReg
      ? `Inscripción confirmada: GRUPO "${(group_name || 'GRUPO STAR DANCE').toUpperCase()}" en ${category.name} (${tournamentName ? tournamentName.name : ''})`
      : `Inscripción confirmada: ${alumnaName} en ${category.name} (${tournamentName ? tournamentName.name : ''})`;
    await db.prepare(`INSERT INTO notifications (user_id, message, link) VALUES (?, ?, ?)`).run(teacherId, msg, '/profesor/dashboard');

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

// Formulario de edición / movimiento de una inscripción propia (profesor)
router.get('/inscripciones/:id/editar', async (req, res) => {
  const regId = parseInt(req.params.id, 10);
  const reg = await inscEdit.getRegistration(regId);
  if (!reg || reg.teacher_id !== req.session.user.id) {
    return res.status(404).render('error', { title: 'Inscripción No Encontrada', message: 'La inscripción no existe o no pertenece a tu padrón.' });
  }

  const tournaments = await db.prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM categories c WHERE c.tournament_id = t.id) AS category_count
    FROM tournaments t
    WHERE t.status != 'finished' OR t.id = ?
    ORDER BY COALESCE(t.date_from, t.event_date) DESC
  `).all(reg.tournament_id);
  tournaments.forEach(t => { t.datesLabel = formatEventDates(t.date_from || t.event_date, t.date_to); });

  const destId = req.query.tournament_id ? parseInt(req.query.tournament_id) || null : reg.tournament_id;
  let categories = [];
  if (destId) {
    // Se ofrecen las categorias vigentes y, ademas, la que ya tiene esta
    // inscripcion (aunque sea historica), para que se siga viendo bien.
    categories = await db.prepare(`
      SELECT * FROM categories
      WHERE tournament_id = ? AND (COALESCE(is_active, true) = true OR id = ?)
      ORDER BY discipline ASC, order_index ASC, name ASC
    `).all(destId, reg.category_id);
    categories.forEach(c => { c.label = formatCategoryName(c.name, c.discipline); });
  }
  const suggested = inscEdit.findSuitableCategory(categories, {
    currentName: reg.category_name,
    discipline: reg.discipline,
    ageBand: reg.age_band,
    age: reg.age
  });

  const tcEdit = require('../lib/tournament_config');
  const ageBandsByDiscipline = destId ? await tcEdit.getAgeBandsByDiscipline(destId) : {};

  res.render('profesor/inscripcion_editar', {
    user: req.session.user,
    reg,
    tournaments,
    categories,
    destId,
    ageBandsByDiscipline,
    suggestedId: suggested ? suggested.id : null,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

// Guarda la edición / movimiento de una inscripción propia (profesor)
router.post('/inscripciones/:id/editar', async (req, res) => {
  const regId = parseInt(req.params.id, 10);
  const reg = await inscEdit.getRegistration(regId);
  if (!reg || reg.teacher_id !== req.session.user.id) {
    return res.status(404).render('error', { title: 'Inscripción No Encontrada', message: 'La inscripción no existe o no pertenece a tu padrón.' });
  }

  const tournament_id = req.body.tournament_id ? parseInt(req.body.tournament_id) || null : null;
  const category_id = req.body.category_id ? parseInt(req.body.category_id) || null : null;
  const notes = String(req.body.notes || '').toUpperCase();

  const back = (error) => res.redirect(`/profesor/inscripciones/${regId}/editar?tournament_id=${tournament_id || ''}&error=${encodeURIComponent(error)}`);

  if (!tournament_id || !category_id) {
    return back('Debe seleccionar torneo y categoría.');
  }

  const category = await db.prepare(`SELECT * FROM categories WHERE id = ?`).get(category_id);
  if (!category || category.tournament_id !== tournament_id) {
    return back('La categoría elegida no pertenece al torneo seleccionado.');
  }

  if (tournament_id !== reg.tournament_id) {
    const conflicts = await inscEdit.findConflicts(reg, tournament_id);
    if (conflicts.length) {
      return back('No se puede mover: alguna de las patinadoras ya está inscripta en el torneo de destino.');
    }
  }

  // Tampoco se puede editar una inscripción para dejarla repetida.
  const repetida = await inscEdit.findDuplicateInCategory(
    tournament_id, category_id, reg.studentIds, regId
  );
  if (repetida.length) return back(inscEdit.duplicateMessage(repetida));

  // Edad y categoría de edad: manda lo que eligió la profesora en el formulario.
  let age = parseInt(req.body.age, 10);
  if (!Number.isFinite(age) || age <= 0 || age > 120) age = reg.age || null;

  const age_band = req.body.age_band !== undefined
    ? (String(req.body.age_band).trim().toUpperCase() || null)
    : inscEdit.resolveAgeBand(category.discipline, category.name);

  await db.prepare(`UPDATE registrations SET tournament_id = ?, category_id = ?, notes = ?, age_band = ?, age = ? WHERE id = ?`)
    .run(tournament_id, category_id, notes, age_band, age, regId);

  res.redirect('/profesor/dashboard?success=' + encodeURIComponent('Inscripción actualizada correctamente.'));
});

// Notificaciones de la campana (JSON para el dropdown)
router.get('/notificaciones', async (req, res) => {
  const teacherId = req.session.user.id;
  const notifs = await db.prepare(`
    SELECT * FROM notifications WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 20
  `).all(teacherId);
  res.json(notifs);
});

// Marcar todas las notificaciones como leídas
router.post('/notificaciones/leer', async (req, res) => {
  const teacherId = req.session.user.id;
  await db.prepare(`UPDATE notifications SET is_read = true WHERE user_id = ? AND is_read = false`).run(teacherId);
  res.json({ ok: true });
});

// Printable Enrollment Certificate
router.get('/certificado/:id', async (req, res) => {
  const teacherId = req.session.user.id;
  const regId = req.params.id;

  const registration = await db.prepare(`
    SELECT r.*,
    s.first_name, s.last_name, s.dni, s.birth_date, s.health_insurance, s.policy_number,
    t.name as tournament_name, t.venue, t.event_date, t.date_from, t.date_to,
    c.name as category_name, c.discipline, c.division as level,
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

  registration.datesLabel = formatEventDates(registration.date_from || registration.event_date, registration.date_to);

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
