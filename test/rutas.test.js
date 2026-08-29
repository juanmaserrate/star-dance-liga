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

  const insc = require('../lib/inscripciones_export');
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
  check('El formulario oculta el tipo de inscripción en LIBRE, FREE DANCE y ADULTOS',
    html.includes("HIDE_TYPE_DISCIPLINES = ['LIBRE', 'FREE DANCE', 'ADULTOS']"));

  // ADULTOS: desplegable de Reglamento arriba del de Categoría.
  check('El formulario ofrece ADULTOS como disciplina',
    /<option value="ADULTOS"/.test(html));
  check('El formulario tiene el desplegable de Reglamento',
    html.includes('id="ruleset"') && html.includes('Reglamento'));
  check('El Reglamento va arriba de la Categoría',
    html.indexOf('id="ruleset_box"') < html.indexOf('id="category_id"') &&
    html.indexOf('id="ruleset_box"') !== -1);
  check('El formulario lleva los dos reglamentos de ADULTOS',
    html.includes('REGLAMENTO INTERNO STAR DANCE') && html.includes('REGLAMENTO CAP'));
  check('Cada categoría de ADULTOS viaja con su reglamento',
    /"label":"ESCUELA FORMATIVA","discipline":"ADULTOS","ruleset":"REGLAMENTO INTERNO STAR DANCE"/.test(html) &&
    /"label":"ELITE","discipline":"ADULTOS","ruleset":"REGLAMENTO CAP"/.test(html));
  check('El formulario lleva las franjas de edad de ADULTOS',
    html.includes('PROFESIONAL') && html.includes('MASTER'));
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

  // --- No se puede repetir alumna + categoría dentro del MISMO torneo ---
  const contar = async () => (await pglite.query(`SELECT COUNT(*)::int AS n FROM registrations`)).rows[0].n;
  const antesDup = await contar();

  const repetida = await request(app).post('/profesor/inscribir').send({
    tournament_id: String(zonaSur), category_id: String(freeCat.id),
    group_type: 'Individual', student_ids: '2', age: '16', club_id: '1'
  });
  check('Rechaza inscribir dos veces en la misma categoría del mismo torneo',
    (await contar()) === antesDup, `quedaron ${await contar()} (antes ${antesDup})`);
  check('Y explica el motivo en pantalla',
    decodeURIComponent(repetida.headers.location || '').includes('ya está inscripta'),
    decodeURIComponent(repetida.headers.location || ''));

  // Otra categoría del mismo torneo sí se permite: no es un duplicado
  const otraCat = (await pglite.query(
    `SELECT id FROM categories WHERE tournament_id = ${zonaSur} AND discipline = 'FREE DANCE' AND division = 'INICIAL'`
  )).rows[0];
  await request(app).post('/profesor/inscribir').send({
    tournament_id: String(zonaSur), category_id: String(otraCat.id),
    group_type: 'Individual', student_ids: '2', age: '16', club_id: '1'
  });
  check('Deja inscribir a la misma alumna en OTRA categoría del torneo',
    (await contar()) === antesDup + 1, `quedaron ${await contar()}`);

  // La misma categoría en OTRO torneo también se permite: el control es por torneo
  const mismaEnCaba = (await pglite.query(
    `SELECT id FROM categories WHERE tournament_id = ${zonaCaba} AND discipline = 'FREE DANCE' AND division = 'DEBUTANTE'`
  )).rows[0];
  await request(app).post('/profesor/inscribir').send({
    tournament_id: String(zonaCaba), category_id: String(mismaEnCaba.id),
    group_type: 'Individual', student_ids: '2', age: '16', club_id: '1'
  });
  check('Deja inscribir la MISMA categoría en otro torneo (el control es por torneo)',
    (await contar()) === antesDup + 2, `quedaron ${await contar()}`);

  const formDup = await request(app).get(`/profesor/inscribir?tournament_id=${zonaSur}`);
  check('El formulario avisa del repetido antes de confirmar',
    formDup.text.includes('YA_INSCRIPTAS') && formDup.text.includes('dup_warning'));

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

    const adultos = (await pglite.query(`SELECT COUNT(*)::int AS n FROM categories
      WHERE tournament_id = ${nuevoTorneo.id} AND discipline = 'ADULTOS' AND ruleset IS NOT NULL`)).rows[0].n;
    check('El torneo nuevo arranca con ADULTOS y sus reglamentos', adultos === 9, `${adultos} categorías`);

    SESSION = PROFE;
    const formNuevo = await request(app).get(`/profesor/inscribir?tournament_id=${nuevoTorneo.id}`);
    check('Se puede inscribir en el torneo nuevo',
      formNuevo.status === 200 && formNuevo.text.includes('FREE DANCE'), `status ${formNuevo.status}`);

    // --- Atajos de configuración: carga en lote, copiar y restaurar ---
    SESSION = ADMIN;
    const T = nuevoTorneo.id;

    await request(app).post(`/admin/torneos/${T}/categorias/lote`)
      .send({ discipline: 'LIBRE', names: 'PRUEBA UNO\nPRUEBA DOS\nPRUEBA UNO' });
    const lote = (await pglite.query(`SELECT division FROM categories
      WHERE tournament_id = ${T} AND division LIKE 'PRUEBA %' ORDER BY division`)).rows.map(r => r.division);
    check('Carga en lote: agrega varias categorías de una vez y saltea repetidas',
      JSON.stringify(lote) === JSON.stringify(['PRUEBA DOS', 'PRUEBA UNO']), lote.join(', '));

    await request(app).post(`/admin/torneos/${T}/franjas/lote`)
      .send({ discipline: 'LIBRE', bands: 'PRUEBA CHICA 4-5\nPRUEBA GRANDE 6 a 9\nrenglon sin edades' });
    const lb = (await pglite.query(`SELECT name, min_age, max_age FROM tournament_age_bands
      WHERE tournament_id = ${T} AND discipline = 'LIBRE' AND name LIKE 'PRUEBA %' ORDER BY min_age`)).rows;
    check('Carga en lote: entiende "NOMBRE 4-5" y "NOMBRE 6 a 9"',
      lb.length === 2 && lb[0].name === 'PRUEBA CHICA' && lb[0].min_age === 4 && lb[0].max_age === 5 &&
      lb[1].name === 'PRUEBA GRANDE' && lb[1].min_age === 6 && lb[1].max_age === 9,
      JSON.stringify(lb));

    // Restaurar es aditivo: no puede borrar lo que se cargó a mano
    await request(app).post(`/admin/torneos/${T}/restaurar-catalogo`).send({});
    const sobrevive = (await pglite.query(`SELECT COUNT(*)::int AS n FROM categories
      WHERE tournament_id = ${T} AND division = 'PRUEBA UNO'`)).rows[0].n;
    check('Restaurar el catálogo no borra lo que cargó el administrador', sobrevive === 1);

    // Copiar de otro torneo: trae lo que falta y no duplica
    const antesCopia = (await pglite.query(`SELECT COUNT(*)::int AS n FROM categories WHERE tournament_id = ${zonaCaba}`)).rows[0].n;
    await request(app).post(`/admin/torneos/${zonaCaba}/copiar-de`).send({ source_tournament_id: String(T) });
    const copiadas = (await pglite.query(`SELECT COUNT(*)::int AS n FROM categories
      WHERE tournament_id = ${zonaCaba} AND division = 'PRUEBA UNO'`)).rows[0].n;
    check('Copiar de otro torneo trae sus categorías', copiadas === 1);

    await request(app).post(`/admin/torneos/${zonaCaba}/copiar-de`).send({ source_tournament_id: String(T) });
    const trasDoble = (await pglite.query(`SELECT COUNT(*)::int AS n FROM categories
      WHERE tournament_id = ${zonaCaba} AND division = 'PRUEBA UNO'`)).rows[0].n;
    check('Copiar dos veces no duplica nada', trasDoble === 1);
    check('Copiar no borra lo que el torneo ya tenía',
      (await pglite.query(`SELECT COUNT(*)::int AS n FROM categories WHERE tournament_id = ${zonaCaba}`)).rows[0].n > antesCopia);

    const noMismo = await request(app).post(`/admin/torneos/${T}/copiar-de`).send({ source_tournament_id: String(T) });
    check('No deja copiar un torneo sobre sí mismo',
      decodeURIComponent(noMismo.headers.location || '').includes('tiene que ser otro'),
      noMismo.headers.location);
  }

  await get(ADMIN, '/admin/usuarios');
  await get(ADMIN, '/admin/alumnos');
  await get(ADMIN, `/admin/inscripciones/${regId}/editar`);
  const csv = await get(ADMIN, '/admin/exportar/csv');
  check('La exportación incluye la Categoría de Edad', csv.text.includes('CATEGORÍA DE EDAD'));

  // --- Planilla del torneo agrupada por disciplina y categoría ---
  const dash = await get(ADMIN, '/admin/dashboard');
  check('El dashboard ofrece descargar la planilla del torneo',
    dash.text.includes('/admin/exportar/planilla') && dash.text.includes('Descargar Planilla del Torneo'));

  const planilla = await request(app).get(`/admin/exportar/planilla?tournament_id=${zonaSur}`);
  check('GET /admin/exportar/planilla responde un .xlsx',
    planilla.status === 200 &&
    /spreadsheetml/.test(planilla.headers['content-type'] || '') &&
    /filename="PLANILLA_/.test(planilla.headers['content-disposition'] || ''),
    `status ${planilla.status} · ${planilla.headers['content-type']}`);
  check('La planilla no viene vacía', Number(planilla.headers['content-length']) > 3000,
    `${planilla.headers['content-length']} bytes`);

  const sinTorneo = await request(app).get('/admin/exportar/planilla');
  check('Sin torneo elegido, la planilla avisa en vez de romper',
    sinTorneo.status === 302 && decodeURIComponent(sinTorneo.headers.location || '').includes('Elegí un torneo'),
    `status ${sinTorneo.status}`);

  // El agrupado tiene que respetar el orden del torneo, no el alfabético
  const filas = await insc.fetchForGroupedSheet(zonaSur);
  const grupos = insc.groupByDisciplineAndCategory(filas);
  check('La planilla agrupa por disciplina y adentro por categoría',
    grupos.length > 0 && grupos.every(g => g.discipline && g.categorias.length > 0 &&
      g.total === g.categorias.reduce((n, c) => n + c.filas.length, 0)),
    grupos.map(g => `${g.discipline}(${g.categorias.length} cat/${g.total})`).join(' '));
  check('La disciplina mayoritaria (LIBRE) va primero, como en el formulario',
    grupos[0].discipline === 'LIBRE', grupos.map(g => g.discipline).join(' > '));
  check('Cada fila lleva nombre, edad, categoría de edad y club',
    filas.every(f => 'nombre' in f && 'edad' in f && 'categoria_edad' in f && 'club' in f));

  const buf = Buffer.from(await insc.buildXlsxPorCategoria(filas,
    { name: 'ZONA SUR', datesLabel: '6 DE SEPTIEMBRE', venue: 'INSTITUTO ESTRADA' }));
  check('El archivo generado es un .xlsx válido',
    buf.length > 3000 && buf[0] === 0x50 && buf[1] === 0x4b, `${buf.length} bytes`);

  // El cuadro tiene que llevar la categoría como columna, además del bloque
  const ExcelJS = require('exceljs');
  const leido = new ExcelJS.Workbook();
  await leido.xlsx.load(buf);
  const hoja = leido.getWorksheet('Planilla');
  let encabezado = null, primeraFila = null;
  hoja.eachRow((fila, n) => {
    if (encabezado || String(fila.getCell(1).value || '') !== 'NOMBRE COMPLETO') return;
    encabezado = [1, 2, 3, 4, 5].map(c => String(fila.getCell(c).value || ''));
    primeraFila = [1, 2, 3, 4, 5].map(c => hoja.getRow(n + 1).getCell(c).value);
  });
  check('Las columnas son nombre, edad, categoría, categoría de edad y club',
    JSON.stringify(encabezado) === JSON.stringify(
      ['NOMBRE COMPLETO', 'EDAD', 'CATEGORÍA', 'CATEGORÍA DE EDAD', 'CLUB']),
    JSON.stringify(encabezado));
  check('Cada renglón trae la categoría cargada',
    primeraFila && primeraFila[2] && String(primeraFila[2]).trim() !== '',
    JSON.stringify(primeraFila));

  const vacia = Buffer.from(await insc.buildXlsxPorCategoria([],
    { name: 'TORNEO VACÍO', datesLabel: '', venue: '' }));
  check('Un torneo sin inscripciones genera la planilla igual, sin romper', vacia.length > 2000);

  // --- Segunda opción: agrupada por categoría, con disciplina como columna ---
  const porCat = await request(app).get(`/admin/exportar/planilla?tournament_id=${zonaSur}&agrupar=categoria`);
  check('GET la planilla agrupada por categoría',
    porCat.status === 200 &&
    /filename="PLANILLA_.*_POR_CATEGORIA\.xlsx"/.test(porCat.headers['content-disposition'] || ''),
    porCat.headers['content-disposition']);

  const bloques = insc.groupByCategory(filas);
  check('Agrupa por categoría sin importar la disciplina',
    bloques.length > 0 && bloques.every(b => b.label && b.filas.length === b.total),
    bloques.slice(0, 4).map(b => `${b.label}(${b.total})`).join(' '));

  // La misma categoría de dos disciplinas distintas tiene que caer en un solo
  // bloque: es el sentido de agrupar por categoría en vez de por disciplina.
  const sinteticas = [
    { discipline: 'LIBRE', category_name: 'LIBRE - 4TA', cat_order: 6, nombre: 'B GRANDE', edad: 30, club: 'X' },
    { discipline: 'PAREJAS MIXTAS', category_name: 'PAREJAS MIXTAS - 4TA', cat_order: 6, nombre: 'A CHICA', edad: 9, club: 'Y' },
    { discipline: 'LIBRE', category_name: 'LIBRE - 4TA', cat_order: 6, nombre: 'C MEDIANA', edad: 15, club: 'Z' },
    { discipline: 'FREE DANCE', category_name: 'FREE DANCE - INICIAL', cat_order: 1, nombre: 'D SIN EDAD', edad: null, club: 'W' },
    { discipline: 'FREE DANCE', category_name: 'FREE DANCE - INICIAL', cat_order: 1, nombre: 'E CHICA', edad: 7, club: 'W' }
  ];
  const bs = insc.groupByCategory(sinteticas);
  const b4ta = bs.find(b => b.label === '4TA');
  check('Una categoría compartida junta las disciplinas en un solo bloque',
    b4ta && b4ta.total === 3 &&
    JSON.stringify([...new Set(b4ta.filas.map(f => f.discipline))].sort()) ===
      JSON.stringify(['LIBRE', 'PAREJAS MIXTAS']),
    b4ta ? `${b4ta.label}: ${b4ta.filas.map(f => f.discipline).join(' + ')}` : 'no agrupó');
  check('Dentro del bloque compartido las edades salen de menor a mayor',
    b4ta && JSON.stringify(b4ta.filas.map(f => f.edad)) === JSON.stringify([9, 15, 30]),
    b4ta ? JSON.stringify(b4ta.filas.map(f => f.edad)) : '');
  const bInicial = bs.find(b => b.label === 'INICIAL');
  check('Las que no tienen la edad cargada quedan al final del cuadro',
    bInicial && bInicial.filas[bInicial.filas.length - 1].nombre === 'D SIN EDAD',
    bInicial ? bInicial.filas.map(f => `${f.nombre}=${f.edad}`).join(' · ') : '');
  check('Los bloques salen en el orden oficial, no alfabético',
    JSON.stringify(bs.map(b => b.label)) === JSON.stringify(['INICIAL', '4TA']),
    bs.map(b => b.label).join(' > '));

  check('Dentro de cada categoría las edades van de menor a mayor',
    bloques.every(b => {
      const e = b.filas.map(f => (f.edad === null || f.edad === undefined) ? Infinity : Number(f.edad));
      return e.every((v, i) => i === 0 || e[i - 1] <= v);
    }),
    JSON.stringify(bloques[0].filas.map(f => f.edad)));

  const bufCat = Buffer.from(await insc.buildXlsxPorCategoriaSola(filas,
    { name: 'ZONA SUR', datesLabel: '6 DE SEPTIEMBRE', venue: 'INSTITUTO ESTRADA' }));
  const leidoCat = new ExcelJS.Workbook();
  await leidoCat.xlsx.load(bufCat);
  const hojaCat = leidoCat.getWorksheet('Planilla');
  let encCat = null;
  hojaCat.eachRow(fila => {
    if (encCat || String(fila.getCell(1).value || '') !== 'NOMBRE COMPLETO') return;
    encCat = [1, 2, 3, 4, 5, 6].map(c => String(fila.getCell(c).value || ''));
  });
  check('La planilla por categoría suma DISCIPLINA como columna',
    JSON.stringify(encCat) === JSON.stringify(
      ['NOMBRE COMPLETO', 'EDAD', 'DISCIPLINA', 'CATEGORÍA', 'CATEGORÍA DE EDAD', 'CLUB']),
    JSON.stringify(encCat));

  check('El dashboard deja elegir cómo agrupar la planilla',
    dash.text.includes('name="agrupar"') && dash.text.includes('value="categoria"') &&
    dash.text.includes('value="categoria_hojas"'));

  // --- Tercera opción: una hoja por categoría ---
  const porHojas = await request(app).get(
    `/admin/exportar/planilla?tournament_id=${zonaSur}&agrupar=categoria_hojas`);
  check('GET planilla con una hoja por categoría responde un .xlsx',
    porHojas.status === 200 &&
    /spreadsheetml/.test(porHojas.headers['content-type'] || '') &&
    /filename="PLANILLA_.*_POR_CATEGORIA_EN_HOJAS\.xlsx"/.test(porHojas.headers['content-disposition'] || ''),
    `status ${porHojas.status} · ${porHojas.headers['content-disposition']}`);

  const bufHojas = Buffer.from(await insc.buildXlsxHojaPorCategoria(filas,
    { name: 'ZONA SUR', datesLabel: '6 DE SEPTIEMBRE', venue: 'INSTITUTO ESTRADA' }));
  const libro = new ExcelJS.Workbook();
  await libro.xlsx.load(bufHojas);
  const nombres = libro.worksheets.map(w => w.name);

  check('El libro trae una hoja por cada categoría, más el índice',
    nombres[0] === 'Índice' && nombres.length === bloques.length + 1,
    `${nombres.length} hojas para ${bloques.length} categorías`);
  check('Ningún nombre de hoja pasa los 31 caracteres ni se repite',
    nombres.every(n => n.length <= 31) && new Set(nombres.map(n => n.toUpperCase())).size === nombres.length,
    nombres.filter(n => n.length > 31).join(', ') || 'ok');

  const primera = libro.getWorksheet(nombres[1]);
  let encHojas = null, edades = [];
  primera.eachRow((fila, n) => {
    if (encHojas) return;
    if (String(fila.getCell(1).value || '') !== 'NOMBRE COMPLETO') return;
    encHojas = [1, 2, 3, 4, 5, 6].map(c => String(fila.getCell(c).value || ''));
    for (let r = n + 1; r <= primera.rowCount; r++) {
      const v = primera.getRow(r).getCell(2).value;
      if (v === null || v === undefined || v === '') break;
      edades.push(Number(v));
    }
  });
  check('Cada hoja lleva las mismas columnas, con DISCIPLINA incluida',
    JSON.stringify(encHojas) === JSON.stringify(
      ['NOMBRE COMPLETO', 'EDAD', 'DISCIPLINA', 'CATEGORÍA', 'CATEGORÍA DE EDAD', 'CLUB']),
    JSON.stringify(encHojas));
  check('Dentro de la hoja las edades van de menor a mayor',
    edades.every((v, i) => i === 0 || edades[i - 1] <= v), JSON.stringify(edades));

  const indice = libro.getWorksheet('Índice');
  let filasIndice = 0;
  indice.eachRow(fila => { if (Number.isFinite(Number(fila.getCell(2).value))) filasIndice++; });
  check('El índice lista todas las categorías', filasIndice === bloques.length,
    `${filasIndice} de ${bloques.length}`);

  // Nombres de hoja: recorte, saneado de caracteres prohibidos y sin repetir
  const usados = new Set();
  check('Los nombres de hoja se sanean y no chocan entre sí',
    insc.sheetName('LIBRE/EXHIBICIÓN', usados) === 'LIBRE EXHIBICIÓN' &&
    insc.sheetName('LIBRE/EXHIBICIÓN', usados) === 'LIBRE EXHIBICIÓN (2)' &&
    insc.sheetName('X'.repeat(60), usados).length === 31);


  // --- Libro Mayor: el armado por defecto ---
  const libroMayor = await request(app).get(
    `/admin/exportar/planilla?tournament_id=${zonaSur}&agrupar=libro_mayor`);
  check('GET del Libro Mayor responde un .xlsx',
    libroMayor.status === 200 &&
    /spreadsheetml/.test(libroMayor.headers['content-type'] || '') &&
    /filename="PLANILLA_.*_LIBRO_MAYOR\.xlsx"/.test(libroMayor.headers['content-disposition'] || ''),
    `status ${libroMayor.status} · ${libroMayor.headers['content-disposition']}`);

  // Sin elegir armado tiene que salir el Libro Mayor
  const porDefecto = await request(app).get(
    `/admin/exportar/planilla?tournament_id=${zonaSur}`);
  check('Sin elegir armado, el que sale es el Libro Mayor',
    /filename="PLANILLA_.*_LIBRO_MAYOR\.xlsx"/.test(porDefecto.headers['content-disposition'] || ''),
    porDefecto.headers['content-disposition']);
  check('El desplegable ofrece el Libro Mayor y viene seleccionado',
    dash.text.includes('value="libro_mayor" selected') && dash.text.includes('Libro Mayor'));

  // El bloque se arma con disciplina + categoría + categoría de edad
  const pistaBloques = insc.groupByOrdenDePista(filas);
  const conFranja = pistaBloques.find(b => b.franja);
  check('Cada bloque titula disciplina + categoría + categoría de edad',
    !!conFranja && conFranja.titulo === `${conFranja.discipline} ${conFranja.label} ${conFranja.franja}`,
    conFranja ? conFranja.titulo : 'sin bloques con franja');
  check('Si la inscripción no tiene categoría de edad, el título no la inventa',
    pistaBloques.filter(b => !b.franja).every(b => b.titulo === `${b.discipline} ${b.label}`),
    JSON.stringify(pistaBloques.filter(b => !b.franja).slice(0, 3).map(b => b.titulo)));
  check('Ninguna inscripción se pierde ni se duplica al agrupar',
    pistaBloques.reduce((n, b) => n + b.total, 0) === filas.length,
    `${pistaBloques.reduce((n, b) => n + b.total, 0)} de ${filas.length}`);


  // --- La exportación no puede perder inscripciones en el camino ---
  // Los JOIN de la consulta (club, categoría, torneo) son internos: si alguno
  // no encontrara pareja, esas filas desaparecerían de la planilla sin aviso.
  const activasSur = (await pglite.query(
    `SELECT COUNT(*)::int AS n FROM registrations
     WHERE tournament_id = ${zonaSur} AND COALESCE(status,'') <> 'cancelled'`)).rows[0].n;
  check('La planilla trae TODAS las inscripciones activas del torneo',
    filas.length === activasSur, `${filas.length} de ${activasSur}`);

  // Ningún club puede quedar afuera, tengan tildes o eñes en el nombre
  const clubesEnBase = (await pglite.query(
    `SELECT DISTINCT cl.name FROM registrations r JOIN clubs cl ON cl.id = r.club_id
     WHERE r.tournament_id = ${zonaSur} AND COALESCE(r.status,'') <> 'cancelled'
     ORDER BY 1`)).rows.map(r => r.name);
  const clubesEnPlanilla = [...new Set(filas.map(f => f.club))].sort();
  check('Ningún club se pierde en la exportación',
    clubesEnBase.length === clubesEnPlanilla.length &&
    clubesEnBase.every(c => clubesEnPlanilla.includes(c)),
    'faltan: ' + clubesEnBase.filter(c => !clubesEnPlanilla.includes(c)).join(', '));

  // Un club con tilde y eñe tiene que viajar igual que cualquier otro
  await pglite.query(`INSERT INTO clubs (id, name) VALUES (9901, 'ATLÉTICO ÑANDÚ')
    ON CONFLICT (id) DO NOTHING`);
  const catPrueba = (await pglite.query(
    `SELECT id FROM categories WHERE tournament_id = ${zonaSur} LIMIT 1`)).rows[0];
  await pglite.query(`INSERT INTO registrations
    (tournament_id, category_id, student_id, club_id, teacher_id, status, age)
    VALUES (${zonaSur}, ${catPrueba.id}, 2, 9901, 2, 'registered', 12)`);

  const conTilde = await insc.fetchForGroupedSheet(zonaSur);
  check('Un club con tilde y eñe sale en la planilla',
    conTilde.some(f => f.club === 'ATLÉTICO ÑANDÚ'),
    [...new Set(conTilde.map(f => f.club))].join(' | '));
  check('Y al sumarlo no se pierde ninguna de las anteriores',
    conTilde.length === filas.length + 1, `${conTilde.length} vs ${filas.length + 1}`);

  await pglite.query(`DELETE FROM registrations WHERE club_id = 9901`);

  const bufPista = Buffer.from(await insc.buildXlsxLibroMayor(filas,
    { name: 'ZONA SUR', datesLabel: '6 DE SEPTIEMBRE', venue: 'INSTITUTO ESTRADA' }));
  const libroPista = new ExcelJS.Workbook();
  await libroPista.xlsx.load(bufPista);
  const hojaPista = libroPista.getWorksheet('Libro Mayor');

  // Columnas de la plantilla: A horario · B apellido · C nombre · D edad
  // E institucion · F salida a pista · G/H/I los tres jueces
  let encPista = null;
  const salidas = [];
  const edadesLibro = [];
  let horarioVacio = true;
  let jueces = null;

  hojaPista.eachRow((fila, n) => {
    if (String(fila.getCell(2).value || '') !== 'Apellido') return;

    if (!encPista) {
      encPista = [2, 3, 4, 5].map(c => String(fila.getCell(c).value || ''));
      jueces = [7, 8, 9].map(c => String(fila.getCell(c).value || ''));
      // Edades del primer bloque. Cada patinadora ocupa dos renglones, asi que
      // se avanza de a dos; se corta al llegar a la franja del bloque siguiente.
      for (let r = n + 1; r <= hojaPista.rowCount; r += 2) {
        const v = Number(hojaPista.getRow(r).getCell(4).value);
        if (!Number.isFinite(v)) break;
        edadesLibro.push(v);
      }
    }

    // La salida a pista va sin numerar: la define la organizacion
    const primera = hojaPista.getRow(n + 1).getCell(6).value;
    salidas.push(primera === null || primera === undefined || primera === '');

    // El horario queda vacio: no hay horarios cargados en el sistema
    const h = fila.getCell(1).value;
    if (h !== null && h !== undefined && h !== '') horarioVacio = false;
  });

  check('El Libro Mayor usa las columnas de la plantilla',
    JSON.stringify(encPista) === JSON.stringify(['Apellido', 'Nombre', 'Edad', 'Institución']),
    JSON.stringify(encPista));
  check('Y las tres columnas de jueces para puntuar a mano',
    JSON.stringify(jueces) === JSON.stringify(['JUEZ 1', 'JUEZ 2', 'JUEZ 3']),
    JSON.stringify(jueces));
  check('La columna de edad viene cargada y ordenada de menor a mayor',
    edadesLibro.length > 0 && edadesLibro.every((v, i) => i === 0 || edadesLibro[i - 1] <= v),
    JSON.stringify(edadesLibro.slice(0, 10)));
  check('La columna de salida a pista queda sin numerar',
    salidas.length > 0 && salidas.every(v => v === true), JSON.stringify(salidas.slice(0, 8)));
  check('La columna de horario queda vacía: no hay horarios cargados', horarioVacio);

  // Formato de la plantilla: titulo amarillo, franja violeta, celda celeste
  const titulo = hojaPista.getCell(1, 1);
  check('El título va sobre fondo amarillo, como en la plantilla',
    titulo.fill && titulo.fill.fgColor && titulo.fill.fgColor.argb === 'FFFFFF00',
    JSON.stringify(titulo.fill));
  check('El título dice el torneo y la fecha',
    String(titulo.value).includes('ZONA SUR') && String(titulo.value).includes('SEPTIEMBRE'),
    String(titulo.value));

  const franja = hojaPista.getCell(2, 2);
  check('La franja del bloque va violeta con el nombre completo del bloque',
    franja.fill && franja.fill.fgColor && franja.fill.fgColor.argb === 'FF7030A0' &&
    String(franja.value).length > 0,
    JSON.stringify({ fill: franja.fill && franja.fill.fgColor, valor: franja.value }));
  check('La celda del horario va celeste',
    hojaPista.getCell(3, 1).fill.fgColor.argb === 'FF00B0F0',
    JSON.stringify(hojaPista.getCell(3, 1).fill));
  check('Cada patinadora ocupa dos renglones, como en la plantilla',
    hojaPista.getCell(4, 2).isMerged && hojaPista.getCell(5, 2).master.address === 'B4',
    JSON.stringify({ merged: hojaPista.getCell(4, 2).isMerged }));
  check('El ancho de las columnas es el de la plantilla',
    hojaPista.getColumn(2).width === 62.9 && hojaPista.getColumn(5).width === 67.3,
    JSON.stringify([hojaPista.getColumn(2).width, hojaPista.getColumn(5).width]));

  const scopeAjeno = await get(PROFE_ADMIN, `/admin/exportar/planilla?tournament_id=${zonaSur}`, false);
  check('Giselle no puede bajar la planilla de un torneo de otra zona',
    scopeAjeno.status === 302 && decodeURIComponent(scopeAjeno.headers.location || '').includes('fuera de tu alcance'),
    `status ${scopeAjeno.status}`);







  // --- Apellido y Nombre en columnas separadas ---
  const tablaProfe = await get(PROFE, '/profesor/dashboard');
  check('La tabla de la profesora separa Apellido y Nombre',
    tablaProfe.text.includes('<th>Apellido</th>') && tablaProfe.text.includes('<th>Nombre</th>') &&
    !tablaProfe.text.includes('<th>Alumna</th>'));

  const tablaAdmin = await get(ADMIN, '/admin/inscripciones');
  check('La tabla del administrador también los separa',
    tablaAdmin.text.includes('<th>Apellido</th>') && tablaAdmin.text.includes('<th>Nombre</th>') &&
    !tablaAdmin.text.includes('<th>Nombre y Apellido</th>'));

  const cuentaColumnas = (html) => {
    const thead = (html.match(/<thead>[\s\S]*?<\/thead>/) || [''])[0];
    return (thead.match(/<th[\s>]/g) || []).length;
  };
  check('El encabezado del administrador suma una columna, no dos',
    cuentaColumnas(tablaAdmin.text) === 15, String(cuentaColumnas(tablaAdmin.text)));
  // Lo que importa es que ninguna fila se desalinee: contando los colspan,
  // cada fila tiene que dar las mismas columnas que el encabezado.
  const filasAdmin = (tablaAdmin.text.match(/<tr>[\s\S]*?<\/tr>/g) || [])
    .filter(f => f.includes('<td'));
  const anchoDeFila = (f) => (f.match(/<td[^>]*>/g) || [])
    .reduce((n, td) => {
      const m = td.match(/colspan="(\d+)"/);
      return n + (m ? Number(m[1]) : 1);
    }, 0);
  check('Ninguna fila queda desalineada con el encabezado',
    filasAdmin.length > 0 && filasAdmin.every(f => anchoDeFila(f) === 15),
    JSON.stringify(filasAdmin.map(anchoDeFila).slice(0, 6)));

  const formInsc = await get(PROFE, '/profesor/inscribir');
  check('Al inscribir, la alumna se elige por Apellido, Nombre',
    formInsc.text.includes("s.last_name + ', ' + s.first_name"));

  // --- Apellido y Nombre: campos separados, sin adivinar ---
  const formAlta = await get(PROFE, '/profesor/alumnos/nuevo');
  check('El alta de alumna pide Apellido y Nombre por separado',
    formAlta.text.includes('name="last_name"') && formAlta.text.includes('name="first_name"'));
  check('Ya no hay un campo único que el sistema tenga que partir',
    !formAlta.text.includes('name="full_name"'));

  // Se guardan tal cual, cada uno en su casillero
  SESSION = PROFE;
  await request(app).post('/profesor/alumnos/nuevo').send({
    last_name: 'moreira', first_name: 'aylin jazmín',
    dni: '99000111', birth_date: '2015-03-02',
    health_insurance: 'OSDE', policy_number: '123', club_id: '1'
  });
  const cargada = (await pglite.query(
    `SELECT last_name, first_name FROM students WHERE dni = '99000111'`)).rows[0];
  check('El apellido queda en apellido y el nombre en nombre',
    cargada && cargada.last_name === 'MOREIRA' && cargada.first_name === 'AYLIN JAZMÍN',
    JSON.stringify(cargada));

  // Un nombre compuesto ya no se parte por el primer espacio
  await request(app).post('/profesor/alumnos/nuevo').send({
    last_name: 'PARRA RAMIREZ', first_name: 'KENDRA',
    dni: '99000222', birth_date: '2014-01-10',
    health_insurance: 'OSDE', policy_number: '123', club_id: '1'
  });
  const compuesto = (await pglite.query(
    `SELECT last_name, first_name FROM students WHERE dni = '99000222'`)).rows[0];
  check('Un apellido de dos palabras se respeta entero',
    compuesto && compuesto.last_name === 'PARRA RAMIREZ' && compuesto.first_name === 'KENDRA',
    JSON.stringify(compuesto));

  // Los dos son obligatorios: sin apellido no se guarda
  const antesSinApellido = (await pglite.query(`SELECT COUNT(*)::int AS n FROM students`)).rows[0].n;
  await request(app).post('/profesor/alumnos/nuevo').send({
    first_name: 'SOLO NOMBRE', dni: '99000333', birth_date: '2014-01-10',
    health_insurance: 'OSDE', policy_number: '123', club_id: '1'
  });
  check('Sin apellido no se carga la alumna',
    (await pglite.query(`SELECT COUNT(*)::int AS n FROM students`)).rows[0].n === antesSinApellido);

  await pglite.query(`DELETE FROM students WHERE dni IN ('99000111','99000222','99000333')`);

  // --- DNI repetido: el aviso tiene que decir quién lo tiene ---
  const errDb = require('../lib/errores_db');
  const yaCargada = (await pglite.query(
    `SELECT dni, first_name, last_name FROM students WHERE dni IS NOT NULL LIMIT 1`)).rows[0];

  // El error de PostgreSQL no dice "UNIQUE constraint failed" (eso era SQLite):
  // llega con code 23505. El chequeo viejo nunca daba verdadero.
  check('Se reconoce el duplicado por el código de PostgreSQL',
    errDb.esDuplicado({ code: '23505' }) === true &&
    errDb.esDuplicado({ message: 'duplicate key value violates unique constraint "students_dni_key"' }) === true &&
    errDb.esDuplicado({ message: 'otra cosa' }) === false);
  check('Se distingue qué campo se repitió',
    errDb.campoDuplicado({ constraint: 'students_dni_key' }) === 'dni' &&
    errDb.campoDuplicado({ constraint: 'students_cuil_key' }) === 'cuil');

  const avisoDni = await errDb.mensajeDniRepetido(yaCargada.dni);
  check('El aviso de DNI repetido nombra a la patinadora que ya está cargada',
    avisoDni.includes(yaCargada.dni) && avisoDni.includes(yaCargada.last_name),
    avisoDni);
  check('Y explica qué hacer', avisoDni.includes('administrador'));

  // De punta a punta: cargar una alumna con un DNI que ya existe
  SESSION = PROFE;
  const antesAlta = (await pglite.query(`SELECT COUNT(*)::int AS n FROM students`)).rows[0].n;
  const altaRepetida = await request(app).post('/profesor/alumnos/nuevo').send({
    full_name: 'PRUEBA REPETIDA',
    dni: yaCargada.dni,
    birth_date: '2016-06-14',
    health_insurance: 'OSEIV',
    policy_number: '60226/2',
    club_id: '1'
  });
  check('No se carga la alumna repetida',
    (await pglite.query(`SELECT COUNT(*)::int AS n FROM students`)).rows[0].n === antesAlta);
  check('Y la pantalla explica el motivo, no un error genérico',
    altaRepetida.text.includes('ya está cargado') &&
    !altaRepetida.text.includes('Error al registrar la patinadora'),
    altaRepetida.text.includes('Error al registrar') ? 'salio el mensaje generico' : 'sin mensaje');

  // --- Filtros y buscador de "Mis Inscripciones en Torneos" ---
  const misInsc = await get(PROFE, '/profesor/dashboard');
  const mi = misInsc.text;

  check('La tabla de inscripciones tiene buscador con lupa',
    mi.includes('id="fBuscar"') && mi.includes('🔍'));
  check('Hay un desplegable por cada columna de la inscripción',
    ['fTorneo', 'fDisciplina', 'fCategoria', 'fBanda', 'fEdad', 'fTipo', 'fClub']
      .every(id => mi.includes('id="' + id + '"')),
    ['fTorneo', 'fDisciplina', 'fCategoria', 'fBanda', 'fEdad', 'fTipo', 'fClub']
      .filter(id => !mi.includes('id="' + id + '"')).join(', '));
  check('Se puede limpiar todo de una vez', mi.includes('id="fLimpiar"'));

  // Cada fila viaja con sus datos, que es lo que permite filtrar sin recargar
  const atributos = ['data-torneo', 'data-disciplina', 'data-categoria',
    'data-banda', 'data-edad', 'data-tipo', 'data-club', 'data-buscar'];
  check('Cada fila lleva los datos de su inscripción para poder filtrarla',
    atributos.every(a => mi.includes(a)),
    atributos.filter(a => !mi.includes(a)).join(', '));

  // El texto buscable tiene que venir en minúsculas y con los datos de la fila
  const buscables = [...mi.matchAll(/data-buscar="([^"]*)"/g)].map(m => m[1]);
  check('El texto buscable incluye alumna, club, torneo y categoría',
    buscables.length > 0 && buscables.every(b => b === b.toLowerCase() && b.length > 0),
    JSON.stringify(buscables.slice(0, 2)));


  // El aviso de confirmación va en una sola línea: un salto real dentro del
  // string rompe el onclick y el borrado se ejecutaría sin preguntar.
  const confirms = [...misInsc.text.matchAll(/onclick="return confirm\(([^)]*)\)/g)].map(m => m[1]);
  check('El confirm de eliminar no parte líneas',
    confirms.length > 0 && confirms.every(c => !c.includes(String.fromCharCode(10))),
    confirms.length + ' encontrados');

  // --- Editar inscripción: la disciplina manda sobre categoría y franja ---
  const regFree = (await pglite.query(`
    SELECT r.id FROM registrations r JOIN categories c ON c.id = r.category_id
    WHERE c.discipline = 'FREE DANCE' ORDER BY r.id LIMIT 1`)).rows[0];

  if (regFree) {
    const editar = await get(ADMIN, `/admin/inscripciones/${regFree.id}/editar`);
    const t = editar.text;

    check('El formulario de edición tiene desplegable de Disciplina',
      t.includes('id="discipline_select"'));
    check('La Disciplina va arriba de la Categoría',
      t.indexOf('id="discipline_select"') !== -1 &&
      t.indexOf('id="discipline_select"') < t.indexOf('id="category_id"'));
    check('Arranca con la disciplina que tiene la inscripción',
      /<option value="FREE DANCE" selected>/.test(t), 'no viene preseleccionada');

    // Las categorías viajan con su disciplina, para poder filtrarlas en pantalla
    const catsEditar = JSON.parse((t.match(/data-all-categories='([^']+)'/) || [])[1] || '[]');
    check('El formulario lleva las categorías de todas las disciplinas del torneo',
      new Set(catsEditar.map(c => c.discipline)).size > 1,
      [...new Set(catsEditar.map(c => c.discipline))].join(', '));
    check('Cada categoría viaja con su disciplina y su reglamento',
      catsEditar.every(c => 'discipline' in c && 'ruleset' in c));
    check('La categoría actual viaja para poder preseleccionarla',
      /data-actual="\d+"/.test(t));

    // Las franjas de edad van por disciplina: FREE DANCE tiene, LIBRE no
    const bandasEditar = JSON.parse(
      (t.match(/const EDIT_AGE_BANDS = ([^;]+);/) || [])[1] || '{}');
    check('Las franjas de edad llegan agrupadas por disciplina',
      Array.isArray(bandasEditar['FREE DANCE']) && bandasEditar['FREE DANCE'].length > 0,
      Object.keys(bandasEditar).join(', '));
    check('LIBRE no ofrece franjas de edad',
      !bandasEditar['LIBRE'] || bandasEditar['LIBRE'].length === 0);

    // Y la profesora ve exactamente lo mismo
    const propiaEdit = (await pglite.query(
      `SELECT id FROM registrations WHERE teacher_id = 2 ORDER BY id LIMIT 1`)).rows[0];
    if (propiaEdit) {
      const editProfe = await get(PROFE, `/profesor/inscripciones/${propiaEdit.id}/editar`);
      check('La profesora también tiene el desplegable de Disciplina',
        editProfe.text.includes('id="discipline_select"') &&
        editProfe.text.includes('data-all-categories'));
    }
  }

  // --- Eliminar inscripciones (profesora y administrador) ---
  const totalReg = async () => (await pglite.query(`SELECT COUNT(*)::int AS n FROM registrations`)).rows[0].n;
  const enPapelera = async () => (await pglite.query(`SELECT COUNT(*)::int AS n FROM registrations_eliminadas`)).rows[0].n;

  // Una inscripción de la profesora (teacher_id = 2)
  const propia = (await pglite.query(
    `SELECT id FROM registrations WHERE teacher_id = 2 ORDER BY id DESC LIMIT 1`)).rows[0];
  const ajena = (await pglite.query(
    `SELECT id FROM registrations WHERE teacher_id <> 2 ORDER BY id LIMIT 1`)).rows[0];

  const antesBorrar = await totalReg();

  // La profesora NO puede borrar una inscripción de otra
  if (ajena) {
    SESSION = PROFE;
    const noAjena = await request(app).post(`/profesor/inscripciones/${ajena.id}/eliminar`).send({});
    check('La profesora no puede eliminar inscripciones de otra',
      noAjena.status === 404 && (await totalReg()) === antesBorrar, `status ${noAjena.status}`);
  }

  // La profesora SÍ puede borrar la suya
  SESSION = PROFE;
  const borrado = await request(app).post(`/profesor/inscripciones/${propia.id}/eliminar`).send({});
  check('La profesora elimina una inscripción propia',
    (await totalReg()) === antesBorrar - 1, `${await totalReg()} de ${antesBorrar}`);
  check('Y el sistema lo confirma en pantalla',
    decodeURIComponent(borrado.headers.location || '').includes('eliminada'),
    decodeURIComponent(borrado.headers.location || ''));

  check('La inscripción borrada queda guardada en la papelera', (await enPapelera()) === 1);
  const copia = (await pglite.query(
    `SELECT registration_id, student_name, tournament_name, category_name, deleted_by_name
     FROM registrations_eliminadas ORDER BY id DESC LIMIT 1`)).rows[0];
  check('La copia guarda qué era y quién la borró',
    Number(copia.registration_id) === Number(propia.id) &&
    !!copia.tournament_name && !!copia.category_name && copia.deleted_by_name === 'GISELLE',
    JSON.stringify(copia));

  check('Los integrantes de la inscripción se van con ella',
    (await pglite.query(
      `SELECT COUNT(*)::int AS n FROM registration_members WHERE registration_id = ${propia.id}`)).rows[0].n === 0);

  // Con puntajes cargados no se puede borrar: se perderían los resultados
  const conPuntaje = (await pglite.query(
    `SELECT id FROM registrations WHERE teacher_id = 2 ORDER BY id DESC LIMIT 1`)).rows[0];
  await pglite.query(
    `INSERT INTO scores (registration_id, judge_id, total_score) VALUES (${conPuntaje.id}, 1, 8.5)`);
  const antesPuntaje = await totalReg();
  const conScore = await request(app).post(`/profesor/inscripciones/${conPuntaje.id}/eliminar`).send({});
  check('No se puede eliminar una inscripción que ya tiene puntajes',
    (await totalReg()) === antesPuntaje &&
    decodeURIComponent(conScore.headers.location || '').includes('puntaje'),
    decodeURIComponent(conScore.headers.location || ''));
  await pglite.query(`DELETE FROM scores WHERE registration_id = ${conPuntaje.id}`);

  // El administrador puede borrar cualquiera de su alcance
  SESSION = ADMIN;
  const deOtra = (await pglite.query(
    `SELECT id FROM registrations WHERE teacher_id <> 2 ORDER BY id DESC LIMIT 1`)).rows[0];
  if (deOtra) {
    const antesAdmin = await totalReg();
    const borradoAdmin = await request(app).post(`/admin/inscripciones/${deOtra.id}/eliminar`).send({});
    check('El administrador elimina una inscripción de cualquier profesora',
      (await totalReg()) === antesAdmin - 1 &&
      decodeURIComponent(borradoAdmin.headers.location || '').includes('eliminada'),
      decodeURIComponent(borradoAdmin.headers.location || ''));
  }

  // Giselle (admin de CABA) no puede borrar inscripciones de otra zona
  const deZonaSur = (await pglite.query(
    `SELECT id FROM registrations WHERE tournament_id = ${zonaSur} ORDER BY id DESC LIMIT 1`)).rows[0];
  if (deZonaSur) {
    SESSION = PROFE_ADMIN;
    const antesScope = await totalReg();
    const fuera = await request(app).post(`/admin/inscripciones/${deZonaSur.id}/eliminar`).send({});
    check('Un administrador de zona no borra inscripciones de otra zona',
      (await totalReg()) === antesScope &&
      decodeURIComponent(fuera.headers.location || '').includes('fuera de tu alcance'),
      decodeURIComponent(fuera.headers.location || ''));
  }

  // Borrar algo que ya no existe avisa, no rompe
  SESSION = ADMIN;
  const inexistente = await request(app).post('/admin/inscripciones/999999/eliminar').send({});
  check('Eliminar algo que ya no existe avisa en vez de romper',
    inexistente.status === 302 &&
    decodeURIComponent(inexistente.headers.location || '').includes('no existe'),
    `status ${inexistente.status}`);

  // Los botones tienen que estar en las pantallas
  const dashProfe = await get(PROFE, '/profesor/dashboard');
  check('La profesora ve el botón de eliminar en su panel',
    /\/profesor\/inscripciones\/\d+\/eliminar/.test(dashProfe.text));
  const listaAdmin = await get(ADMIN, '/admin/inscripciones');
  check('El administrador ve el botón de eliminar en el listado',
    /\/admin\/inscripciones\/\d+\/eliminar/.test(listaAdmin.text));



  // --- Borrado de usuarios: sin dejar el sistema sin administracion ---
  SESSION = ADMIN;
  const contarUsuarios = async () => (await pglite.query(`SELECT COUNT(*)::int AS n FROM users`)).rows[0].n;

  // Un usuario suelto, sin alumnas ni inscripciones, se borra
  await pglite.query(`INSERT INTO users (id, username, password_hash, full_name, role, club_id)
    VALUES (9801, 'suelto', 'x', 'USUARIO SUELTO', 'profesor', 1) ON CONFLICT (id) DO NOTHING`);
  const antesSuelto = await contarUsuarios();
  const borroSuelto = await request(app).post('/admin/usuarios/9801/eliminar').send({});
  check('Un usuario sin datos se puede eliminar',
    (await contarUsuarios()) === antesSuelto - 1 &&
    decodeURIComponent(borroSuelto.headers.location || '').includes('eliminado'),
    decodeURIComponent(borroSuelto.headers.location || ''));

  // Una profesora con alumnas NO se borra: se las llevaria en cascada
  const conPadron = (await pglite.query(
    `SELECT teacher_id FROM students GROUP BY teacher_id ORDER BY COUNT(*) DESC LIMIT 1`)).rows[0];
  const alumnasAntes = (await pglite.query(
    `SELECT COUNT(*)::int AS n FROM students WHERE teacher_id = ${conPadron.teacher_id}`)).rows[0].n;
  const bloqueado = await request(app).post(`/admin/usuarios/${conPadron.teacher_id}/eliminar`).send({});
  check('No se borra una profesora que tiene padrón cargado',
    (await pglite.query(`SELECT COUNT(*)::int AS n FROM students WHERE teacher_id = ${conPadron.teacher_id}`)).rows[0].n === alumnasAntes &&
    decodeURIComponent(bloqueado.headers.location || '').includes('patinadora'),
    decodeURIComponent(bloqueado.headers.location || ''));

  // El administrador general se puede borrar SI queda otro sin restriccion de zona
  await pglite.query(`INSERT INTO users (id, username, password_hash, full_name, role, club_id, admin_scope)
    VALUES (9802, 'otroadmin', 'x', 'OTRO ADMIN', 'profesor_admin', 1, NULL) ON CONFLICT (id) DO NOTHING`);
  await pglite.query(`INSERT INTO users (id, username, password_hash, full_name, role, club_id)
    VALUES (9803, 'adminviejo', 'x', 'ADMIN VIEJO', 'admin', 1) ON CONFLICT (id) DO NOTHING`);
  const borroAdmin = await request(app).post('/admin/usuarios/9803/eliminar').send({});
  check('Se puede borrar un admin si queda otro administrador general',
    (await pglite.query(`SELECT COUNT(*)::int AS n FROM users WHERE id = 9803`)).rows[0].n === 0,
    decodeURIComponent(borroAdmin.headers.location || ''));

  // Pero no si es el ultimo administrador general (los de zona no cuentan)
  await pglite.query(`UPDATE users SET admin_scope = 'CABA' WHERE id = 9802`);
  await pglite.query(`UPDATE users SET admin_scope = 'CABA' WHERE role IN ('admin','profesor_admin') AND id NOT IN (1, 9802)`);
  await pglite.query(`INSERT INTO users (id, username, password_hash, full_name, role, club_id)
    VALUES (9804, 'ultimo', 'x', 'ULTIMO ADMIN', 'admin', 1) ON CONFLICT (id) DO NOTHING`);
  await pglite.query(`UPDATE users SET admin_scope = 'CABA' WHERE id = 1`);
  const ultimo = await request(app).post('/admin/usuarios/9804/eliminar').send({});
  check('No se borra al último administrador general',
    (await pglite.query(`SELECT COUNT(*)::int AS n FROM users WHERE id = 9804`)).rows[0].n === 1 &&
    decodeURIComponent(ultimo.headers.location || '').includes('último administrador'),
    decodeURIComponent(ultimo.headers.location || ''));

  // Se deja todo como estaba para no ensuciar las pruebas siguientes
  await pglite.query(`DELETE FROM users WHERE id IN (9802, 9804)`);
  await pglite.query(`UPDATE users SET admin_scope = NULL WHERE id = 1`);
  await pglite.query(`UPDATE users SET admin_scope = NULL WHERE username <> 'gisellelorenaalarcon@hotmail.com' AND role IN ('admin','profesor_admin')`);

  // --- Módulo de clubes: listado a pantalla completa, alta por botón ---
  const clubesAdmin = await get(ADMIN, '/admin/clubes');
  check('El listado de clubes ya no comparte la fila con el formulario',
    !clubesAdmin.text.includes('grid-template-columns: repeat(auto-fit, minmax(320px, 1fr))'));
  check('Hay un botón para dar de alta un club',
    clubesAdmin.text.includes('onclick="toggleNewClubForm()"') &&
    clubesAdmin.text.includes('Nuevo Club'));
  check('El formulario arranca oculto',
    /id="newClubFormCard"[\s\S]{0,200}display: none/.test(clubesAdmin.text));
  check('El listado muestra las columnas del padrón de clubes',
    ['Club', 'Ciudad', 'Representante', 'Teléfono', 'Profesores', 'Alumnas']
      .every(h => clubesAdmin.text.includes('<th>' + h + '</th>')));

  // Si el alta falla, el formulario tiene que quedar abierto con el aviso
  const clubesConError = await request(app).get('/admin/clubes?error=' + encodeURIComponent('Falló'));
  check('Ante un error el formulario se abre solo',
    /id="newClubFormCard"[\s\S]{0,200}display: block/.test(clubesConError.text));

  // Un club repetido se avisa por nombre, no con un error genérico
  const nombreClub = (await pglite.query(`SELECT name FROM clubs LIMIT 1`)).rows[0].name;
  const clubRepetido = await request(app).post('/admin/clubes').send({ name: nombreClub });
  check('Un club con nombre repetido lo dice',
    decodeURIComponent(clubRepetido.headers.location || '').includes('Ya hay un club registrado'),
    decodeURIComponent(clubRepetido.headers.location || ''));

  // Giselle (admin de zona) también entra a clubes
  await get(PROFE_ADMIN, '/admin/clubes');



  // --- Usuarios: lista en vez de tarjetas ---
  const listaUsuarios = await get(ADMIN, '/admin/usuarios');
  check('Los usuarios ya no se muestran como tarjetas',
    !listaUsuarios.text.includes('admin-user-card') &&
    !listaUsuarios.text.includes('admin-user-grid'));
  check('Se muestran en una tabla con sus columnas',
    ['Usuario', 'Rol y alcance', 'Club', 'Contacto', 'Estado', 'Acciones']
      .every(h => listaUsuarios.text.includes('<th>' + h + '</th>')),
    ['Usuario', 'Rol y alcance', 'Club', 'Contacto', 'Estado', 'Acciones']
      .filter(h => !listaUsuarios.text.includes('<th>' + h + '</th>')).join(', '));

  // Las acciones que estaban en la tarjeta tienen que seguir estando
  check('Cada fila conserva el cambio de rol y alcance',
    /action="\/admin\/usuarios\/\d+\/rol"/.test(listaUsuarios.text) &&
    listaUsuarios.text.includes('name="admin_scope"'));
  // Sin regex: se arma la ruta con un id real y se busca tal cual.
  const idOtro = (await pglite.query(`SELECT id FROM users WHERE id <> 1 ORDER BY id LIMIT 1`)).rows[0].id;
  check('Se conservan restablecer y eliminar en cada fila',
    listaUsuarios.text.includes('/admin/usuarios/' + idOtro + '/restablecer') &&
    listaUsuarios.text.includes('/admin/usuarios/' + idOtro + '/eliminar'));

  // Verificar y reenviar solo tienen sentido con el email sin confirmar,
  // asi que se marca uno como pendiente para comprobar que aparecen.
  await pglite.query(`UPDATE users SET email_verified = false WHERE id = 2`);
  const conPendiente = await get(ADMIN, '/admin/usuarios');
  check('Con un email pendiente aparecen verificar y reenviar',
    conPendiente.text.includes('/verificar') &&
    conPendiente.text.includes('/reenviar-verificacion') &&
    conPendiente.text.includes('Pendiente'));
  await pglite.query(`UPDATE users SET email_verified = true WHERE id = 2`);

  check('La lista tiene buscador y filtros por rol y club',
    ['uBuscar', 'uRol', 'uClub', 'uLimpiar'].every(id => listaUsuarios.text.includes('id="' + id + '"')));
  check('Cada usuario viaja con sus datos para poder filtrarlo',
    ['data-rol', 'data-club', 'data-buscar'].every(a => listaUsuarios.text.includes(a)));

  // El aviso de borrado no puede partir lineas: rompe el onsubmit
  const confirmsUsuarios = [...listaUsuarios.text.matchAll(/onsubmit="return confirm\(([^)]*)\)/g)].map(m => m[1]);
  check('El confirm de eliminar usuario no parte líneas',
    confirmsUsuarios.length > 0 && confirmsUsuarios.every(c => !c.includes(String.fromCharCode(10))),
    confirmsUsuarios.length + ' encontrados');

  // --- Clubes: buscador, filtros y ficha del club ---
  const listaClubes = await get(ADMIN, '/admin/clubes');
  check('El listado de clubes tiene buscador con lupa',
    listaClubes.text.includes('id="cBuscar"'));
  check('Tiene filtros por ciudad y por actividad',
    listaClubes.text.includes('id="cCiudad"') && listaClubes.text.includes('id="cActividad"') &&
    listaClubes.text.includes('id="cLimpiar"'));
  check('Cada club viaja con sus datos para poder filtrarlo',
    ['data-ciudad', 'data-actividad', 'data-buscar'].every(a => listaClubes.text.includes(a)));
  check('Cada club enlaza a su ficha',
    /href="\/admin\/clubes\/\d+"/.test(listaClubes.text));

  const clubConDatos = (await pglite.query(`
    SELECT c.id FROM clubs c
    WHERE EXISTS (SELECT 1 FROM registrations r WHERE r.club_id = c.id)
    LIMIT 1`)).rows[0];

  if (clubConDatos) {
    const ficha = await get(ADMIN, `/admin/clubes/${clubConDatos.id}`);
    check('La ficha muestra profesoras, patinadoras e inscripciones',
      ['Profesoras del Club', 'Patinadoras del Club', 'Inscripciones del Club']
        .every(t => ficha.text.includes(t)));
    check('La ficha desglosa las inscripciones por torneo',
      ficha.text.includes('Inscripciones por Torneo'));

    // Los totales de la ficha tienen que coincidir con la base
    const esperado = (await pglite.query(`
      SELECT
        (SELECT COUNT(*)::int FROM students WHERE club_id = ${clubConDatos.id}) AS alumnas,
        (SELECT COUNT(*)::int FROM registrations WHERE club_id = ${clubConDatos.id}) AS inscripciones`)).rows[0];
    const valores = [...ficha.text.matchAll(/class="admin-stat-val">(\d+)</g)].map(m => Number(m[1]));
    check('Los totales de la ficha coinciden con la base',
      valores.length === 3 && valores[1] === esperado.alumnas && valores[2] === esperado.inscripciones,
      `ficha ${JSON.stringify(valores)} vs base ${JSON.stringify(esperado)}`);

    // La edad se deduce de la ficha cuando la inscripcion no la tiene guardada
    const sinEdad = (await pglite.query(`
      SELECT r.id FROM registrations r JOIN students s ON s.id = r.student_id
      WHERE r.club_id = ${clubConDatos.id} AND s.birth_date IS NOT NULL LIMIT 1`)).rows[0];
    if (sinEdad) {
      await pglite.query(`UPDATE registrations SET age = NULL WHERE id = ${sinEdad.id}`);
      const fichaSinEdad = await get(ADMIN, `/admin/clubes/${clubConDatos.id}`);
      // Solo la tabla de inscripciones: el resto de la ficha usa guiones
      // legitimamente (email o telefono vacios de una profesora, por ejemplo).
      const tablaInsc = fichaSinEdad.text.slice(fichaSinEdad.text.indexOf('Inscripciones del Club'));
      const conEdad = (tablaInsc.match(/<td>\d+ años<\/td>/g) || []).length;
      const sinEdadEnPantalla = (tablaInsc.match(/<td>-<\/td>/g) || []).length;
      check('La ficha deduce la edad de la fecha de nacimiento',
        conEdad > 0 && sinEdadEnPantalla === 0,
        `${conEdad} con edad, ${sinEdadEnPantalla} vacías`);
    }

    // Se distingue "no aplica" de "sin asignar" segun la disciplina use franjas
    const fichaBandas = await get(ADMIN, `/admin/clubes/${clubConDatos.id}`);
    const usaFranjas = (await pglite.query(`
      SELECT COUNT(*)::int AS n FROM registrations r
      JOIN categories c ON c.id = r.category_id
      WHERE r.club_id = ${clubConDatos.id} AND COALESCE(r.age_band,'') = ''
        AND NOT EXISTS (SELECT 1 FROM tournament_age_bands b
          WHERE b.tournament_id = r.tournament_id AND b.discipline = c.discipline)`)).rows[0].n;
    check('Las disciplinas sin franjas dicen "No aplica", no un guion suelto',
      usaFranjas === 0 || fichaBandas.text.includes('No aplica'),
      `${usaFranjas} inscripciones de disciplinas sin franjas`);

  }

  // Un club inexistente avisa en vez de romper
  const fichaFantasma = await request(app).get('/admin/clubes/999999');
  check('Un club inexistente devuelve aviso, no error del servidor',
    fichaFantasma.status === 404, `status ${fichaFantasma.status}`);

  // El profesor/administrador también puede ver la ficha
  await get(PROFE_ADMIN, `/admin/clubes/${clubConDatos ? clubConDatos.id : 1}`);

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
