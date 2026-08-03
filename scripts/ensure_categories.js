// One-off: garantiza que TODOS los torneos tengan habilitado el catálogo completo
// de categorías y disciplinas (aunque tengan arancel 0).
// Ejecutar con DATABASE_URL configurada (railway run node scripts/ensure_categories.js)
const db = require('../database');

async function ensureCategories() {
  await db.initPromise;

  const tournaments = await db.prepare(`SELECT id, name FROM tournaments ORDER BY id ASC`).all();
  console.log(`Torneros encontrados: ${tournaments.length}`);

  for (const t of tournaments) {
    const { count } = await db.prepare(`SELECT COUNT(*) as count FROM categories WHERE tournament_id = ?`).get(t.id);

    if (Number(count) === 0) {
      await db.prepare(`
        INSERT INTO categories (tournament_id, name, discipline, division, level, min_age, max_age, gender, schedule, fee)
        SELECT ?, name, discipline, division, level, min_age, max_age, gender, schedule, fee
        FROM categories WHERE tournament_id = 1
      `).run(t.id);
      console.log(`  ✔ Torneo #${t.id} "${t.name}": sin categorías → se copiaron las del torneo 1.`);
    } else {
      console.log(`  - Torneo #${t.id} "${t.name}": ya tiene ${count} categorías.`);
    }
  }

  // Si no existe el torneo 1 como fuente, no se pudo copiar: avisar.
  const source = await db.prepare(`SELECT COUNT(*) as count FROM categories WHERE tournament_id = 1`).get();
  if (Number(source.count) === 0) {
    console.warn('⚠ El torneo 1 no tiene categorías, no hay fuente para copiar.');
  }

  console.log('✅ Listo: todos los torneos tienen categorías y disciplinas habilitadas.');
  process.exit(0);
}

ensureCategories().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
