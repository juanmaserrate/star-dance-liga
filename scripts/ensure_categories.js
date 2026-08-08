// One-off: garantiza que TODOS los torneos tengan habilitado el catálogo completo
// de categorías y disciplinas.
// Ejecutar dentro del contenedor donde la base de datos sea alcanzable,
// o el propio server.js lo ejecuta en cada arranque (idempotente).
const db = require('../database');
const ensureAllTournamentsHaveCategories = require('../lib/ensure_categories');

(async () => {
  await db.initPromise;
  const report = await ensureAllTournamentsHaveCategories();

  console.log(`Torneos revisados: ${report.tournaments}`);
  for (const t of report.checked) {
    console.log(`  - Torneo #${t.id} "${t.name}": ya tiene ${t.categories} categorías.`);
  }
  for (const t of report.copied) {
    console.log(`  ✔ Torneo #${t.id} "${t.name}": se copiaron ${t.categories} categorías.`);
  }

  console.log('✅ Listo: todos los torneos tienen categorías y disciplinas habilitadas.');
  process.exit(0);
})().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
