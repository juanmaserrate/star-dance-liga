// Configuración por torneo: qué disciplinas se ofrecen, en qué orden, y qué
// categorías de edad (franjas) tiene cada una.
//
// El catálogo oficial (data/catalogo_categorias.json) es solo la SEMILLA: la
// primera vez que se ve un torneo se copian sus disciplinas y franjas a la base.
// A partir de ahí manda la base, así lo que el administrador edita desde el
// panel no se pisa en el siguiente arranque.
const db = require('../database');
const catalog = require('../data/catalogo_categorias.json');

// Subir este número cuando cambie data/catalogo_categorias.json y haya que
// re-alinear los torneos existentes con el catálogo nuevo.
const CATALOG_REVISION = '2026-08-15-free-dance';

function normalize(s) {
  return String(s || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function catalogGroup(discipline) {
  const target = normalize(discipline);
  return catalog.find(g => normalize(g.discipline) === target) || null;
}

// Orden oficial de la disciplina dentro del catálogo (para ordenar por defecto).
function catalogOrder(discipline) {
  const target = normalize(discipline);
  const i = catalog.findIndex(g => normalize(g.discipline) === target);
  return i === -1 ? 999 : i;
}

async function getSetting(key) {
  const row = await db.prepare(`SELECT value FROM site_settings WHERE key = ?`).get(key);
  return row ? row.value : null;
}

async function setSetting(key, value) {
  await db.prepare(`
    INSERT INTO site_settings (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `).run(key, value);
}

// El catálogo trae algunas disciplinas con el mismo nombre de franja repetido
// (ej: SOLO DANCE / SMALL / SHOW / PRECISIÓN tienen JUVENIL 14-15 y JUVENIL
// 16-17). Como las franjas se identifican por nombre dentro de la disciplina,
// se unifican en un único tramo (JUVENIL 14-17) para no dejar edades sin cubrir.
// El administrador puede separarlas después desde el panel del torneo.
function mergeDuplicateBands(ages) {
  const out = [];
  const byName = new Map();
  for (const a of ages || []) {
    const key = normalize(a.name);
    if (byName.has(key)) {
      const prev = byName.get(key);
      prev.min = Math.min(prev.min, a.min);
      prev.max = Math.max(prev.max, a.max);
      continue;
    }
    const copy = { name: a.name, min: a.min, max: a.max };
    byName.set(key, copy);
    out.push(copy);
  }
  return out;
}

// Copia al torneo las disciplinas y franjas del catálogo que todavía no tenga.
// Nunca borra ni reordena lo que ya está cargado (eso es del administrador).
async function seedTournament(tournamentId) {
  const report = { disciplines: 0, bands: 0 };

  for (let i = 0; i < catalog.length; i++) {
    const group = catalog[i];

    const existing = await db.prepare(`
      SELECT id FROM tournament_disciplines WHERE tournament_id = ? AND discipline = ?
    `).get(tournamentId, group.discipline);

    if (!existing) {
      await db.prepare(`
        INSERT INTO tournament_disciplines (tournament_id, discipline, order_index, is_enabled)
        VALUES (?, ?, ?, true)
        ON CONFLICT (tournament_id, discipline) DO NOTHING
      `).run(tournamentId, group.discipline, i);
      report.disciplines++;
    }

    const ages = mergeDuplicateBands(Array.isArray(group.ages) ? group.ages : []);
    for (let j = 0; j < ages.length; j++) {
      const band = ages[j];
      const dup = await db.prepare(`
        SELECT id FROM tournament_age_bands
        WHERE tournament_id = ? AND discipline = ? AND name = ?
      `).get(tournamentId, group.discipline, band.name);
      if (!dup) {
        await db.prepare(`
          INSERT INTO tournament_age_bands (tournament_id, discipline, name, min_age, max_age, order_index)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (tournament_id, discipline, name) DO NOTHING
        `).run(tournamentId, group.discipline, band.name, band.min, band.max, j);
        report.bands++;
      }
    }
  }

  return report;
}

// Copia al torneo las categorías del catálogo que le falten. Se usa al crear un
// torneo nuevo y al abrir su pantalla de configuración, para que nunca quede
// vacío. Es idempotente: nunca duplica ni borra lo que ya está.
async function seedCategories(tournamentId) {
  let added = 0;

  for (const group of catalog) {
    for (const catName of group.categories) {
      const displayName = `${group.discipline} - ${catName}`;
      const dup = await db.prepare(`
        SELECT id FROM categories WHERE tournament_id = ? AND discipline = ? AND name = ?
      `).get(tournamentId, group.discipline, displayName);
      if (dup) continue;

      await db.prepare(`
        INSERT INTO categories (tournament_id, name, discipline, division, min_age, max_age, gender, schedule, is_active)
        VALUES (?, ?, ?, ?, 0, 99, 'MIXTO', 'A CONFIRMAR', true)
      `).run(tournamentId, displayName, group.discipline, catName);
      added++;
    }
  }

  return { added };
}

// Arranque: asegura que todos los torneos tengan su configuración sembrada.
async function seedAllTournaments() {
  const tournaments = await db.prepare(`SELECT id FROM tournaments ORDER BY id ASC`).all();
  let disciplines = 0, bands = 0;
  for (const t of tournaments) {
    const r = await seedTournament(t.id);
    disciplines += r.disciplines;
    bands += r.bands;
  }
  return { tournaments: tournaments.length, disciplines, bands };
}

// Disciplinas habilitadas de un torneo, en el orden configurado.
async function getDisciplines(tournamentId, { includeDisabled = false } = {}) {
  const rows = await db.prepare(`
    SELECT * FROM tournament_disciplines
    WHERE tournament_id = ? ${includeDisabled ? '' : 'AND is_enabled = true'}
    ORDER BY order_index ASC, discipline ASC
  `).all(tournamentId);
  return rows;
}

// Franjas de edad de un torneo agrupadas por disciplina: { 'FREE DANCE': [...] }
async function getAgeBandsByDiscipline(tournamentId) {
  const rows = await db.prepare(`
    SELECT discipline, name, min_age, max_age FROM tournament_age_bands
    WHERE tournament_id = ?
    ORDER BY discipline ASC, order_index ASC, min_age ASC
  `).all(tournamentId);

  const map = {};
  for (const r of rows) {
    if (!map[r.discipline]) map[r.discipline] = [];
    map[r.discipline].push({ name: r.name, min: r.min_age, max: r.max_age });
  }
  return map;
}

// Devuelve la franja que corresponde a una edad concreta (o null).
function bandForAge(bands, age) {
  const n = parseInt(age, 10);
  if (!Number.isFinite(n)) return null;
  return (bands || []).find(b => n >= b.min && n <= b.max) || null;
}

module.exports = {
  CATALOG_REVISION,
  catalog,
  catalogGroup,
  catalogOrder,
  normalize,
  getSetting,
  setSetting,
  seedTournament,
  seedCategories,
  seedAllTournaments,
  getDisciplines,
  getAgeBandsByDiscipline,
  bandForAge
};
