// Idempotente: alinea el catálogo de categorías de TODOS los torneos con el
// catálogo oficial (data/catalogo_categorias.json, generado desde el Excel
// categorias_y_disciplinas.xlsx). Las categorías que ya tengan inscripciones
// se conservan aunque no estén en el catálogo (para no romper referencias).
const db = require('../database');
const catalog = require('../data/catalogo_categorias.json');

async function ensureCategoriesCatalog() {
  const tournaments = await db.prepare(`SELECT id, name FROM tournaments ORDER BY id ASC`).all();
  const report = { tournaments: tournaments.length, aligned: [], kept: [] };

  for (const t of tournaments) {
    const existing = await db.prepare(`SELECT id, name, discipline, fee FROM categories WHERE tournament_id = ?`).all(t.id);
    const referenced = await db.prepare(`
      SELECT DISTINCT category_id FROM registrations WHERE tournament_id = ?
    `).all(t.id);
    const referencedIds = new Set(referenced.map(r => String(r.category_id)));

    let added = 0, removed = 0;

    for (const cat of existing) {
      const inCatalog = catalog.some(g =>
        g.discipline === cat.discipline &&
        g.categories.some(cn => cat.name === `${g.discipline} - ${cn}` || cat.name === cn)
      );
      if (!inCatalog && !referencedIds.has(String(cat.id))) {
        await db.prepare(`DELETE FROM categories WHERE id = ?`).run(cat.id);
        removed++;
      }
    }

    for (const group of catalog) {
      for (const catName of group.categories) {
        const displayName = `${group.discipline} - ${catName}`;
        const dup = await db.prepare(`
          SELECT id FROM categories WHERE tournament_id = ? AND discipline = ? AND name = ?
        `).get(t.id, group.discipline, displayName);
        if (!dup) {
          await db.prepare(`
            INSERT INTO categories (tournament_id, name, discipline, division, min_age, max_age, gender, schedule, fee)
            VALUES (?, ?, ?, ?, 0, 99, 'MIXTO', 'A CONFIRMAR', ?)
          `).run(t.id, displayName, group.discipline, catName, group.fee);
          added++;
        }
      }
    }

    report.aligned.push({ id: t.id, name: t.name, added, removed });
  }

  return report;
}

module.exports = ensureCategoriesCatalog;
