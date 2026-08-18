// Módulo compartido de edición / movimiento de inscripciones (admin y profesor).
// Centraliza: carga de la inscripción con joins e integrantes, sugerencia de
// categoría para un torneo destino, detección de duplicados al mover y resolución
// de la franja de edad (age_band) según la categoría elegida.
const db = require('../database');
const { formatCategoryName } = require('./categories');

// Edad calendario: año actual menos año de nacimiento (coincide con la app).
function getCalendarAge(birthDateStr) {
  if (!birthDateStr) return 0;
  const birthYear = new Date(birthDateStr).getFullYear();
  const currentYear = new Date().getFullYear();
  return Math.max(0, currentYear - birthYear);
}

// Normaliza texto para comparar tolerante a mayúsculas y tildes.
function normalize(s) {
  return String(s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

// Carga una inscripción con sus joins y todos sus integrantes.
async function getRegistration(id) {
  const reg = await db.prepare(`
    SELECT r.*,
      s.first_name, s.last_name, s.dni, s.birth_date,
      t.name AS tournament_name, t.status AS tournament_status,
      c.name AS category_name, c.discipline, c.level, c.min_age, c.max_age,
      cl.name AS club_name,
      u.full_name AS teacher_name
    FROM registrations r
    LEFT JOIN students s ON r.student_id = s.id
    JOIN tournaments t ON r.tournament_id = t.id
    JOIN categories c ON r.category_id = c.id
    JOIN clubs cl ON r.club_id = cl.id
    JOIN users u ON r.teacher_id = u.id
    WHERE r.id = ?
  `).get(id);
  if (!reg) return null;

  // Edad: la guardada en la inscripción manda; si es una inscripción vieja que
  // no la tiene, se calcula de la fecha de nacimiento.
  reg.computed_age = getCalendarAge(reg.birth_date);
  reg.age = reg.age || reg.computed_age;
  reg.members = await db.prepare(`
    SELECT s.id, s.first_name, s.last_name, s.dni, s.birth_date
    FROM registration_members rm
    JOIN students s ON s.id = rm.student_id
    WHERE rm.registration_id = ?
    ORDER BY rm.id ASC
  `).all(id);

  // IDs de todas las patinadoras de la inscripción (grupo o individual).
  reg.studentIds = reg.members.length
    ? reg.members.map(m => m.id)
    : (reg.student_id ? [reg.student_id] : []);

  return reg;
}

// Sugiere la categoría más adecuada del torneo destino para esta inscripción.
// Prioridades: mismo nombre exacto → banda de edad (age_band) → rango por edad → primera de la disciplina.
function findSuitableCategory(categories, opts = {}) {
  if (!Array.isArray(categories) || categories.length === 0) return null;
  const { currentName, discipline, ageBand, age } = opts;

  const normDisc = normalize(discipline);
  const sameDiscipline = categories.filter(c => normalize(c.discipline) === normDisc);
  const pool = sameDiscipline.length ? sameDiscipline : categories;

  if (currentName) {
    const exact = pool.find(c => normalize(c.name) === normalize(currentName));
    if (exact) return exact;
  }

  if (ageBand) {
    const byBand = pool.find(c => normalize(formatCategoryName(c.name, c.discipline)) === normalize(ageBand));
    if (byBand) return byBand;
  }

  if (typeof age === 'number' && age > 0) {
    const byAge = pool.find(c =>
      (c.min_age == null || age >= c.min_age) && (c.max_age == null || age <= c.max_age)
    );
    if (byAge) return byAge;
  }

  return sameDiscipline[0] || null;
}

// Resuelve la franja de edad (age_band) para una categoría del catálogo.
// Solo las disciplinas con franjas (FREE DANCE/STYLE) devuelven banda; el resto, null.
function resolveAgeBand(discipline, categoryName) {
  const catalogo = require('../data/catalogo_categorias.json');
  const normDisc = normalize(discipline);
  const bare = normalize(formatCategoryName(categoryName, discipline));
  for (const g of catalogo) {
    if (normalize(g.discipline) !== normDisc) continue;
    if (!Array.isArray(g.ages)) continue;
    const band = g.ages.find(a => normalize(a.name) === bare);
    if (band) return band.name.toUpperCase();
  }
  return null;
}

// Busca si alguna de las patinadoras YA está anotada en la MISMA categoría del
// MISMO torneo. Es lo único que se considera duplicado: la misma alumna puede
// competir en varias categorías del torneo, y por supuesto en otros torneos.
// excludeRegId permite editar una inscripción sin que choque consigo misma.
async function findDuplicateInCategory(tournamentId, categoryId, studentIds, excludeRegId = null) {
  const tId = parseInt(tournamentId, 10);
  const cId = parseInt(categoryId, 10);
  const ids = (studentIds || []).map(x => parseInt(x, 10)).filter(Number.isFinite);
  if (!tId || !cId || !ids.length) return [];

  // COALESCE(?, 0): ninguna inscripción tiene id 0, así que sin exclusión la
  // condición no filtra nada. Evita pasar un parámetro sin tipo definido.
  const excluir = parseInt(excludeRegId, 10);
  const excluirId = Number.isFinite(excluir) ? excluir : null;

  const choques = [];
  for (const studentId of ids) {
    const row = await db.prepare(`
      SELECT r.id, s.first_name, s.last_name, c.name AS category_name, c.discipline
      FROM registrations r
      JOIN categories c ON c.id = r.category_id
      LEFT JOIN students s ON s.id = ?
      WHERE r.tournament_id = ? AND r.category_id = ?
        AND COALESCE(r.status, '') <> 'cancelled'
        AND r.id <> COALESCE(?, 0)
        AND (r.student_id = ? OR EXISTS (
          SELECT 1 FROM registration_members rm
          WHERE rm.registration_id = r.id AND rm.student_id = ?
        ))
      LIMIT 1
    `).get(studentId, tId, cId, excluirId, studentId, studentId);

    if (row) {
      const nombre = `${row.last_name || ''} ${row.first_name || ''}`.trim() || 'La patinadora';
      choques.push({
        registrationId: row.id,
        studentId,
        nombre,
        categoria: formatCategoryName(row.category_name, row.discipline),
        discipline: row.discipline
      });
    }
  }
  return choques;
}

// Mensaje único para avisar del duplicado, igual en el alta y en la edición.
function duplicateMessage(choques) {
  if (!choques || !choques.length) return null;
  const detalle = choques
    .map(c => `${c.nombre} ya está inscripta en ${c.discipline} - ${c.categoria}`)
    .join('. ');
  return `${detalle}. En un mismo torneo no se puede repetir la categoría. Si querés anotarla en otra categoría, elegí esa; si fue un error, revisá las inscripciones realizadas.`;
}

// Detecta si alguna patinadora de la inscripción ya figura (individual o como
// miembro de un grupo) en el torneo destino, en otra inscripción no cancelada.
async function findConflicts(reg, destTournamentId) {
  const destId = parseInt(destTournamentId, 10);
  if (!destId) return [];
  const conflicts = [];
  for (const studentId of reg.studentIds || []) {
    const rows = await db.prepare(`
      SELECT r.id, r.group_name, r.student_id,
        s.first_name AS sf_name, s.last_name AS sl_name
      FROM registrations r
      LEFT JOIN students s ON r.student_id = s.id
      WHERE r.tournament_id = ? AND r.id != ? AND r.status != 'cancelled'
        AND (r.student_id = ? OR EXISTS (
          SELECT 1 FROM registration_members rm
          WHERE rm.registration_id = r.id AND rm.student_id = ?
        ))
    `).all(destId, reg.id, studentId, studentId);
    if (rows.length) conflicts.push({ studentId, rows });
  }
  return conflicts;
}


// Borra una inscripción, guardando antes una copia completa en
// registrations_eliminadas. Devuelve { ok, error, reg }.
//
// Se bloquea si la inscripción ya tiene puntajes cargados: eso significa que
// la patinadora ya compitió y borrarla se llevaría los resultados por delante.
// En ese caso corresponde cancelarla, no borrarla.
async function eliminarRegistration(regId, user) {
  const id = parseInt(regId, 10);
  if (!Number.isFinite(id)) return { ok: false, error: 'Inscripción inválida.' };

  const reg = await db.prepare(`
    SELECT r.*,
      t.name AS tournament_name,
      c.name AS category_name, c.discipline,
      cl.name AS club_name,
      u.full_name AS teacher_name,
      s.first_name, s.last_name
    FROM registrations r
    JOIN tournaments t ON t.id = r.tournament_id
    JOIN categories c ON c.id = r.category_id
    LEFT JOIN clubs cl ON cl.id = r.club_id
    LEFT JOIN users u ON u.id = r.teacher_id
    LEFT JOIN students s ON s.id = r.student_id
    WHERE r.id = ?
  `).get(id);

  if (!reg) return { ok: false, error: 'La inscripción no existe o ya fue eliminada.' };

  const puntajes = await db.prepare(
    `SELECT COUNT(*) AS count FROM scores WHERE registration_id = ?`
  ).get(id);
  if (Number(puntajes.count) > 0) {
    return {
      ok: false, reg,
      error: `No se puede eliminar: la inscripción ya tiene ${puntajes.count} puntaje(s) cargado(s). Si no va a competir, marcala como cancelada.`
    };
  }

  const miembros = await db.prepare(
    `SELECT student_id FROM registration_members WHERE registration_id = ? ORDER BY id ASC`
  ).all(id);

  const quien = reg.is_group
    ? (reg.group_name || 'GRUPO')
    : `${reg.last_name || ''} ${reg.first_name || ''}`.trim();

  await db.prepare(`
    INSERT INTO registrations_eliminadas (
      registration_id, tournament_id, tournament_name, category_id, category_name, discipline,
      student_id, student_name, club_id, club_name, teacher_id, teacher_name,
      is_group, group_name, group_type, status, notes, age, age_band, member_ids,
      created_at, deleted_by, deleted_by_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    reg.id, reg.tournament_id, reg.tournament_name, reg.category_id, reg.category_name, reg.discipline,
    reg.student_id, quien, reg.club_id, reg.club_name, reg.teacher_id, reg.teacher_name,
    reg.is_group, reg.group_name, reg.group_type, reg.status, reg.notes, reg.age, reg.age_band,
    miembros.map(m => m.student_id).join(','),
    reg.created_at,
    user ? user.id : null,
    user ? (user.full_name || user.username || null) : null
  );

  // registration_members y scores se van solos por la clave foránea en cascada.
  await db.prepare(`DELETE FROM registrations WHERE id = ?`).run(id);

  return { ok: true, reg, quien };
}

module.exports = {
  getCalendarAge,
  getRegistration,
  findSuitableCategory,
  resolveAgeBand,
  findConflicts,
  findDuplicateInCategory,
  duplicateMessage,
  eliminarRegistration
};
