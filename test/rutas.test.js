// Prueba de rutas: monta la app real contra el Postgres en proceso y verifica
// que todas las pantallas rendericen y que la inscripción guarde edad y
// categoría de edad.
const { pglite } = require('./harness');

const ok = [];
const fail = [];
function check(name, condition, detail) {
  if (condition) ok.push(name);
  else fail.push(`${name}${detail ? ' → ' + detail : ''}`);
}

let SESSION = null; // usuario simulado para cada request

async function buildApp() {
  const express = require('express');
  const path = require('path');
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.locals.formatCategoryName = require('../lib/categories').formatCategoryName;
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  // Sesión simulada
  app.use((req, res, next) => {
    req.session = SESSION ? { user: { ...SESSION } } : {};
    res.locals.user = req.session.user || null;
    next();
  });

  app.use('/', require('../routes/index'));
  app.use('/profesor', require('../routes/profesor'));
  app.use('/admin', require('../routes/admin'));

  app.use((err, req, res, next) => {
    console.error('ERROR EN RUTA:', req.originalUrl, '\n', err);
    res.status(500).send('ERROR: ' + err.message);
  });

  return app;
}

async function main() {
  // Reutiliza el mismo estado de producción simulado
  const { buildState } = require('./state');
  await buildState(pglite);

  const db = require('../database');
  await db.initPromise;

  await require('../lib/ensure_official_tournaments').ensureOfficialTournaments();
  await require('../lib/ensure_categories')();
  await require('../lib/ensure_categories_catalog')();
  await require('../lib/tournament_config').seedAllTournaments();

  const request = require('supertest');
  const app = await buildApp();

  const ids = await pglite.query(`SELECT id, name, official_key FROM tournaments ORDER BY id`);
  const zonaSur = ids.rows.find(t => t.official_key === 'ZONA_SUR').id;
  const zonaCaba = ids.rows.find(t => t.official_key === 'ZONA_CABA').id;
  const regId = (await pglite.query(`SELECT id FROM registrations ORDER BY id LIMIT 1`)).rows[0].id;

  const PROFE = { id: 2, username: 'giselle', full_name: 'GISELLE', role: 'profesor', club_id: 1, admin_scope: null };
  const ADMIN = { id: 1, username: 'admin', full_name: 'ADMIN', role: 'admin', club_id: 1, admin_scope: null };
  const PROFE_ADMIN = { id: 2, username: 'giselle', full_name: 'GISELLE', role: 'profesor_admin', club_id: 1, admin_scope: 'CABA' };

  async function get(user, url, expectOk = true) {
    SESSION = user;
    const res = await request(app).get(url);
    const good = res.status === 200;
    check(`GET ${url} (${user.role})`, good === expectOk, `status ${res.status}${res.status >= 500 ? ' · ' + String(res.text).slice(0, 160) : ''}`);
    return res;
  }

  // --- Pantallas de la profesora ---
  await get(PROFE, '/profesor/dashboard');
  const inscribir = await get(PROFE, '/profesor/inscribir');
  await get(PROFE, '/profesor/clubes');
  await get(PROFE, '/profesor/alumnos/nuevo');
  await get(PROFE, `/profesor/inscripciones/${regId}/editar`);

  // Orden y contenido del formulario de inscripción
  const html = inscribir.text;
  const order = ['1. Seleccionar Disciplina', '2. Seleccionar Alumna', '3. Seleccionar Categoría', '4. Edad', '5. Categoría de Edad', '6. Club de la Inscripción'];
  let lastPos = -1, ordered = true, missing = [];
  order.forEach(label => {
    const pos = html.indexOf(label);
    if (pos === -1) missing.push(label);
    else if (pos < lastPos) ordered = false;
    else lastPos = pos;
  });
  check('El formulario tiene los 6 campos en el orden pedido', ordered && missing.length === 0,
    missing.length ? 'faltan: ' + missing.join(', ') : 'orden incorrecto');
  check('El formulario oculta el tipo de inscripción en LIBRE y FREE DANCE',
    html.includes("HIDE_TYPE_DISCIPLINES = ['LIBRE', 'FREE DANCE']"));
  check('El formulario no ofrece STAR DANCE ni STYLE como disciplina',
    !/<option value="STAR DANCE"/.test(html) && !/<option value="STYLE"/.test(html));
  check('El formulario lleva las franjas de edad de FREE DANCE',
    html.includes('BABY') && html.includes('MINI INFANTIL'));

  // Las categorías viejas de FREE DANCE (que ahora son categorías de edad)
  // se conservan en la base pero ya no se pueden elegir al inscribir.
  const catalogoDelForm = JSON.parse(
    (html.match(/data-all-categories='([^']+)'/) || [])[1] || '[]'
  );
  const freeOfrecidas = catalogoDelForm.filter(c => c.discipline === 'FREE DANCE').map(c => c.label);
  check('FREE DANCE ya no ofrece las categorías viejas de edad (MINI TOTS)',
    !freeOfrecidas.includes('MINI TOTS'), freeOfrecidas.join(', '));
  check('FREE DANCE ofrece las categorías nuevas del Excel',
    freeOfrecidas.includes('DEBUTANTE') && freeOfrecidas.includes('STAR DANCE') && freeOfrecidas.includes('STYLE'),
    freeOfrecidas.join(', '));

  const historica = await pglite.query(
    `SELECT COUNT(*)::int AS n FROM categories WHERE is_active = false AND division = 'MINI TOTS'`);
  check('La categoría vieja sigue existiendo en la base (marcada histórica)', historica.rows[0].n > 0);

  // --- Alta de inscripción: guarda edad y categoría de edad ---
  SESSION = PROFE;
  const freeCat = (await pglite.query(
    `SELECT id FROM categories WHERE tournament_id = ${zonaSur} AND discipline = 'FREE DANCE' AND division = 'DEBUTANTE'`
  )).rows[0];

  const post = await request(app).post('/profesor/inscribir').send({
    tournament_id: String(zonaSur),
    category_id: String(freeCat.id),
    group_type: 'Individual',
    student_ids: '2',
    age: '16',
    age_band: 'JUVENIL',
    club_id: '1'
  });
  check('POST /profesor/inscribir responde bien', post.status < 400, `status ${post.status}`);

  const nueva = (await pglite.query(`SELECT age, age_band FROM registrations ORDER BY id DESC LIMIT 1`)).rows[0];
  check('La inscripción guarda la edad', Number(nueva.age) === 16, JSON.stringify(nueva));
  check('La inscripción guarda la categoría de edad', nueva.age_band === 'JUVENIL', JSON.stringify(nueva));

  // --- Pantallas del administrador ---
  await get(ADMIN, '/admin/dashboard');
  const dashFiltrado = await get(ADMIN, `/admin/dashboard?tournament_id=${zonaSur}`);
  check('El dashboard filtra por torneo', dashFiltrado.text.includes('Mostrando solo los datos de'));

  await get(ADMIN, '/admin/inscripciones');
  await get(ADMIN, '/admin/torneos');
  await get(ADMIN, `/admin/torneos/${zonaSur}/editar`);
  const config = await get(ADMIN, `/admin/torneos/${zonaSur}/categorias`);
  check('La configuración del torneo muestra categorías de edad',
    config.text.includes('Categorías de Edad'));
  check('La configuración marca STAR DANCE como histórica',
    config.text.includes('HISTÓRICA'));

  // Un torneo creado desde el panel tiene que arrancar con el catálogo completo,
  // si no las profesoras no pueden inscribir a nadie.
  SESSION = ADMIN;
  const crear = await request(app).post('/admin/torneos/nuevo').send({
    name: 'FECHA DE PRUEBA',
    venue: 'CLUB DE PRUEBA',
    date_from: '2026-11-01',
    date_to: '2026-11-01',
    registration_deadline: '2026-10-20',
    status: 'upcoming'
  });
  check('POST /admin/torneos/nuevo responde bien', crear.status < 400, `status ${crear.status}`);

  const nuevoTorneo = (await pglite.query(`SELECT id FROM tournaments WHERE name = 'FECHA DE PRUEBA'`)).rows[0];
  check('El torneo nuevo se creó', !!nuevoTorneo);

  if (nuevoTorneo) {
    const cats = (await pglite.query(`SELECT COUNT(*)::int AS n FROM categories WHERE tournament_id = ${nuevoTorneo.id}`)).rows[0].n;
    const discs = (await pglite.query(`SELECT COUNT(*)::int AS n FROM tournament_disciplines WHERE tournament_id = ${nuevoTorneo.id}`)).rows[0].n;
    const franjas = (await pglite.query(`SELECT COUNT(*)::int AS n FROM tournament_age_bands WHERE tournament_id = ${nuevoTorneo.id}`)).rows[0].n;
    check('El torneo nuevo arranca con las categorías del catálogo', cats > 60, `${cats} categorías`);
    check('El torneo nuevo arranca con las 11 disciplinas', discs === 11, `${discs} disciplinas`);
    check('El torneo nuevo arranca con las categorías de edad', franjas > 50, `${franjas} franjas`);

    SESSION = PROFE;
    const formNuevo = await request(app).get(`/profesor/inscribir?tournament_id=${nuevoTorneo.id}`);
    check('Se puede inscribir en el torneo nuevo',
      formNuevo.status === 200 && formNuevo.text.includes('FREE DANCE'), `status ${formNuevo.status}`);
  }

  await get(ADMIN, '/admin/usuarios');
  await get(ADMIN, '/admin/alumnos');
  await get(ADMIN, `/admin/inscripciones/${regId}/editar`);
  const csv = await get(ADMIN, '/admin/exportar/csv');
  check('La exportación incluye la Categoría de Edad', csv.text.includes('CATEGORÍA DE EDAD'));

  // --- Administrador con alcance limitado (Giselle → CABA) ---
  const torneosGiselle = await get(PROFE_ADMIN, '/admin/torneos');
  check('Giselle ve los torneos de CABA', torneosGiselle.text.includes('ZONA CABA'));
  check('Giselle NO ve los torneos de otras zonas', !torneosGiselle.text.includes('MEGA COPA'));

  await get(PROFE_ADMIN, `/admin/torneos/${zonaCaba}/editar`);
  const prohibido = await get(PROFE_ADMIN, `/admin/torneos/${zonaSur}/editar`, false);
  check('Giselle no puede editar un torneo de otra zona', prohibido.status === 404, `status ${prohibido.status}`);

  const usuariosGiselle = await get(PROFE_ADMIN, '/admin/usuarios', false);
  check('Giselle no gestiona usuarios', usuariosGiselle.status === 403, `status ${usuariosGiselle.status}`);

  // Menú combinado
  SESSION = PROFE_ADMIN;
  const panelProfe = await request(app).get('/profesor/dashboard');
  check('Giselle ve primero su módulo de profesora y luego el de administración',
    panelProfe.text.indexOf('Mis Alumnas') < panelProfe.text.indexOf('Panel de Administración') &&
    panelProfe.text.includes('Panel de Administración'));
}

main()
  .then(() => {
    console.log('\n================ RUTAS ================');
    ok.forEach(n => console.log('  ✅ ' + n));
    fail.forEach(n => console.log('  ❌ ' + n));
    console.log(`\n${ok.length} OK · ${fail.length} fallas`);
    process.exit(fail.length === 0 ? 0 : 1);
  })
  .catch(err => {
    console.error('\n💥 ERROR EN LA PRUEBA:\n', err);
    process.exit(1);
  });
