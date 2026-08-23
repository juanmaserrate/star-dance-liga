const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../database');
const { requireAuth, requireRole, scopeFilter, canManageTournament, getAdminScope, ROLES } = require('../middleware/auth');
const { formatEventDates, formatDeadline } = require('../lib/dates');
const { formatCategoryName } = require('../lib/categories');
const insc = require('../lib/inscripciones_export');
const inscEdit = require('../lib/inscripcion_editar');
const errDb = require('../lib/errores_db');
const tcfg = require('../lib/tournament_config');

// All routes require role 'admin' (o el combinado 'profesor_admin')
router.use(requireAuth, requireRole('admin'));

// Un administrador con alcance limitado a una zona (ej: Giselle → CABA) gestiona
// los torneos de su zona, pero no las cuentas de usuario ni el sitio público.
const SCOPED_FORBIDDEN = ['/usuarios', '/cms'];
router.use((req, res, next) => {
  const scope = getAdminScope(req.session.user);
  if (scope && SCOPED_FORBIDDEN.some(p => req.path === p || req.path.startsWith(p + '/'))) {
    return res.status(403).render('error', {
      title: 'Acceso Denegado',
      message: `Tu acceso de administración está limitado a los torneos de ${scope}. La gestión de usuarios y del sitio público queda a cargo de la administración general.`
    });
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

// Helper: convierte un valor a entero positivo o null (evita que params
// inválidos como ?tournament_id=abc rompan la consulta / el proceso).
function toInt(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Admin Dashboard — con filtro por torneo: al elegir uno, todas las cifras y
// listados de abajo muestran solo los datos de las inscripciones de ese torneo.
router.get('/dashboard', async (req, res) => {
  const tournamentId = toInt(req.query.tournament_id);

  // Torneos que puede ver este usuario (Giselle solo ve los de su zona).
  const scope = scopeFilter(req.session.user, 't.name');
  const tournaments = await db.prepare(`
    SELECT t.* FROM tournaments t WHERE 1=1${scope.sql}
    ORDER BY COALESCE(t.date_from, t.event_date) DESC
  `).all(...scope.params);
  tournaments.forEach(t => { t.datesLabel = formatEventDates(t.date_from || t.event_date, t.date_to); });

  // Si eligió un torneo fuera de su alcance, se ignora el filtro.
  const selectedTournament = tournamentId
    ? tournaments.find(t => t.id === tournamentId) || null
    : null;
  const filterId = selectedTournament ? selectedTournament.id : null;

  // Filtros reutilizables según haya o no torneo seleccionado.
  const regWhere = filterId ? ` AND r.tournament_id = ?` : '';
  const regParams = filterId ? [filterId] : [];
  // Patinadoras: si hay torneo, solo las que tienen alguna inscripción en él.
  const studentWhere = filterId
    ? ` AND EXISTS (
          SELECT 1 FROM registrations r
          WHERE r.tournament_id = ?
            AND (r.student_id = s.id OR EXISTS (
              SELECT 1 FROM registration_members rm
              WHERE rm.registration_id = r.id AND rm.student_id = s.id
            ))
        )`
    : '';
  const studentParams = filterId ? [filterId] : [];

  const totalSkaters = (await db.prepare(`
    SELECT COUNT(*) as count FROM students s WHERE 1=1${studentWhere}
  `).get(...studentParams)).count;

  const totalRegistrations = (await db.prepare(`
    SELECT COUNT(*) as count FROM registrations r WHERE 1=1${regWhere}
  `).get(...regParams)).count;

  const totalClubs = (await db.prepare(`SELECT COUNT(*) as count FROM clubs`).get()).count;
  const totalTournaments = tournaments.length;

  const registrationsByClub = await db.prepare(`
    SELECT cl.name as club_name, COUNT(r.id) as count
    FROM registrations r
    JOIN clubs cl ON r.club_id = cl.id
    WHERE 1=1${regWhere}
    GROUP BY cl.id
    ORDER BY count DESC
  `).all(...regParams);

  const registrationsByDiscipline = await db.prepare(`
    SELECT c.discipline, COUNT(r.id) as count
    FROM registrations r
    JOIN categories c ON r.category_id = c.id
    WHERE 1=1${regWhere}
    GROUP BY c.discipline
    ORDER BY count DESC
  `).all(...regParams);

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
    WHERE 1=1${regWhere}
    ORDER BY r.created_at DESC LIMIT 10
  `).all(...regParams);

  const studentsList = await db.prepare(`
    SELECT s.*,
    c.name as club_name,
    u.full_name as teacher_name,
    (SELECT COUNT(*) FROM student_documents d WHERE d.student_id = s.id) as doc_count,
    (SELECT COUNT(*) FROM registrations r WHERE r.student_id = s.id) as reg_count
    FROM students s
    JOIN clubs c ON s.club_id = c.id
    JOIN users u ON s.teacher_id = u.id
    WHERE 1=1${studentWhere}
    ORDER BY s.last_name ASC, s.first_name ASC
  `).all(...studentParams);
  studentsList.forEach(s => { s.age = getCalendarAge(s.birth_date); });

  res.render('admin/dashboard', {
    user: req.session.user,
    stats: {
      totalSkaters,
      totalRegistrations,
      totalClubs,
      totalTournaments
    },
    tournaments,
    selectedTournament,
    selectedTournamentId: filterId || '',
    registrationsByClub,
    registrationsByDiscipline,
    recentRegistrations,
    studentsList,
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// Master Registrations Table (With Filters)
router.get('/inscripciones', async (req, res) => {
  const { buscar, disciplina, categoria } = req.query;
  const tournament_id = toInt(req.query.tournament_id);
  const club_id = toInt(req.query.club_id);

  const tournament_scope = getAdminScope(req.session.user);

  const registrations = await insc.fetchRegistrations({
    tournament_id, club_id, buscar, disciplina, categoria, tournament_scope
  });

  const scope = scopeFilter(req.session.user, 't.name');
  const tournaments = await db.prepare(`
    SELECT t.* FROM tournaments t WHERE 1=1${scope.sql}
    ORDER BY COALESCE(t.date_from, t.event_date) DESC
  `).all(...scope.params);
  tournaments.forEach(t => { t.datesLabel = formatEventDates(t.date_from || t.event_date, t.date_to); });
  const clubs = await db.prepare(`SELECT * FROM clubs ORDER BY name ASC`).all();

  res.render('admin/inscripciones', {
    user: req.session.user,
    registrations,
    tournaments,
    clubs,
    exportFields: insc.EXPORT_FIELDS,
    selectedTournament: tournament_id || '',
    selectedClub: club_id || '',
    buscar: buscar || '',
    disciplina: disciplina || '',
    categoria: categoria || '',
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// Formulario de edición / movimiento de una inscripción (admin)
router.get('/inscripciones/:id/editar', async (req, res) => {
  const regId = parseInt(req.params.id, 10);
  const reg = await inscEdit.getRegistration(regId);
  if (!reg) return res.status(404).render('error', { title: 'Inscripción No Encontrada', message: 'La inscripción solicitada no existe.' });

  if (!canManageTournament(req.session.user, { name: reg.tournament_name })) {
    return res.status(403).render('error', {
      title: 'Acceso Denegado',
      message: 'Esta inscripción pertenece a un torneo fuera de tu alcance de administración.'
    });
  }

  const scope = scopeFilter(req.session.user, 't.name');
  const tournaments = await db.prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM categories c WHERE c.tournament_id = t.id) AS category_count
    FROM tournaments t
    WHERE 1=1${scope.sql}
    ORDER BY COALESCE(t.date_from, t.event_date) DESC
  `).all(...scope.params);
  tournaments.forEach(t => { t.datesLabel = formatEventDates(t.date_from || t.event_date, t.date_to); });

  const destId = toInt(req.query.tournament_id) || reg.tournament_id;
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

  const tc = require('../lib/tournament_config');
  const ageBandsByDiscipline = destId ? await tc.getAgeBandsByDiscipline(destId) : {};

  res.render('admin/inscripcion_editar', {
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

// Guarda la edición / movimiento de una inscripción (admin)
router.post('/inscripciones/:id/editar', async (req, res) => {
  const regId = parseInt(req.params.id, 10);
  const reg = await inscEdit.getRegistration(regId);
  if (!reg) return res.status(404).render('error', { title: 'Inscripción No Encontrada', message: 'La inscripción solicitada no existe.' });

  if (!canManageTournament(req.session.user, { name: reg.tournament_name })) {
    return res.status(403).render('error', {
      title: 'Acceso Denegado',
      message: 'Esta inscripción pertenece a un torneo fuera de tu alcance de administración.'
    });
  }

  const tournament_id = toInt(req.body.tournament_id);
  const category_id = toInt(req.body.category_id);
  const notes = String(req.body.notes || '').toUpperCase();
  const status = ['registered', 'confirmed', 'cancelled'].includes(req.body.status) ? req.body.status : reg.status;

  const back = (error) => res.redirect(`/admin/inscripciones/${regId}/editar?tournament_id=${tournament_id || ''}&error=${encodeURIComponent(error)}`);

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

  // Una inscripción no puede quedar repetida dentro del mismo torneo. Las
  // canceladas no cuentan, así que el administrador puede reactivar sin trabas.
  if (status !== 'cancelled') {
    const repetida = await inscEdit.findDuplicateInCategory(
      tournament_id, category_id, reg.studentIds, regId
    );
    if (repetida.length) return back(inscEdit.duplicateMessage(repetida));
  }

  // Edad y categoría de edad: manda lo que se eligió en el formulario. Si no
  // vino nada, se resuelve por la categoría (comportamiento anterior).
  let age = parseInt(req.body.age, 10);
  if (!Number.isFinite(age) || age <= 0 || age > 120) age = reg.age || null;

  const age_band = req.body.age_band !== undefined
    ? (String(req.body.age_band).trim().toUpperCase() || null)
    : inscEdit.resolveAgeBand(category.discipline, category.name);

  await db.prepare(`UPDATE registrations SET tournament_id = ?, category_id = ?, notes = ?, status = ?, age_band = ?, age = ? WHERE id = ?`)
    .run(tournament_id, category_id, notes, status, age_band, age, regId);

  res.redirect('/admin/inscripciones?success=' + encodeURIComponent('Inscripción actualizada correctamente.'));
});


// Eliminar una inscripción (administrador). Respeta el alcance por zona: un
// administrador de CABA no puede borrar inscripciones de otros torneos.
router.post('/inscripciones/:id/eliminar', async (req, res) => {
  const regId = toInt(req.params.id);
  const reg = await inscEdit.getRegistration(regId);
  if (!reg) {
    return res.redirect('/admin/inscripciones?error=' + encodeURIComponent('La inscripción no existe o ya fue eliminada.'));
  }

  const alcance = getAdminScope(req.session.user);
  if (alcance && !String(reg.tournament_name || '').toUpperCase().includes(String(alcance).toUpperCase())) {
    return res.redirect('/admin/inscripciones?error=' + encodeURIComponent('Esa inscripción está fuera de tu alcance de administración.'));
  }

  const r = await inscEdit.eliminarRegistration(regId, req.session.user);
  if (!r.ok) {
    return res.redirect('/admin/inscripciones?error=' + encodeURIComponent(r.error));
  }

  res.redirect('/admin/inscripciones?success=' + encodeURIComponent(
    `Inscripción de ${r.quien} en ${reg.tournament_name} eliminada.`));
});

// Export CSV (campos seleccionables, datos completos de la inscripción)
router.get('/exportar/csv', async (req, res) => {
  const { buscar, disciplina, categoria, fields } = req.query;
  const tournament_id = toInt(req.query.tournament_id);
  const club_id = toInt(req.query.club_id);
  try {
    const selectedFields = insc.resolveFields(fields);
    const registrations = await insc.fetchRegistrations({
      tournament_id, club_id, buscar, disciplina, categoria,
      tournament_scope: getAdminScope(req.session.user)
    });
    const csv = insc.buildCsv(registrations, selectedFields);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="INSCRIPCIONES_STAR_DANCE_${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('Error exporting CSV:', err);
    res.status(500).send('Error al exportar el CSV. Intente nuevamente.');
  }
});

// Export Excel .xlsx (tabla dinámica estética con la paleta del sistema y campos seleccionables)
router.get('/exportar/excel', async (req, res) => {
  const { buscar, disciplina, categoria, fields } = req.query;
  const tournament_id = toInt(req.query.tournament_id);
  const club_id = toInt(req.query.club_id);
  try {
    const selectedFields = insc.resolveFields(fields);
    const filters = {
      tournament_id, club_id, buscar, disciplina, categoria,
      tournament_scope: getAdminScope(req.session.user)
    };

    if (filters.tournament_id) {
      const t = await db.prepare(`SELECT name FROM tournaments WHERE id = ?`).get(filters.tournament_id);
      if (t) filters.tournament_name = t.name;
    }
    if (filters.club_id) {
      const c = await db.prepare(`SELECT name FROM clubs WHERE id = ?`).get(filters.club_id);
      if (c) filters.club_name = c.name;
    }

    const registrations = await insc.fetchRegistrations(filters);
    const meta = insc.buildMeta(filters, registrations.length);
    const buffer = await insc.buildXlsx(registrations, selectedFields, meta);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="PLANILLA_INSCRIPCIONES_STAR_DANCE_${Date.now()}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('Error exporting Excel:', err);
    res.status(500).send('Error al exportar el Excel. Intente nuevamente.');
  }
});

// Planilla del torneo: una sola hoja, agrupada por disciplina y, adentro, un
// bloque por categoría. Es la que se baja desde el dashboard.
router.get('/exportar/planilla', async (req, res) => {
  const tournamentId = toInt(req.query.tournament_id);
  if (!tournamentId) {
    return res.redirect('/admin/dashboard?error=' + encodeURIComponent('Elegí un torneo para descargar su planilla.'));
  }

  try {
    const tournament = await loadTournamentForUser(req, tournamentId);
    if (!tournament) {
      return res.redirect('/admin/dashboard?error=' + encodeURIComponent('Torneo no encontrado o fuera de tu alcance.'));
    }
    tournament.datesLabel = formatEventDates(tournament.date_from || tournament.event_date, tournament.date_to);

    // Cuatro armados posibles. El Libro Mayor es el que se usa el dia del
    // torneo, asi que es el que sale por defecto.
    const agrupar = String(req.query.agrupar || 'libro_mayor');
    const armados = {
      libro_mayor: { build: insc.buildXlsxLibroMayor, sufijo: '_LIBRO_MAYOR' },
      disciplina: { build: insc.buildXlsxPorCategoria, sufijo: '_POR_DISCIPLINA' },
      categoria: { build: insc.buildXlsxPorCategoriaSola, sufijo: '_POR_CATEGORIA' },
      categoria_hojas: { build: insc.buildXlsxHojaPorCategoria, sufijo: '_POR_CATEGORIA_EN_HOJAS' }
    };
    // Cualquier valor desconocido (incluido el nombre anterior, orden_pista)
    // cae en el Libro Mayor, que es el armado por defecto.
    const armado = armados[agrupar] || armados.libro_mayor;

    const rows = await insc.fetchForGroupedSheet(tournament.id);
    const buffer = await armado.build(rows, tournament);

    const slug = String(tournament.name).normalize('NFD').replace(/\p{Diacritic}/gu, '')
      .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toUpperCase() || 'TORNEO';
    const sufijo = armado.sufijo;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="PLANILLA_${slug}${sufijo}.xlsx"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('Error exporting tournament sheet:', err);
    res.status(500).send('Error al generar la planilla del torneo. Intente nuevamente.');
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

// Carga un torneo verificando que el usuario tenga alcance sobre él.
// Devuelve null si no existe o si está fuera de su zona (ej: Giselle y CABA).
async function loadTournamentForUser(req, id) {
  const tournament = await db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(id);
  if (!tournament) return null;
  if (!canManageTournament(req.session.user, tournament)) return null;
  return tournament;
}

// Manage Tournaments List
router.get('/torneos', async (req, res) => {
  const scope = scopeFilter(req.session.user, 't.name');
  const tournaments = await db.prepare(`
    SELECT t.*,
    (SELECT COUNT(*) FROM categories c WHERE c.tournament_id = t.id) as category_count,
    (SELECT COUNT(*) FROM registrations r WHERE r.tournament_id = t.id) as reg_count
    FROM tournaments t
    WHERE 1=1${scope.sql}
    ORDER BY COALESCE(t.date_from, t.event_date) DESC
  `).all(...scope.params);
  tournaments.forEach(t => { t.datesLabel = formatEventDates(t.date_from || t.event_date, t.date_to); t.deadlineLabel = formatDeadline(t.registration_deadline); });

  res.render('admin/torneos', {
    user: req.session.user,
    tournaments,
    adminScope: getAdminScope(req.session.user),
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// Form: Edit Tournament (todos los campos)
router.get('/torneos/:id/editar', async (req, res) => {
  const tournament = await loadTournamentForUser(req, toInt(req.params.id));
  if (!tournament) {
    return res.status(404).render('error', {
      title: 'Torneo No Encontrado',
      message: 'El torneo no existe o no está dentro de tu alcance de administración.'
    });
  }

  res.render('admin/torneo_form', {
    user: req.session.user,
    tournament,
    isEdit: true,
    error: req.query.error || null
  });
});

// Save Edited Tournament. Al renombrarlo, el cambio se ve en todos lados
// (inscripciones a realizar y ya hechas) porque todo referencia el id del torneo.
router.post('/torneos/:id/editar', async (req, res) => {
  const tournamentId = toInt(req.params.id);
  const tournament = await loadTournamentForUser(req, tournamentId);
  if (!tournament) {
    return res.status(404).render('error', {
      title: 'Torneo No Encontrado',
      message: 'El torneo no existe o no está dentro de tu alcance de administración.'
    });
  }

  const { name, description, venue, event_date, date_from, date_to, registration_deadline, status } = req.body;
  const fechaDesde = date_from || event_date;
  const fechaHasta = date_to || fechaDesde;

  const rerender = (error) => res.render('admin/torneo_form', {
    user: req.session.user,
    tournament: { ...tournament, ...req.body },
    isEdit: true,
    error
  });

  if (!name || !venue || !fechaDesde || !registration_deadline) {
    return rerender('Nombre, sede, fecha de inicio y cierre de inscripciones son obligatorios.');
  }

  const allowedStatus = ['upcoming', 'active', 'finished'];
  const newStatus = allowedStatus.includes(status) ? status : tournament.status;

  try {
    await db.prepare(`
      UPDATE tournaments SET
        name = ?, description = ?, venue = ?,
        event_date = ?, date_from = ?, date_to = ?,
        registration_deadline = ?, status = ?
      WHERE id = ?
    `).run(
      name.trim().toUpperCase(),
      (description || '').toUpperCase(),
      venue.trim().toUpperCase(),
      fechaDesde,
      fechaDesde,
      fechaHasta,
      registration_deadline,
      newStatus,
      tournamentId
    );

    res.redirect('/admin/torneos?success=' + encodeURIComponent(`Torneo "${name.trim().toUpperCase()}" actualizado. El cambio se refleja en las inscripciones nuevas y en las ya realizadas.`));
  } catch (err) {
    console.error('Error updating tournament:', err);
    rerender('Error al guardar los cambios del torneo.');
  }
});

// Delete Tournament. Se bloquea si tiene inscripciones, para no perder datos.
router.post('/torneos/:id/eliminar', async (req, res) => {
  const tournamentId = toInt(req.params.id);
  const tournament = await loadTournamentForUser(req, tournamentId);
  if (!tournament) {
    return res.redirect('/admin/torneos?error=' + encodeURIComponent('Torneo no encontrado o fuera de tu alcance.'));
  }

  const regs = await db.prepare(`SELECT COUNT(*) as count FROM registrations WHERE tournament_id = ?`).get(tournamentId);
  if (Number(regs.count) > 0) {
    return res.redirect('/admin/torneos?error=' + encodeURIComponent(
      `No se puede eliminar "${tournament.name}": tiene ${regs.count} inscripción(es). Mové o cancelá esas inscripciones primero.`
    ));
  }

  try {
    await db.prepare(`DELETE FROM tournaments WHERE id = ?`).run(tournamentId);
    res.redirect('/admin/torneos?success=' + encodeURIComponent(`Torneo "${tournament.name}" eliminado.`));
  } catch (err) {
    console.error('Error deleting tournament:', err);
    res.redirect('/admin/torneos?error=' + encodeURIComponent('Error al eliminar el torneo.'));
  }
});

// Update Tournament Status (upcoming / active / finished)
router.post('/torneos/:id/estado', async (req, res) => {
  const tournamentId = req.params.id;
  const { status } = req.body;

  const allowed = ['upcoming', 'active', 'finished'];
  if (!allowed.includes(status)) {
    return res.redirect('/admin/torneos?error=' + encodeURIComponent('Estado de torneo inválido.'));
  }

  const tournament = await db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(tournamentId);
  if (!tournament) {
    return res.redirect('/admin/torneos?error=' + encodeURIComponent('Torneo no encontrado.'));
  }

  try {
    await db.prepare(`UPDATE tournaments SET status = ? WHERE id = ?`).run(status, tournamentId);
    res.redirect('/admin/torneos?success=' + encodeURIComponent(`Estado del torneo "${tournament.name}" actualizado a ${status.toUpperCase()}.`));
  } catch (err) {
    console.error('Error updating tournament status:', err);
    res.redirect('/admin/torneos?error=' + encodeURIComponent('Error al actualizar el estado del torneo.'));
  }
});

// Form: New Tournament
router.get('/torneos/nuevo', (req, res) => {
  res.render('admin/torneo_form', {
    user: req.session.user,
    tournament: null,
    isEdit: false,
    error: null
  });
});

// Save Tournament
router.post('/torneos/nuevo', async (req, res) => {
  const { name, description, venue, event_date, date_from, date_to, registration_deadline, status } = req.body;

  const fechaDesde = date_from || event_date;
  const fechaHasta = date_to || fechaDesde;

  if (!name || !venue || !fechaDesde || !registration_deadline) {
    return res.render('admin/torneo_form', {
      user: req.session.user,
      tournament: req.body,
      isEdit: false,
      error: 'Por favor complete los campos obligatorios del torneo.'
    });
  }

  try {
    const info = await db.prepare(`
      INSERT INTO tournaments (name, description, venue, event_date, date_from, date_to, registration_deadline, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
    `).run(
      name.trim().toUpperCase(),
      (description || '').toUpperCase(),
      venue.trim().toUpperCase(),
      fechaDesde,
      fechaDesde,
      fechaHasta,
      registration_deadline,
      status || 'upcoming'
    );

    // El torneo nuevo arranca con el catálogo oficial completo cargado, para
    // que las profesoras puedan inscribir desde el primer momento.
    const newId = info.lastInsertRowid;
    await tcfg.seedTournament(newId);
    await tcfg.seedCategories(newId);

    res.redirect(`/admin/torneos/${newId}/categorias?success=` + encodeURIComponent('Torneo creado con el catálogo oficial de disciplinas y categorías. Ajustá lo que necesites.'));
  } catch (err) {
    console.error('Error creating tournament:', err);
    res.render('admin/torneo_form', {
      user: req.session.user,
      tournament: req.body,
      isEdit: false,
      error: 'Error al guardar el torneo.'
    });
  }
});

// ---------------------------------------------------------------------------
// Configuración de un torneo: disciplinas, categorías y categorías de edad.
// Todo es por torneo, así cada fecha puede tener su propia grilla.
// ---------------------------------------------------------------------------

// Parte un textarea en líneas limpias, sin vacías ni repetidas.
function splitLines(text) {
  const seen = new Set();
  return String(text || '')
    .split(/\r?\n|;/)
    .map(l => l.trim().toUpperCase())
    .filter(l => {
      if (!l || seen.has(l)) return false;
      seen.add(l);
      return true;
    });
}

// Interpreta una línea de categoría de edad: "BABY 4-5", "BABY 4 5",
// "BABY: 4 a 5", "BABY 4-5 años". Devuelve { name, min, max } o null.
function parseBandLine(line) {
  const m = String(line).trim()
    .match(/^(.*?)[\s:,\-]*(\d{1,3})\s*(?:-|–|a|\/|\s)\s*(\d{1,3})\s*(?:AÑOS|ANOS)?$/i);
  if (!m) return null;
  const name = m[1].trim().toUpperCase();
  const min = parseInt(m[2], 10);
  const max = parseInt(m[3], 10);
  if (!name || !Number.isFinite(min) || !Number.isFinite(max) || min > max) return null;
  return { name, min, max };
}

// Vuelve a la pantalla de configuración con un mensaje.
function backToConfig(res, tournamentId, { success, error } = {}) {
  const qs = success
    ? '?success=' + encodeURIComponent(success)
    : (error ? '?error=' + encodeURIComponent(error) : '');
  return res.redirect(`/admin/torneos/${tournamentId}/categorias${qs}`);
}

router.get('/torneos/:id/categorias', async (req, res) => {
  const tournament = await loadTournamentForUser(req, toInt(req.params.id));
  if (!tournament) {
    return res.status(404).render('error', {
      title: 'Torneo No Encontrado',
      message: 'El torneo no existe o no está dentro de tu alcance de administración.'
    });
  }

  // Si es un torneo nuevo, se le siembra la configuración del catálogo oficial
  // (disciplinas, categorías de edad y, si está vacío, también las categorías).
  await tcfg.seedTournament(tournament.id);
  const catCount = await db.prepare(`SELECT COUNT(*) AS count FROM categories WHERE tournament_id = ?`).get(tournament.id);
  if (Number(catCount.count) === 0) await tcfg.seedCategories(tournament.id);

  const disciplines = await tcfg.getDisciplines(tournament.id, { includeDisabled: true });

  const categories = await db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM registrations r WHERE r.category_id = c.id) AS reg_count
    FROM categories c
    WHERE c.tournament_id = ?
    ORDER BY c.discipline ASC, c.order_index ASC, c.name ASC
  `).all(tournament.id);
  categories.forEach(c => { c.label = formatCategoryName(c.name, c.discipline); });

  const ageBands = await db.prepare(`
    SELECT * FROM tournament_age_bands WHERE tournament_id = ?
    ORDER BY discipline ASC, order_index ASC, min_age ASC
  `).all(tournament.id);

  // Agrupa por disciplina para armar una tarjeta por cada una.
  const configuredNames = new Set(disciplines.map(d => d.discipline));
  const extraNames = [...new Set(categories.map(c => c.discipline))]
    .filter(d => d && !configuredNames.has(d));

  // Reglamentos presentes en cada disciplina (hoy solo ADULTOS los usa).
  const rulesetsOf = disc => [...new Set(
    categories.filter(c => c.discipline === disc && c.ruleset).map(c => c.ruleset)
  )];

  const groups = disciplines.map(d => ({
    discipline: d.discipline,
    order_index: d.order_index,
    is_enabled: d.is_enabled,
    isLegacy: false,
    categories: categories.filter(c => c.discipline === d.discipline),
    rulesets: rulesetsOf(d.discipline),
    bands: ageBands.filter(b => b.discipline === d.discipline)
  }));

  // Disciplinas viejas que ya no están en el catálogo pero conservan
  // inscripciones (ej: STAR DANCE y STYLE, ahora categorías de FREE DANCE).
  extraNames.forEach(name => {
    groups.push({
      discipline: name,
      order_index: 999,
      is_enabled: false,
      isLegacy: true,
      categories: categories.filter(c => c.discipline === name),
      rulesets: rulesetsOf(name),
      bands: ageBands.filter(b => b.discipline === name)
    });
  });

  // Otros torneos del alcance del usuario, para copiarles la configuración.
  const scope = scopeFilter(req.session.user, 't.name');
  const otherTournaments = await db.prepare(`
    SELECT t.id, t.name FROM tournaments t WHERE t.id <> ?${scope.sql}
    ORDER BY COALESCE(t.date_from, t.event_date) DESC
  `).all(tournament.id, ...scope.params);

  res.render('admin/categorias', {
    user: req.session.user,
    tournament,
    groups,
    otherTournaments,
    totalCategories: categories.length,
    totalDisciplines: groups.filter(g => !g.isLegacy).length,
    totalBands: ageBands.length,
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// --- Atajos de configuración ----------------------------------------------

// Vuelve a traer del catálogo oficial todo lo que le falte al torneo. Es
// aditivo: no borra ni renombra nada de lo que el administrador ya cargó.
router.post('/torneos/:id/restaurar-catalogo', async (req, res) => {
  const tournament = await loadTournamentForUser(req, toInt(req.params.id));
  if (!tournament) return res.redirect('/admin/torneos?error=' + encodeURIComponent('Torneo no encontrado.'));

  try {
    const cfg = await tcfg.seedTournament(tournament.id);
    const cats = await tcfg.seedCategories(tournament.id);
    backToConfig(res, tournament.id, {
      success: `Catálogo oficial restaurado: ${cfg.disciplines} disciplina(s), ${cats.added} categoría(s) y ${cfg.bands} categoría(s) de edad agregadas. No se borró nada de lo que ya tenías.`
    });
  } catch (err) {
    console.error('Error restoring catalog:', err);
    backToConfig(res, tournament.id, { error: 'Error al restaurar el catálogo oficial.' });
  }
});

// Copia la configuración de otro torneo (disciplinas, categorías y categorías
// de edad). Solo agrega lo que falta; nunca pisa ni borra lo que ya está.
router.post('/torneos/:id/copiar-de', async (req, res) => {
  const tournament = await loadTournamentForUser(req, toInt(req.params.id));
  if (!tournament) return res.redirect('/admin/torneos?error=' + encodeURIComponent('Torneo no encontrado.'));

  const origen = await loadTournamentForUser(req, toInt(req.body.source_tournament_id));
  if (!origen) return backToConfig(res, tournament.id, { error: 'Elegí un torneo de origen válido.' });
  if (origen.id === tournament.id) {
    return backToConfig(res, tournament.id, { error: 'El torneo de origen tiene que ser otro.' });
  }

  try {
    let discs = 0, cats = 0, bands = 0;

    for (const d of await tcfg.getDisciplines(origen.id, { includeDisabled: true })) {
      const r = await db.prepare(`
        INSERT INTO tournament_disciplines (tournament_id, discipline, order_index, is_enabled)
        VALUES (?, ?, ?, ?) ON CONFLICT (tournament_id, discipline) DO NOTHING
      `).run(tournament.id, d.discipline, d.order_index, d.is_enabled);
      if (r && r.changes) discs++;
    }

    const origenCats = await db.prepare(`
      SELECT name, discipline, division, schedule, is_active, order_index, ruleset
      FROM categories WHERE tournament_id = ? ORDER BY discipline ASC, order_index ASC
    `).all(origen.id);
    for (const c of origenCats) {
      const dup = await db.prepare(`
        SELECT id FROM categories WHERE tournament_id = ? AND discipline = ? AND name = ?
      `).get(tournament.id, c.discipline, c.name);
      if (dup) continue;
      await db.prepare(`
        INSERT INTO categories (tournament_id, name, discipline, division, min_age, max_age, gender, schedule, is_active, order_index, ruleset)
        VALUES (?, ?, ?, ?, 0, 99, 'MIXTO', ?, ?, ?, ?)
      `).run(tournament.id, c.name, c.discipline, c.division,
        c.schedule || 'A CONFIRMAR', c.is_active !== false, c.order_index || 0, c.ruleset || null);
      cats++;
    }

    const origenBands = await db.prepare(`
      SELECT discipline, name, min_age, max_age, order_index
      FROM tournament_age_bands WHERE tournament_id = ? ORDER BY discipline ASC, order_index ASC
    `).all(origen.id);
    for (const b of origenBands) {
      const r = await db.prepare(`
        INSERT INTO tournament_age_bands (tournament_id, discipline, name, min_age, max_age, order_index)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (tournament_id, discipline, name) DO NOTHING
      `).run(tournament.id, b.discipline, b.name, b.min_age, b.max_age, b.order_index || 0);
      if (r && r.changes) bands++;
    }

    backToConfig(res, tournament.id, {
      success: `Copiado de ${origen.name}: ${discs} disciplina(s), ${cats} categoría(s) y ${bands} categoría(s) de edad. Lo que ya tenías quedó igual.`
    });
  } catch (err) {
    console.error('Error copying tournament config:', err);
    backToConfig(res, tournament.id, { error: 'Error al copiar la configuración del otro torneo.' });
  }
});

// --- Disciplinas -----------------------------------------------------------

// Alta de una disciplina nueva en el torneo
router.post('/torneos/:id/disciplinas', async (req, res) => {
  const tournament = await loadTournamentForUser(req, toInt(req.params.id));
  if (!tournament) return res.redirect('/admin/torneos?error=' + encodeURIComponent('Torneo no encontrado.'));

  const name = String(req.body.discipline || '').trim().toUpperCase();
  if (!name) return backToConfig(res, tournament.id, { error: 'Escribí el nombre de la disciplina.' });

  const last = await db.prepare(`
    SELECT COALESCE(MAX(order_index), -1) AS max FROM tournament_disciplines WHERE tournament_id = ?
  `).get(tournament.id);

  try {
    await db.prepare(`
      INSERT INTO tournament_disciplines (tournament_id, discipline, order_index, is_enabled)
      VALUES (?, ?, ?, true)
      ON CONFLICT (tournament_id, discipline) DO UPDATE SET is_enabled = true
    `).run(tournament.id, name, Number(last.max) + 1);
    backToConfig(res, tournament.id, { success: `Disciplina ${name} agregada al torneo.` });
  } catch (err) {
    console.error('Error adding discipline:', err);
    backToConfig(res, tournament.id, { error: 'Error al agregar la disciplina.' });
  }
});

// Habilitar / deshabilitar y reordenar una disciplina
router.post('/torneos/:id/disciplinas/actualizar', async (req, res) => {
  const tournament = await loadTournamentForUser(req, toInt(req.params.id));
  if (!tournament) return res.redirect('/admin/torneos?error=' + encodeURIComponent('Torneo no encontrado.'));

  const discipline = String(req.body.discipline || '').trim();
  const isEnabled = req.body.is_enabled === '1';
  const orderIndex = toInt(req.body.order_index);

  try {
    await db.prepare(`
      UPDATE tournament_disciplines
      SET is_enabled = ?, order_index = COALESCE(?, order_index)
      WHERE tournament_id = ? AND discipline = ?
    `).run(isEnabled, orderIndex, tournament.id, discipline);
    backToConfig(res, tournament.id, { success: `Disciplina ${discipline} actualizada.` });
  } catch (err) {
    console.error('Error updating discipline:', err);
    backToConfig(res, tournament.id, { error: 'Error al actualizar la disciplina.' });
  }
});

// Quitar una disciplina del torneo (solo si ninguna de sus categorías tiene inscripciones)
router.post('/torneos/:id/disciplinas/eliminar', async (req, res) => {
  const tournament = await loadTournamentForUser(req, toInt(req.params.id));
  if (!tournament) return res.redirect('/admin/torneos?error=' + encodeURIComponent('Torneo no encontrado.'));

  const discipline = String(req.body.discipline || '').trim();

  const used = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM registrations r JOIN categories c ON c.id = r.category_id
    WHERE r.tournament_id = ? AND c.discipline = ?
  `).get(tournament.id, discipline);

  if (Number(used.count) > 0) {
    return backToConfig(res, tournament.id, {
      error: `No se puede quitar ${discipline}: tiene ${used.count} inscripción(es). Podés deshabilitarla para que no aparezca en el formulario.`
    });
  }

  try {
    await db.prepare(`DELETE FROM categories WHERE tournament_id = ? AND discipline = ?`).run(tournament.id, discipline);
    await db.prepare(`DELETE FROM tournament_age_bands WHERE tournament_id = ? AND discipline = ?`).run(tournament.id, discipline);
    await db.prepare(`DELETE FROM tournament_disciplines WHERE tournament_id = ? AND discipline = ?`).run(tournament.id, discipline);
    backToConfig(res, tournament.id, { success: `Disciplina ${discipline} quitada del torneo.` });
  } catch (err) {
    console.error('Error deleting discipline:', err);
    backToConfig(res, tournament.id, { error: 'Error al quitar la disciplina.' });
  }
});

// --- Categorías ------------------------------------------------------------

// Alta de categoría
router.post('/torneos/:id/categorias', async (req, res) => {
  const tournament = await loadTournamentForUser(req, toInt(req.params.id));
  if (!tournament) return res.redirect('/admin/torneos?error=' + encodeURIComponent('Torneo no encontrado.'));

  const { name, discipline, schedule } = req.body;
  if (!name || !discipline) {
    return backToConfig(res, tournament.id, { error: 'Nombre y disciplina son requeridos.' });
  }

  const disc = discipline.trim().toUpperCase();
  const bare = name.trim().toUpperCase();
  // Se guarda con el prefijo "DISCIPLINA - " igual que el catálogo, para que
  // el formulario de inscripción muestre solo el nombre corto.
  const fullName = `${disc} - ${bare}`;

  const dup = await db.prepare(`
    SELECT id FROM categories WHERE tournament_id = ? AND discipline = ? AND name = ?
  `).get(tournament.id, disc, fullName);
  if (dup) {
    return backToConfig(res, tournament.id, { error: `La categoría ${bare} ya existe en ${disc}.` });
  }

  // Va al final de su disciplina; después se puede reordenar.
  const last = await db.prepare(`
    SELECT COALESCE(MAX(order_index), -1) AS max FROM categories WHERE tournament_id = ? AND discipline = ?
  `).get(tournament.id, disc);

  try {
    // Reglamento: el que venga del formulario o, si no, el que le corresponda
    // en el catálogo oficial (ADULTOS).
    const reglamento = String(req.body.ruleset || '').trim().toUpperCase() || tcfg.rulesetFor(disc, bare);

    await db.prepare(`
      INSERT INTO categories (tournament_id, name, discipline, division, min_age, max_age, gender, schedule, is_active, order_index, ruleset)
      VALUES (?, ?, ?, ?, 0, 99, 'MIXTO', ?, true, ?, ?)
    `).run(tournament.id, fullName, disc, bare, (schedule || 'A CONFIRMAR').toUpperCase(), Number(last.max) + 1, reglamento || null);

    // Si la disciplina no estaba en la configuración del torneo, se agrega.
    const last = await db.prepare(`
      SELECT COALESCE(MAX(order_index), -1) AS max FROM tournament_disciplines WHERE tournament_id = ?
    `).get(tournament.id);
    await db.prepare(`
      INSERT INTO tournament_disciplines (tournament_id, discipline, order_index, is_enabled)
      VALUES (?, ?, ?, true) ON CONFLICT (tournament_id, discipline) DO NOTHING
    `).run(tournament.id, disc, Number(last.max) + 1);

    backToConfig(res, tournament.id, { success: `Categoría ${bare} agregada a ${disc}.` });
  } catch (err) {
    console.error('Error creating category:', err);
    backToConfig(res, tournament.id, { error: 'Error al agregar la categoría.' });
  }
});

// Alta en lote: una categoría por renglón. Es la forma rápida de cargar toda
// una disciplina de una vez en vez de ir de a una.
router.post('/torneos/:id/categorias/lote', async (req, res) => {
  const tournament = await loadTournamentForUser(req, toInt(req.params.id));
  if (!tournament) return res.redirect('/admin/torneos?error=' + encodeURIComponent('Torneo no encontrado.'));

  const disc = String(req.body.discipline || '').trim().toUpperCase();
  const nombres = splitLines(req.body.names);
  if (!disc) return backToConfig(res, tournament.id, { error: 'Falta la disciplina.' });
  if (!nombres.length) return backToConfig(res, tournament.id, { error: 'Escribí al menos una categoría (una por renglón).' });

  const reglamentoManual = String(req.body.ruleset || '').trim().toUpperCase();

  try {
    let last = Number((await db.prepare(`
      SELECT COALESCE(MAX(order_index), -1) AS max FROM categories WHERE tournament_id = ? AND discipline = ?
    `).get(tournament.id, disc)).max);

    let creadas = 0;
    const repetidas = [];
    for (const bare of nombres) {
      const fullName = `${disc} - ${bare}`;
      const dup = await db.prepare(`
        SELECT id FROM categories WHERE tournament_id = ? AND discipline = ? AND name = ?
      `).get(tournament.id, disc, fullName);
      if (dup) { repetidas.push(bare); continue; }

      last++;
      await db.prepare(`
        INSERT INTO categories (tournament_id, name, discipline, division, min_age, max_age, gender, schedule, is_active, order_index, ruleset)
        VALUES (?, ?, ?, ?, 0, 99, 'MIXTO', 'A CONFIRMAR', true, ?, ?)
      `).run(tournament.id, fullName, disc, bare, last,
        reglamentoManual || tcfg.rulesetFor(disc, bare) || null);
      creadas++;
    }

    // Si la disciplina no estaba en el torneo, se agrega.
    const lastDisc = await db.prepare(`
      SELECT COALESCE(MAX(order_index), -1) AS max FROM tournament_disciplines WHERE tournament_id = ?
    `).get(tournament.id);
    await db.prepare(`
      INSERT INTO tournament_disciplines (tournament_id, discipline, order_index, is_enabled)
      VALUES (?, ?, ?, true) ON CONFLICT (tournament_id, discipline) DO NOTHING
    `).run(tournament.id, disc, Number(lastDisc.max) + 1);

    const aviso = repetidas.length ? ` (${repetidas.length} ya existían: ${repetidas.join(', ')})` : '';
    backToConfig(res, tournament.id, {
      success: `${creadas} categoría(s) agregada(s) a ${disc}${aviso}.`
    });
  } catch (err) {
    console.error('Error creating categories in bulk:', err);
    backToConfig(res, tournament.id, { error: 'Error al agregar las categorías.' });
  }
});

// Renombrar / editar una categoría
router.post('/torneos/:id/categorias/:catId/editar', async (req, res) => {
  const tournament = await loadTournamentForUser(req, toInt(req.params.id));
  if (!tournament) return res.redirect('/admin/torneos?error=' + encodeURIComponent('Torneo no encontrado.'));

  const catId = toInt(req.params.catId);
  const category = await db.prepare(`SELECT * FROM categories WHERE id = ? AND tournament_id = ?`).get(catId, tournament.id);
  if (!category) return backToConfig(res, tournament.id, { error: 'Categoría no encontrada.' });

  const bare = String(req.body.name || '').trim().toUpperCase();
  if (!bare) return backToConfig(res, tournament.id, { error: 'El nombre de la categoría no puede quedar vacío.' });

  const fullName = `${category.discipline} - ${bare}`;
  const orden = toInt(req.body.order_index);

  try {
    // El reglamento solo se toca si el formulario trae el campo (las disciplinas
    // que no se dividen por reglamento no lo muestran y deben quedar igual).
    const reglamento = req.body.ruleset === undefined
      ? category.ruleset
      : (String(req.body.ruleset).trim().toUpperCase() || null);

    await db.prepare(`
      UPDATE categories SET name = ?, division = ?, schedule = ?, order_index = COALESCE(?, order_index), ruleset = ?
      WHERE id = ?
    `).run(fullName, bare, (req.body.schedule || category.schedule || '').toUpperCase(),
      req.body.order_index === undefined || req.body.order_index === '' ? null : (orden === null ? 0 : orden),
      reglamento, catId);
    backToConfig(res, tournament.id, { success: `Categoría actualizada a ${bare}.` });
  } catch (err) {
    console.error('Error updating category:', err);
    backToConfig(res, tournament.id, { error: 'Error al actualizar la categoría.' });
  }
});

// Marcar una categoría como vigente o histórica. Las históricas se conservan
// (junto con sus inscripciones) pero dejan de ofrecerse al inscribir.
router.post('/torneos/:id/categorias/:catId/estado', async (req, res) => {
  const tournament = await loadTournamentForUser(req, toInt(req.params.id));
  if (!tournament) return res.redirect('/admin/torneos?error=' + encodeURIComponent('Torneo no encontrado.'));

  const catId = toInt(req.params.catId);
  const activate = req.body.is_active === '1';

  try {
    await db.prepare(`UPDATE categories SET is_active = ? WHERE id = ? AND tournament_id = ?`)
      .run(activate, catId, tournament.id);
    backToConfig(res, tournament.id, {
      success: activate ? 'Categoría marcada como vigente: vuelve a ofrecerse al inscribir.' : 'Categoría marcada como histórica: ya no se ofrece al inscribir.'
    });
  } catch (err) {
    console.error('Error toggling category:', err);
    backToConfig(res, tournament.id, { error: 'Error al cambiar el estado de la categoría.' });
  }
});

// Eliminar categoría (bloqueada si tiene inscripciones)
router.post('/torneos/:id/categorias/:catId/eliminar', async (req, res) => {
  const tournament = await loadTournamentForUser(req, toInt(req.params.id));
  if (!tournament) return res.redirect('/admin/torneos?error=' + encodeURIComponent('Torneo no encontrado.'));

  const catId = toInt(req.params.catId);
  const category = await db.prepare(`SELECT * FROM categories WHERE id = ? AND tournament_id = ?`).get(catId, tournament.id);
  if (!category) return backToConfig(res, tournament.id, { error: 'Categoría no encontrada.' });

  const used = await db.prepare(`SELECT COUNT(*) AS count FROM registrations WHERE category_id = ?`).get(catId);
  if (Number(used.count) > 0) {
    return backToConfig(res, tournament.id, {
      error: `No se puede eliminar "${formatCategoryName(category.name, category.discipline)}": tiene ${used.count} inscripción(es).`
    });
  }

  try {
    await db.prepare(`DELETE FROM categories WHERE id = ?`).run(catId);
    backToConfig(res, tournament.id, { success: 'Categoría eliminada.' });
  } catch (err) {
    console.error('Error deleting category:', err);
    backToConfig(res, tournament.id, { error: 'Error al eliminar la categoría.' });
  }
});

// --- Categorías de edad (franjas) -----------------------------------------

// Alta en lote: una franja por renglón, "NOMBRE DESDE-HASTA".
router.post('/torneos/:id/franjas/lote', async (req, res) => {
  const tournament = await loadTournamentForUser(req, toInt(req.params.id));
  if (!tournament) return res.redirect('/admin/torneos?error=' + encodeURIComponent('Torneo no encontrado.'));

  const discipline = String(req.body.discipline || '').trim().toUpperCase();
  const lineas = splitLines(req.body.bands);
  if (!discipline) return backToConfig(res, tournament.id, { error: 'Falta la disciplina.' });
  if (!lineas.length) return backToConfig(res, tournament.id, { error: 'Escribí al menos una categoría de edad (una por renglón).' });

  const parsed = [];
  const malas = [];
  for (const l of lineas) {
    const b = parseBandLine(l);
    if (b) parsed.push(b); else malas.push(l);
  }
  if (!parsed.length) {
    return backToConfig(res, tournament.id, {
      error: 'No se entendió ningún renglón. Se escribe así: BABY 4-5 (nombre, edad mínima y edad máxima).'
    });
  }

  try {
    let last = Number((await db.prepare(`
      SELECT COALESCE(MAX(order_index), -1) AS max FROM tournament_age_bands
      WHERE tournament_id = ? AND discipline = ?
    `).get(tournament.id, discipline)).max);

    for (const b of parsed) {
      last++;
      await db.prepare(`
        INSERT INTO tournament_age_bands (tournament_id, discipline, name, min_age, max_age, order_index)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (tournament_id, discipline, name)
        DO UPDATE SET min_age = EXCLUDED.min_age, max_age = EXCLUDED.max_age
      `).run(tournament.id, discipline, b.name, b.min, b.max, last);
    }

    const aviso = malas.length ? ` No se entendieron ${malas.length}: ${malas.join(' / ')}.` : '';
    backToConfig(res, tournament.id, {
      success: `${parsed.length} categoría(s) de edad guardada(s) en ${discipline}.${aviso}`
    });
  } catch (err) {
    console.error('Error adding age bands in bulk:', err);
    backToConfig(res, tournament.id, { error: 'Error al guardar las categorías de edad.' });
  }
});

router.post('/torneos/:id/franjas', async (req, res) => {
  const tournament = await loadTournamentForUser(req, toInt(req.params.id));
  if (!tournament) return res.redirect('/admin/torneos?error=' + encodeURIComponent('Torneo no encontrado.'));

  const discipline = String(req.body.discipline || '').trim().toUpperCase();
  const name = String(req.body.name || '').trim().toUpperCase();
  const minAge = parseInt(req.body.min_age, 10);
  const maxAge = parseInt(req.body.max_age, 10);

  if (!discipline || !name) {
    return backToConfig(res, tournament.id, { error: 'Disciplina y nombre de la categoría de edad son requeridos.' });
  }
  if (!Number.isFinite(minAge) || !Number.isFinite(maxAge) || minAge < 0 || maxAge < minAge) {
    return backToConfig(res, tournament.id, { error: 'El rango de edades no es válido (la edad máxima debe ser mayor o igual a la mínima).' });
  }

  const last = await db.prepare(`
    SELECT COALESCE(MAX(order_index), -1) AS max FROM tournament_age_bands
    WHERE tournament_id = ? AND discipline = ?
  `).get(tournament.id, discipline);

  try {
    await db.prepare(`
      INSERT INTO tournament_age_bands (tournament_id, discipline, name, min_age, max_age, order_index)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (tournament_id, discipline, name)
      DO UPDATE SET min_age = EXCLUDED.min_age, max_age = EXCLUDED.max_age
    `).run(tournament.id, discipline, name, minAge, maxAge, Number(last.max) + 1);
    backToConfig(res, tournament.id, { success: `Categoría de edad ${name} (${minAge}-${maxAge}) guardada en ${discipline}.` });
  } catch (err) {
    console.error('Error adding age band:', err);
    backToConfig(res, tournament.id, { error: 'Error al guardar la categoría de edad.' });
  }
});

router.post('/torneos/:id/franjas/:bandId/editar', async (req, res) => {
  const tournament = await loadTournamentForUser(req, toInt(req.params.id));
  if (!tournament) return res.redirect('/admin/torneos?error=' + encodeURIComponent('Torneo no encontrado.'));

  const bandId = toInt(req.params.bandId);
  const name = String(req.body.name || '').trim().toUpperCase();
  const minAge = parseInt(req.body.min_age, 10);
  const maxAge = parseInt(req.body.max_age, 10);

  if (!name || !Number.isFinite(minAge) || !Number.isFinite(maxAge) || maxAge < minAge) {
    return backToConfig(res, tournament.id, { error: 'Datos inválidos para la categoría de edad.' });
  }

  try {
    await db.prepare(`
      UPDATE tournament_age_bands SET name = ?, min_age = ?, max_age = ?
      WHERE id = ? AND tournament_id = ?
    `).run(name, minAge, maxAge, bandId, tournament.id);
    backToConfig(res, tournament.id, { success: `Categoría de edad ${name} actualizada.` });
  } catch (err) {
    console.error('Error updating age band:', err);
    backToConfig(res, tournament.id, { error: 'Error al actualizar la categoría de edad.' });
  }
});

router.post('/torneos/:id/franjas/:bandId/eliminar', async (req, res) => {
  const tournament = await loadTournamentForUser(req, toInt(req.params.id));
  if (!tournament) return res.redirect('/admin/torneos?error=' + encodeURIComponent('Torneo no encontrado.'));

  try {
    await db.prepare(`DELETE FROM tournament_age_bands WHERE id = ? AND tournament_id = ?`)
      .run(toInt(req.params.bandId), tournament.id);
    backToConfig(res, tournament.id, { success: 'Categoría de edad eliminada.' });
  } catch (err) {
    console.error('Error deleting age band:', err);
    backToConfig(res, tournament.id, { error: 'Error al eliminar la categoría de edad.' });
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
  const { username, password, full_name, role, club_id, email, phone, admin_scope } = req.body;

  if (!username || !password || !full_name || !role) {
    return res.redirect('/admin/usuarios?error=' + encodeURIComponent('Complete todos los campos obligatorios del usuario.'));
  }

  if (!ROLES.includes(role)) {
    return res.redirect('/admin/usuarios?error=' + encodeURIComponent('Rol inválido.'));
  }

  try {
    const password_hash = bcrypt.hashSync(password, 10);
    const scope = String(admin_scope || '').trim().toUpperCase() || null;
    const info = await db.prepare(`
      INSERT INTO users (username, password_hash, full_name, role, club_id, email, phone, admin_scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
    `).run(username.trim().toLowerCase(), password_hash, full_name.trim().toUpperCase(), role, club_id || null, (email || '').toUpperCase(), phone || '', scope);

    if (club_id) {
      await db.prepare(`INSERT INTO user_clubs (user_id, club_id) VALUES (?, ?) ON CONFLICT DO NOTHING`).run(info.lastInsertRowid, club_id);
    }

    res.redirect('/admin/usuarios?success=' + encodeURIComponent(`Usuario ${username} creado correctamente.`));
  } catch (err) {
    console.error('Error creating user:', err);
    let msg = 'Error al crear usuario.';
    if (errDb.esDuplicado(err)) {
      msg = errDb.campoDuplicado(err) === 'email'
        ? 'Ese email ya está registrado en otro usuario.'
        : 'El nombre de usuario ya existe.';
    }
    res.redirect('/admin/usuarios?error=' + encodeURIComponent(msg));
  }
});

// Cambiar el rol y el alcance de administración de un usuario.
// 'profesor_admin' ve primero su módulo de profesora y además el panel admin;
// el alcance (ej: CABA) limita qué torneos puede ver y editar.
router.post('/usuarios/:id/rol', async (req, res) => {
  const userId = toInt(req.params.id);
  const { role, admin_scope } = req.body;

  if (!ROLES.includes(role)) {
    return res.redirect('/admin/usuarios?error=' + encodeURIComponent('Rol inválido.'));
  }

  const target = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
  if (!target) {
    return res.redirect('/admin/usuarios?error=' + encodeURIComponent('Usuario no encontrado.'));
  }

  // Nadie puede quitarse a sí mismo el acceso de administrador y quedar afuera.
  if (req.session.user.id === userId && !['admin', 'profesor_admin'].includes(role)) {
    return res.redirect('/admin/usuarios?error=' + encodeURIComponent('No podés quitarte tu propio acceso de administrador.'));
  }

  const scope = String(admin_scope || '').trim().toUpperCase() || null;

  try {
    await db.prepare(`UPDATE users SET role = ?, admin_scope = ? WHERE id = ?`).run(role, scope, userId);

    // Si se cambió a sí mismo, la sesión activa se actualiza al instante.
    if (req.session.user.id === userId) {
      req.session.user.role = role;
      req.session.user.admin_scope = scope;
    }

    res.redirect('/admin/usuarios?success=' + encodeURIComponent(
      `${target.full_name}: rol ${role}${scope ? ` con alcance ${scope}` : ' (todos los torneos)'}.`
    ));
  } catch (err) {
    console.error('Error updating user role:', err);
    res.redirect('/admin/usuarios?error=' + encodeURIComponent('Error al actualizar el rol del usuario.'));
  }
});

// Master Skaters Directory for Admin (Padrón Único de Patinadoras)
router.get('/alumnos', async (req, res) => {
  const { buscar } = req.query;
  const club_id = toInt(req.query.club_id);

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
    if (errDb.esDuplicado(err)) {
      msg = errDb.campoDuplicado(err) === 'cuil'
        ? 'Ese CUIL ya está cargado en otra patinadora. Revisá el número.'
        : await errDb.mensajeDniRepetido(req.body.dni);
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
  const { sendMail, logFallback, buildUrl } = require('../lib/mailer');

  await db.prepare(`DELETE FROM password_resets WHERE user_id = ?`).run(user.id);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  await db.prepare(`
    INSERT INTO password_resets (user_id, token, expires_at)
    VALUES (?, ?, ?)
  `).run(user.id, token, expiresAt);

  const resetPath = `/auth/restablecer-password?token=${token}`;
  const fullUrl = buildUrl(req, resetPath);

  const sent = await sendMail({
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

  if (!sent) {
    logFallback('✉️ EMAIL AUTOMÁTICO SIMULADO PARA', user.email, fullUrl);
    return res.redirect('/admin/usuarios?success=' + encodeURIComponent(`✉️ Correo de recuperación procesado automáticamente para ${user.email} (Link activo: ${fullUrl}).`));
  }

  res.redirect('/admin/usuarios?success=' + encodeURIComponent(`✅ Correo enviado automáticamente a ${user.email} con las instrucciones.`));
});

// Delete User (Admins, Teachers, Judges)
router.post('/usuarios/:id/eliminar', async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (!userId) {
    return res.redirect('/admin/usuarios?error=' + encodeURIComponent('Identificador de usuario inválido.'));
  }

  if (userId === req.session.user.id) {
    return res.redirect('/admin/usuarios?error=' + encodeURIComponent('No podés eliminar tu propia cuenta de administrador.'));
  }

  const user = await db.prepare(`SELECT * FROM users WHERE id = ?`).get(userId);
  if (!user) {
    return res.redirect('/admin/usuarios?error=' + encodeURIComponent('Usuario no encontrado.'));
  }

  if (user.role === 'admin') {
    const adminCount = await db.prepare(`SELECT COUNT(*) as count FROM users WHERE role = 'admin'`).get();
    if (adminCount.count <= 1) {
      return res.redirect('/admin/usuarios?error=' + encodeURIComponent('No se puede eliminar: es el único administrador del sistema.'));
    }
  }

  try {
    await db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
    res.redirect('/admin/usuarios?success=' + encodeURIComponent(`✅ Usuario ${user.full_name} (@${user.username}) eliminado correctamente.`));
  } catch (err) {
    console.error('Error deleting user:', err);
    res.redirect('/admin/usuarios?error=' + encodeURIComponent('Error al eliminar el usuario.'));
  }
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

  const hero_title = (await getSetting('hero_title')) || 'Liga Star Dance · Patín Artístico';
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
  await setSetting.run('hero_title', hero_title || '');
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
