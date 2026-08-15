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

module.exports = {
  getCalendarAge,
  getRegistration,
  findSuitableCategory,
  resolveAgeBand,
  findConflicts
};
