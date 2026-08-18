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


  // --- Cuarta opción: planilla de orden de salida a pista ---
  const ordenPista = await request(app).get(
    `/admin/exportar/planilla?tournament_id=${zonaSur}&agrupar=orden_pista`);
  check('GET planilla de orden de pista responde un .xlsx',
    ordenPista.status === 200 &&
    /spreadsheetml/.test(ordenPista.headers['content-type'] || '') &&
    /filename="PLANILLA_.*_ORDEN_DE_PISTA\.xlsx"/.test(ordenPista.headers['content-disposition'] || ''),
    `status ${ordenPista.status} · ${ordenPista.headers['content-disposition']}`);

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

  const bufPista = Buffer.from(await insc.buildXlsxOrdenDePista(filas,
    { name: 'ZONA SUR', datesLabel: '6 DE SEPTIEMBRE', venue: 'INSTITUTO ESTRADA' }));
  const libroPista = new ExcelJS.Workbook();
  await libroPista.xlsx.load(bufPista);
  const hojaPista = libroPista.getWorksheet('Orden de Pista');

  let encPista = null;
  const salidas = [];
  let horarioVacio = true;
  hojaPista.eachRow((fila, n) => {
    if (String(fila.getCell(3).value || '') === 'Apellido') {
      if (!encPista) encPista = [3, 4, 5, 6].map(c => String(fila.getCell(c).value || ''));
      // La salida a pista va sin numerar: la define la organización
      const primera = hojaPista.getRow(n + 1).getCell(6).value;
      salidas.push(primera === null || primera === undefined || primera === '');
    }
    // Las filas 1 y 2 son el título, combinado de punta a punta: ExcelJS
    // devuelve el valor del maestro en toda la combinación, así que se saltean.
    if (n > 2) {
      const h = fila.getCell(2).value;
      if (h !== null && h !== undefined && h !== '') horarioVacio = false;
    }
  });

  check('Las columnas son Apellido, Nombre, Institución y Salida a pista',
    JSON.stringify(encPista) === JSON.stringify(['Apellido', 'Nombre', 'Institución', 'Salida a pista']),
    JSON.stringify(encPista));
  check('La columna de salida a pista queda sin numerar',
    salidas.length > 0 && salidas.every(v => v === true), JSON.stringify(salidas.slice(0, 8)));
  check('La columna de horario queda vacía: no hay horarios cargados', horarioVacio);

  // Apellido y nombre salen de los campos del padrón, sin recombinarlos
  const conAlumna = filas.find(f => !f.is_group && f.apellido && f.nombre_pila);
  check('Apellido y Nombre se toman tal cual están en el padrón',
    !!conAlumna && conAlumna.nombre === `${conAlumna.apellido} ${conAlumna.nombre_pila}`,
    conAlumna ? `${conAlumna.apellido} | ${conAlumna.nombre_pila}` : 'sin datos');

  const scopeAjeno = await get(PROFE_ADMIN, `/admin/exportar/planilla?tournament_id=${zonaSur}`, false);
  check('Giselle no puede bajar la planilla de un torneo de otra zona',
    scopeAjeno.status === 302 && decodeURIComponent(scopeAjeno.headers.location || '').includes('fuera de tu alcance'),
    `status ${scopeAjeno.status}`);




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
