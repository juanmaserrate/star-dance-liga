// Idempotente: garantiza que ningún torneo quede sin categorías.
//
// Antes copiaba las categorías del torneo con id = 1; cuando ese torneo dejó de
// existir, un torneo nuevo quedaba vacío y las profesoras no podían inscribir.
// Ahora se siembra desde el catálogo oficial, que siempre está disponible.
const db = require('../database');
const { seedCategories } = require('./tournament_config');

async function ensureAllTournamentsHaveCategories() {
  const tournaments = await db.prepare(`SELECT id, name FROM tournaments ORDER BY id ASC`).all();
  const report = { tournaments: tournaments.length, checked: [], copied: [] };

  for (const t of tournaments) {
    const { count } = await db.prepare(`SELECT COUNT(*) as count FROM categories WHERE tournament_id = ?`).get(t.id);

    if (Number(count) === 0) {
      const info = await seedCategories(t.id);
      report.copied.push({ id: t.id, name: t.name, categories: info.added });
    } else {
      report.checked.push({ id: t.id, name: t.name, categories: Number(count) });
    }
  }

  return report;
}

module.exports = ensureAllTournamentsHaveCategories;
