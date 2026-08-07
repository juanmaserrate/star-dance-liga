// One-off: alinea el catálogo de categorías de TODOS los torneos con
// data/catalogo_categorias.json (agrega las nuevas y elimina las que no estén
// en el catálogo, conservando las que ya tengan inscripciones).
// Ejecutar con `railway run node scripts/apply_catalog.js`.
const db = require('../database');
const ensureCategoriesCatalog = require('../lib/ensure_categories_catalog');

(async () => {
  await db.initPromise;
  const report = await ensureCategoriesCatalog();

  console.log(`Torneos alineados: ${report.tournaments}`);
  for (const t of report.aligned) {
    console.log(`  - #${t.id} "${t.name}": +${t.added} / -${t.removed}`);
  }

  console.log('✅ Catálogo aplicado. Las categorías con inscripciones se conservaron.');
  process.exit(0);
})().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
