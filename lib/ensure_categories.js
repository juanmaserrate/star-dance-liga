// Idempotente: garantiza que TODOS los torneos tengan habilitado el catálogo
// completo de categorías y disciplinas.
const db = require('../database');

async function ensureAllTournamentsHaveCategories() {
  const tournaments = await db.prepare(`SELECT id, name FROM tournaments ORDER BY id ASC`).all();
  const report = { tournaments: tournaments.length, checked: [], copied: [] };

  for (const t of tournaments) {
    const { count } = await db.prepare(`SELECT COUNT(*) as count FROM categories WHERE tournament_id = ?`).get(t.id);

    if (Number(count) === 0) {
      const info = await db.prepare(`
        INSERT INTO categories (tournament_id, name, discipline, division, level, min_age, max_age, gender, schedule)
        SELECT ?, name, discipline, division, level, min_age, max_age, gender, schedule
        FROM categories WHERE tournament_id = 1
      `).run(t.id);
      report.copied.push({ id: t.id, name: t.name, categories: info.changes });
    } else {
      report.checked.push({ id: t.id, name: t.name, categories: Number(count) });
    }
  }

  return report;
}

module.exports = ensureAllTournamentsHaveCategories;
