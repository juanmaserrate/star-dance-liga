// Idempotente: alinea el catálogo de categorías de TODOS los torneos con el
// catálogo oficial (data/catalogo_categorias.json, generado desde el Excel
// categorias_y_disciplinas.xlsx). Las categorías que ya tengan inscripciones
// se conservan aunque no estén en el catálogo (para no romper referencias).
const db = require('../database');
const catalog = require('../data/catalogo_categorias.json');

// Categorías extra que SOLO existen en torneos puntuales (no forman parte del
// catálogo global). Se detectan por coincidencia en el nombre del torneo y se
// conservan aunque no estén en el catálogo.
const EXTRA_CATEGORIES_BY_TOURNAMENT = [
  {
    match: name => /CABA/i.test(name),
    disciplines: [
      {
        discipline: 'FREE DANCE',
        categories: [
          'NACIONAL',
          'CLÁSICO',
          'BÁSICO',
          'BÁSICO CADETE',
          'AVANZADO CAP JUNIO',
          'AVANZADO CAP CADETE',
          'NACIONAL FREE CAP NOVICIO',
          'AVANZADO CAP MINI INFANTIL',
          'AVANZADO CAP INFANTIL'
        ]
      }
    ]
  }
];

function getExtras(tournament) {
  const group = EXTRA_CATEGORIES_BY_TOURNAMENT.find(g => g.match(tournament.name));
  return group ? group.disciplines : [];
}

function isExtraCategory(extras, discipline, name) {
  return extras.some(d =>
    d.discipline === discipline &&
    d.categories.some(cn => name === `${d.discipline} - ${cn}` || name === cn)
  );
}

async function ensureCategoriesCatalog() {
  const tournaments = await db.prepare(`SELECT id, name FROM tournaments ORDER BY id ASC`).all();
  const report = { tournaments: tournaments.length, aligned: [], kept: [] };

  for (const t of tournaments) {
    const extras = getExtras(t);
    const existing = await db.prepare(`SELECT id, name, discipline FROM categories WHERE tournament_id = ?`).all(t.id);
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
      if (!inCatalog && !isExtraCategory(extras, cat.discipline, cat.name) && !referencedIds.has(String(cat.id))) {
        await db.prepare(`DELETE FROM categories WHERE id = ?`).run(cat.id);
        removed++;
      }
    }

    const insertIfMissing = async (discipline, catName) => {
      const displayName = `${discipline} - ${catName}`;
      const dup = await db.prepare(`
        SELECT id FROM categories WHERE tournament_id = ? AND discipline = ? AND name = ?
      `).get(t.id, discipline, displayName);
      if (!dup) {
        await db.prepare(`
          INSERT INTO categories (tournament_id, name, discipline, division, min_age, max_age, gender, schedule)
          VALUES (?, ?, ?, ?, 0, 99, 'MIXTO', 'A CONFIRMAR')
        `).run(t.id, displayName, discipline, catName);
        added++;
      }
    };

    for (const group of catalog) {
      for (const catName of group.categories) {
        await insertIfMissing(group.discipline, catName);
      }
    }

    for (const group of extras) {
      for (const catName of group.categories) {
        await insertIfMissing(group.discipline, catName);
      }
    }

    report.aligned.push({ id: t.id, name: t.name, added, removed });
  }

  return report;
}

module.exports = ensureCategoriesCatalog;
