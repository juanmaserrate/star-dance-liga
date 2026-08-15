// Prueba de extremo a extremo contra un Postgres real en proceso (PGlite).
//
// Reproduce el estado ACTUAL de producción (esquema viejo + datos parecidos),
// aplica las migraciones nuevas encima y verifica que:
//   1. No se pierde ninguna inscripción existente.
//   2. Las disciplinas quedan en el orden pedido y sin STAR DANCE / STYLE.
//   3. FREE DANCE tiene las categorías y franjas del Excel.
//   4. Todas las pantallas responden sin error para profesora y administrador.
const { pglite } = require('./harness');

const ok = [];
const fail = [];
function check(name, condition, detail) {
  if (condition) ok.push(name);
  else fail.push(`${name}${detail ? ' → ' + detail : ''}`);
}

const { buildState } = require('./state');

async function main() {
  await buildState(pglite);

  const before = await pglite.query('SELECT COUNT(*)::int AS n FROM registrations');
  const regsBefore = before.rows[0].n;

  // --- Migraciones + arranque (lo mismo que hace server.js) ---
  const db = require('../database');
  await db.initPromise;

  const { ensureOfficialTournaments } = require('../lib/ensure_official_tournaments');
  const torneosReport = await ensureOfficialTournaments();

  const ensureAllTournamentsHaveCategories = require('../lib/ensure_categories');
  await ensureAllTournamentsHaveCategories();

  const ensureCategoriesCatalog = require('../lib/ensure_categories_catalog');
  const catalogReport = await ensureCategoriesCatalog();

  const tc = require('../lib/tournament_config');
  const configReport = await tc.seedAllTournaments();

  // --- 1. Integridad de datos ---
  const after = await pglite.query('SELECT COUNT(*)::int AS n FROM registrations');
  check('No se pierde ninguna inscripción', after.rows[0].n === regsBefore,
    `antes ${regsBefore}, después ${after.rows[0].n}`);

  const legacy = await pglite.query(`
    SELECT c.discipline, COUNT(*)::int AS n FROM registrations r
    JOIN categories c ON c.id = r.category_id
    WHERE c.discipline IN ('STAR DANCE','STYLE') GROUP BY c.discipline ORDER BY 1`);
  check('Se conservan las inscripciones de STAR DANCE y STYLE',
    legacy.rows.length === 2 && legacy.rows.every(r => r.n > 0),
    JSON.stringify(legacy.rows));

  const orphanCats = await pglite.query(`
    SELECT COUNT(*)::int AS n FROM registrations r
    LEFT JOIN categories c ON c.id = r.category_id WHERE c.id IS NULL`);
  check('Ninguna inscripción quedó sin categoría', orphanCats.rows[0].n === 0);

  const emptyBands = await pglite.query(`SELECT COUNT(*)::int AS n FROM registrations WHERE age_band IS NULL`);
  check('Categoría de edad en blanco en las inscripciones viejas', emptyBands.rows[0].n === regsBefore,
    `${emptyBands.rows[0].n} de ${regsBefore}`);

  // --- 2. Torneos ---
  const torneos = await pglite.query(`SELECT name, venue, date_from, date_to, official_key FROM tournaments ORDER BY id`);
  const byName = {};
  torneos.rows.forEach(t => { byName[t.name] = t; });

  check('Se eliminó "3 ERA FECHA ZONA SUR" (no tenía inscripciones)', !byName['3 ERA FECHA ZONA SUR'],
    torneos.rows.map(t => t.name).join(', '));
  check('ZONA CABA → Argentinos Juniors', byName['ZONA CABA'] && byName['ZONA CABA'].venue === 'ARGENTINOS JUNIORS',
    byName['ZONA CABA'] && byName['ZONA CABA'].venue);
  // PGlite devuelve DATE como objeto Date; la app real usa setTypeParser para
  // recibir el texto crudo 'YYYY-MM-DD'. Se normaliza para comparar.
  const isoDate = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
  check('ZONA CABA → 6 de septiembre',
    byName['ZONA CABA'] && isoDate(byName['ZONA CABA'].date_from) === '2026-09-06' && isoDate(byName['ZONA CABA'].date_to) === '2026-09-06',
    byName['ZONA CABA'] && `${isoDate(byName['ZONA CABA'].date_from)} → ${isoDate(byName['ZONA CABA'].date_to)}`);
  check('MEGA COPA → Club Las Toninas', byName['MEGA COPA'] && byName['MEGA COPA'].venue === 'CLUB LAS TONINAS',
    byName['MEGA COPA'] && byName['MEGA COPA'].venue);
  check('ZONA SUR → Instituto Estrada', byName['ZONA SUR'] && byName['ZONA SUR'].venue === 'INSTITUTO ESTRADA',
    byName['ZONA SUR'] && byName['ZONA SUR'].venue);
  check('No se duplicaron torneos', torneos.rows.length === 3, `${torneos.rows.length} torneos`);

  // Renombrar un torneo no debe hacer que el arranque lo vuelva a crear
  await pglite.query(`UPDATE tournaments SET name = 'ZONA CABA 2026' WHERE official_key = 'ZONA_CABA'`);
  await ensureOfficialTournaments();
  const afterRename = await pglite.query(`SELECT COUNT(*)::int AS n FROM tournaments`);
  check('Renombrar un torneo no lo duplica en el próximo arranque', afterRename.rows[0].n === 3,
    `${afterRename.rows[0].n} torneos`);
  await pglite.query(`UPDATE tournaments SET name = 'ZONA CABA' WHERE official_key = 'ZONA_CABA'`);

  // --- 3. Catálogo y configuración ---
  const zonaSur = (await pglite.query(`SELECT id FROM tournaments WHERE official_key = 'ZONA_SUR'`)).rows[0].id;

  const discs = await tc.getDisciplines(zonaSur);
  const expected = ['LIBRE', 'FREE DANCE', 'SOLO DANCE', 'DÚO', 'TRÍO', 'CUARTETO', 'SMALL', 'SHOW', 'PRECISIÓN', 'PAREJAS MIXTAS', 'ADULTOS'];
  check('Disciplinas en el orden pedido',
    JSON.stringify(discs.map(d => d.discipline)) === JSON.stringify(expected),
    discs.map(d => d.discipline).join(' | '));

  check('STAR DANCE y STYLE ya no son disciplinas ofrecidas',
    !discs.some(d => ['STAR DANCE', 'STYLE'].includes(d.discipline)));

  const freeCats = await pglite.query(`
    SELECT division FROM categories WHERE tournament_id = ? AND discipline = 'FREE DANCE' ORDER BY division`
    .replace('?', zonaSur));
  const freeNames = freeCats.rows.map(r => r.division);
  check('FREE DANCE tiene STAR DANCE y STYLE como categorías',
    freeNames.includes('STAR DANCE') && freeNames.includes('STYLE'), freeNames.join(', '));
  check('FREE DANCE tiene las categorías del Excel',
    ['DEBUTANTE', 'INICIAL', 'BÁSICO', 'AVANZADO', 'EFICIENCIA C BÁSICO', 'NACIONAL INTERMEDIO'].every(n => freeNames.includes(n)),
    freeNames.join(', '));

  const bands = await tc.getAgeBandsByDiscipline(zonaSur);
  const freeBands = bands['FREE DANCE'] || [];
  check('FREE DANCE: franjas de edad del Excel (BABY 4-5 … MASTER 48-57)',
    freeBands.length === 13 && freeBands[0].name === 'BABY' && freeBands[0].min === 4 && freeBands[0].max === 5 &&
    freeBands[freeBands.length - 1].name === 'MASTER' && freeBands[freeBands.length - 1].max === 57,
    freeBands.map(b => `${b.name} ${b.min}-${b.max}`).join(', '));

  check('La edad cae en la franja correcta (12 años → INFANTIL)',
    (tc.bandForAge(freeBands, 12) || {}).name === 'INFANTIL',
    JSON.stringify(tc.bandForAge(freeBands, 12)));
  check('La edad cae en la franja correcta (5 años → BABY)',
    (tc.bandForAge(freeBands, 5) || {}).name === 'BABY');
  check('La edad cae en la franja correcta (25 años → CLÁSICO)',
    (tc.bandForAge(freeBands, 25) || {}).name === 'CLÁSICO');

  // Ninguna disciplina puede dejar edades sin cubrir entre su mínimo y su máximo
  for (const [disc, list] of Object.entries(bands)) {
    if (!list.length) continue;
    const min = Math.min(...list.map(b => b.min));
    const max = Math.max(...list.map(b => b.max));
    const huecos = [];
    for (let edad = min; edad <= max; edad++) {
      if (!tc.bandForAge(list, edad)) huecos.push(edad);
    }
    check(`${disc}: sin huecos de edad entre ${min} y ${max}`, huecos.length === 0,
      'edades sin categoría: ' + huecos.join(', '));
  }

  const soloDance = bands['SOLO DANCE'] || [];
  check('SOLO DANCE: la franja JUVENIL repetida quedó unificada (14-17)',
    soloDance.filter(b => b.name === 'JUVENIL').length === 1 &&
    (tc.bandForAge(soloDance, 16) || {}).name === 'JUVENIL' &&
    (tc.bandForAge(soloDance, 14) || {}).name === 'JUVENIL',
    soloDance.map(b => `${b.name} ${b.min}-${b.max}`).join(', '));

  // El catálogo no se vuelve a re-alinear en el siguiente arranque
  const second = await ensureCategoriesCatalog();
  check('El catálogo no pisa la configuración en el siguiente arranque', second.skipped === true);

  // Lo que edita el administrador sobrevive al reinicio
  await pglite.query(`UPDATE tournament_disciplines SET is_enabled = false WHERE tournament_id = ${zonaSur} AND discipline = 'SHOW'`);
  await tc.seedAllTournaments();
  const showRow = await pglite.query(`SELECT is_enabled FROM tournament_disciplines WHERE tournament_id = ${zonaSur} AND discipline = 'SHOW'`);
  check('Las ediciones del administrador sobreviven al reinicio', showRow.rows[0].is_enabled === false);
  await pglite.query(`UPDATE tournament_disciplines SET is_enabled = true WHERE tournament_id = ${zonaSur} AND discipline = 'SHOW'`);

  // --- 4. Roles ---
  const { ensureRoles } = require('../lib/ensure_roles');
  const rolesReport = await ensureRoles();

  const giselle = (await pglite.query(`SELECT role, admin_scope FROM users WHERE username = 'gisellelorenaalarcon@hotmail.com'`)).rows[0];
  check('Giselle queda como profesor + administrador de CABA',
    giselle.role === 'profesor_admin' && giselle.admin_scope === 'CABA', JSON.stringify(giselle));

  const sandra = (await pglite.query(`SELECT role, admin_scope FROM users WHERE username = 'sandrasil222@hotmail.com'`)).rows[0];
  check('Sandra Puglisi queda como profesor + administrador sin restricción',
    sandra.role === 'profesor_admin' && !sandra.admin_scope, JSON.stringify(sandra));

  check('Se avisa si alguna cuenta no existe todavía (Daniel)',
    rolesReport.notFound.includes('coagju@gmail.com.ar'), JSON.stringify(rolesReport.notFound));

  const rolesAgain = await ensureRoles();
  check('Los roles no se vuelven a pisar en el siguiente arranque', rolesAgain.skipped === true);

  const auth = require('../middleware/auth');
  check('profesor_admin cuenta como profesora', auth.isProfesor('profesor_admin'));
  check('profesor_admin cuenta como administrador', auth.isAdmin('profesor_admin'));
  check('Giselle solo administra torneos de CABA',
    auth.canManageTournament({ admin_scope: 'CABA' }, { name: 'ZONA CABA' }) === true &&
    auth.canManageTournament({ admin_scope: 'CABA' }, { name: 'ZONA SUR' }) === false);
  check('Sandra y Daniel administran todos los torneos',
    auth.canManageTournament({ admin_scope: null }, { name: 'ZONA SUR' }) === true);

  return { torneosReport, catalogReport, configReport, zonaSur };
}

main()
  .then(async (ctx) => {
    console.log('\n================ RESULTADO ================');
    ok.forEach(n => console.log('  ✅ ' + n));
    fail.forEach(n => console.log('  ❌ ' + n));
    console.log(`\n${ok.length} OK · ${fail.length} fallas`);
    process.exit(fail.length === 0 ? 0 : 1);
  })
  .catch(err => {
    console.error('\n💥 ERROR EN LA PRUEBA:\n', err);
    process.exit(1);
  });
