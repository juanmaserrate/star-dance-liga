const db = require('../database');

// Torneos oficiales de la Liga. Se identifican por `official_key`, NO por
// nombre: así el administrador puede renombrarlos desde el panel sin que el
// arranque los vuelva a crear duplicados.
const TORNEOS_OFICIALES = [
  {
    key: 'ZONA_SUR',
    name: 'ZONA SUR',
    description: 'FECHA CLASIFICATORIA ZONA SUR. DISCIPLINAS: LIBRE, FREE DANCE, SOLO DANCE, PAREJAS, DÚOS, TRÍOS, CUARTETOS, SMALL, SHOW Y PRECISIÓN.',
    venue: 'INSTITUTO ESTRADA',
    date_from: '2026-08-29',
    date_to: '2026-08-30',
    deadline: '2026-08-20',
    status: 'upcoming'
  },
  {
    key: 'ZONA_CABA',
    name: 'ZONA CABA',
    description: 'FECHA CLASIFICATORIA ZONA CABA. DISCIPLINAS: LIBRE, FREE DANCE, SOLO DANCE, PAREJAS, DÚOS, TRÍOS, CUARTETOS, SMALL, SHOW Y PRECISIÓN.',
    venue: 'ARGENTINOS JUNIORS',
    date_from: '2026-09-06',
    date_to: '2026-09-06',
    deadline: '2026-08-28',
    status: 'upcoming'
  },
  {
    key: 'MEGA_COPA',
    name: 'MEGA COPA',
    description: 'MEGA COPA LIGA STAR DANCE. DISCIPLINAS: LIBRE, FREE DANCE, SOLO DANCE, PAREJAS, DÚOS, TRÍOS, CUARTETOS, SMALL, SHOW Y PRECISIÓN.',
    venue: 'CLUB LAS TONINAS',
    date_from: '2026-12-05',
    date_to: '2026-12-07',
    deadline: '2026-11-25',
    status: 'upcoming'
  }
];

// Nombres de torneos demo / duplicados que deben eliminarse. Solo se borran si
// NO tienen inscripciones (nunca se pierde una inscripción real).
const TORNEOS_DEMO = [
  'GRAN TORNEO APERTURA STAR DANCE 2026',
  'TORNEO PRUEBA',
  '3 ERA FECHA ZONA SUR'
];

// Datos que se aplican una sola vez sobre los torneos ya existentes (sede y
// fechas confirmadas por la Liga). Después de esto manda lo que edite el admin.
const DATOS_CONFIRMADOS_KEY = 'tournament_data_revision';
const DATOS_CONFIRMADOS_REVISION = '2026-08-15-sedes';

async function deleteDemoTournaments(report) {
  for (const name of TORNEOS_DEMO) {
    const rows = await db.prepare(`
      SELECT t.id, (SELECT COUNT(*) FROM registrations r WHERE r.tournament_id = t.id) AS regs
      FROM tournaments t WHERE t.name = ?
    `).all(name);

    for (const row of rows) {
      if (Number(row.regs) > 0) {
        report.skipped.push({ name, id: row.id, regs: Number(row.regs) });
        continue;
      }
      await db.prepare(`DELETE FROM tournaments WHERE id = ?`).run(row.id);
      report.deleted++;
    }
  }
}

// Vincula por nombre los torneos oficiales que todavía no tienen official_key.
async function backfillKeys() {
  for (const t of TORNEOS_OFICIALES) {
    await db.prepare(`
      UPDATE tournaments SET official_key = ?
      WHERE official_key IS NULL AND name = ?
    `).run(t.key, t.name);
  }
}

// Aplica sede y fechas confirmadas. Solo corre cuando cambia la revisión.
async function applyConfirmedData(report) {
  const { getSetting, setSetting } = require('./tournament_config');
  const stored = await getSetting(DATOS_CONFIRMADOS_KEY);
  if (stored === DATOS_CONFIRMADOS_REVISION) return;

  for (const t of TORNEOS_OFICIALES) {
    const res = await db.prepare(`
      UPDATE tournaments
      SET venue = ?, date_from = ?, date_to = ?, event_date = ?
      WHERE official_key = ?
    `).run(t.venue, t.date_from, t.date_to, t.date_from, t.key);
    if (res.changes) report.updated += res.changes;
  }

  await setSetting(DATOS_CONFIRMADOS_KEY, DATOS_CONFIRMADOS_REVISION);
}

// Corre después del seed: elimina los torneos demo sin inscripciones y garantiza
// que existan los torneos oficiales.
async function ensureOfficialTournaments() {
  const report = { deleted: 0, created: 0, updated: 0, skipped: [] };

  await backfillKeys();
  await deleteDemoTournaments(report);

  for (const t of TORNEOS_OFICIALES) {
    const info = await db.prepare(`
      INSERT INTO tournaments (name, description, venue, event_date, date_from, date_to, registration_deadline, status, official_key)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM tournaments WHERE official_key = ?)
      RETURNING id
    `).run(t.name, t.description, t.venue, t.date_from, t.date_from, t.date_to, t.deadline, t.status, t.key, t.key);
    if (info.lastInsertRowid) report.created++;
  }

  await applyConfirmedData(report);

  return report;
}

module.exports = { ensureOfficialTournaments, TORNEOS_OFICIALES, TORNEOS_DEMO };
