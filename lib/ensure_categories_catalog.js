// Alinea las categorías de TODOS los torneos con el catálogo oficial
// (data/catalogo_categorias.json).
//
// IMPORTANTE: esto corre UNA SOLA VEZ por revisión de catálogo. Antes se
// ejecutaba en cada arranque y pisaba lo que el administrador editaba a mano
// desde el panel. Ahora, cuando cambia el catálogo se sube CATALOG_REVISION en
// lib/tournament_config.js y recién ahí se re-alinea; el resto de los arranques
// no toca nada y manda lo que hay en la base.
//
// Las categorías que ya tengan inscripciones NUNCA se borran, aunque hayan
// salido del catálogo (ej: las viejas de STAR DANCE y STYLE).
const db = require('../database');
const catalog = require('../data/catalogo_categorias.json');
const tc = require('./tournament_config');

const REVISION_KEY = 'catalog_revision';

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

// Posición de una categoría dentro de su disciplina en el catálogo. Es lo que
// define el orden del desplegable: sin esto salían alfabéticas (FREE DANCE
// arrancaba en AVANZADO y LIBRE en 2DA C, en vez de seguir la progresión).
function categoryOrder(discipline, name) {
  const group = catalog.find(g => g.discipline === discipline);
  if (!group) return 900;
  const i = group.categories.findIndex(cn =>
    name === `${discipline} - ${cn}` || name === cn
  );
  return i === -1 ? 900 : i;
}

function isExtraCategory(extras, discipline, name) {
  return extras.some(d =>
    d.discipline === discipline &&
    d.categories.some(cn => name === `${d.discipline} - ${cn}` || name === cn)
  );
}

async function ensureCategoriesCatalog({ force = false } = {}) {
  const stored = await tc.getSetting(REVISION_KEY);
  if (!force && stored === tc.CATALOG_REVISION) {
    return { skipped: true, revision: stored, tournaments: 0, aligned: [] };
  }

  const tournaments = await db.prepare(`SELECT id, name FROM tournaments ORDER BY id ASC`).all();
  const report = { skipped: false, revision: tc.CATALOG_REVISION, tournaments: tournaments.length, aligned: [] };

  for (const t of tournaments) {
    const extras = getExtras(t);
    const existing = await db.prepare(`SELECT id, name, discipline FROM categories WHERE tournament_id = ?`).all(t.id);
    const referenced = await db.prepare(`
      SELECT DISTINCT category_id FROM registrations WHERE tournament_id = ?
    `).all(t.id);
    const referencedIds = new Set(referenced.map(r => String(r.category_id)));

    let added = 0, removed = 0, kept = 0;

    for (const cat of existing) {
      const inCatalog = catalog.some(g =>
        g.discipline === cat.discipline &&
        g.categories.some(cn => cat.name === `${g.discipline} - ${cn}` || cat.name === cn)
      );
      if (inCatalog) {
        await db.prepare(`UPDATE categories SET is_active = true, order_index = ? WHERE id = ?`)
          .run(categoryOrder(cat.discipline, cat.name), cat.id);
        continue;
      }

      if (isExtraCategory(extras, cat.discipline, cat.name)) {
        // Categorías propias de un torneo: van después de las del catálogo.
        await db.prepare(`UPDATE categories SET is_active = true, order_index = ? WHERE id = ?`)
          .run(500, cat.id);
        continue;
      }

      if (referencedIds.has(String(cat.id))) {
        // Tiene inscripciones: se conserva tal cual (para no romper las que ya
        // existen) pero se marca histórica y deja de ofrecerse al inscribir.
        await db.prepare(`UPDATE categories SET is_active = false, order_index = ? WHERE id = ?`)
          .run(900, cat.id);
        kept++;
        continue;
      }
      await db.prepare(`DELETE FROM categories WHERE id = ?`).run(cat.id);
      removed++;
    }

    const insertIfMissing = async (discipline, catName, orderIndex) => {
      const displayName = `${discipline} - ${catName}`;
      const dup = await db.prepare(`
        SELECT id FROM categories WHERE tournament_id = ? AND discipline = ? AND name = ?
      `).get(t.id, discipline, displayName);
      if (!dup) {
        await db.prepare(`
          INSERT INTO categories (tournament_id, name, discipline, division, min_age, max_age, gender, schedule, is_active, order_index)
          VALUES (?, ?, ?, ?, 0, 99, 'MIXTO', 'A CONFIRMAR', true, ?)
        `).run(t.id, displayName, discipline, catName, orderIndex);
        added++;
      }
    };

    for (const group of catalog) {
      for (let i = 0; i < group.categories.length; i++) {
        await insertIfMissing(group.discipline, group.categories[i], i);
      }
    }

    // Las categorías propias de un torneo van después de las del catálogo.
    for (const group of extras) {
      for (let i = 0; i < group.categories.length; i++) {
        await insertIfMissing(group.discipline, group.categories[i], 500 + i);
      }
    }

    report.aligned.push({ id: t.id, name: t.name, added, removed, kept });
  }

  await tc.setSetting(REVISION_KEY, tc.CATALOG_REVISION);
  return report;
}

module.exports = ensureCategoriesCatalog;
module.exports.REVISION_KEY = REVISION_KEY;
