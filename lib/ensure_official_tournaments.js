const db = require('../database');

// Torneos oficiales de la Liga (multifecha) que deben existir siempre.
const TORNEOS_OFICIALES = [
  {
    name: 'ZONA SUR',
    description: 'FECHA CLASIFICATORIA ZONA SUR. DISCIPLINAS: LIBRE, FREE DANCE, SOLO DANCE, PAREJAS, DÚOS, TRÍOS, CUARTETOS, SMALL, SHOW Y PRECISIÓN.',
    venue: 'POLIDEPORTIVO ZONA SUR',
    date_from: '2026-08-29',
    date_to: '2026-08-30',
    deadline: '2026-08-20',
    status: 'upcoming'
  },
  {
    name: 'ZONA CABA',
    description: 'FECHA CLASIFICATORIA ZONA CABA. DISCIPLINAS: LIBRE, FREE DANCE, SOLO DANCE, PAREJAS, DÚOS, TRÍOS, CUARTETOS, SMALL, SHOW Y PRECISIÓN.',
    venue: 'POLIDEPORTIVO CABA',
    date_from: '2026-09-06',
    date_to: '2026-10-04',
    deadline: '2026-08-28',
    status: 'upcoming'
  },
  {
    name: 'MEGA COPA',
    description: 'MEGA COPA LIGA STAR DANCE. DISCIPLINAS: LIBRE, FREE DANCE, SOLO DANCE, PAREJAS, DÚOS, TRÍOS, CUARTETOS, SMALL, SHOW Y PRECISIÓN.',
    venue: 'ESTADIO CUBIERTO MEGA COPA',
    date_from: '2026-12-05',
    date_to: '2026-12-07',
    deadline: '2026-11-25',
    status: 'upcoming'
  }
];

// Nombres de torneos demo que deben eliminarse (los que se cargaron de prueba).
const TORNEOS_DEMO = [
  'GRAN TORNEO APERTURA STAR DANCE 2026',
  'TORNEO PRUEBA'
];

// Corre después del seed: elimina los torneos demo (y su cascada de categorías/
// registraciones) y garantiza que existan los torneos oficiales multifecha.
async function ensureOfficialTournaments() {
  const report = { deleted: 0, created: 0 };

  await db.exec(`DELETE FROM tournaments WHERE name IN ('${TORNEOS_DEMO.map(n => n.replace(/'/g, "''")).join("', '")}')`);

  for (const t of TORNEOS_OFICIALES) {
    const info = await db.prepare(`
      INSERT INTO tournaments (name, description, venue, event_date, date_from, date_to, registration_deadline, status)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM tournaments WHERE name = ?)
      RETURNING id
    `).run(t.name, t.description, t.venue, t.date_from, t.date_from, t.date_to, t.deadline, t.status, t.name);
    if (info.lastInsertRowid) report.created++;
  }

  return report;
}

module.exports = { ensureOfficialTournaments, TORNEOS_OFICIALES, TORNEOS_DEMO };
