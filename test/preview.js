// Levanta la app real en localhost:3100 contra el Postgres en proceso, con un
// usuario simulado, para revisar las pantallas en el navegador. No toca producción.
const { pglite } = require('./harness');

const USERS = {
  profe: { id: 2, username: 'giselle', full_name: 'GISELLE', role: 'profesor', club_id: 1, club_name: 'CIENCIA Y LABOR', admin_scope: null },
  admin: { id: 1, username: 'admin', full_name: 'ADMINISTRADOR STAR DANCE', role: 'admin', club_id: 1, club_name: 'CIENCIA Y LABOR', admin_scope: null },
  ambos: { id: 2, username: 'giselle', full_name: 'GISELLE', role: 'profesor_admin', club_id: 1, club_name: 'CIENCIA Y LABOR', admin_scope: 'CABA' }
};

async function main() {
  await require('./state').buildState(pglite);

  const db = require('../database');
  await db.initPromise;
  await require('../lib/ensure_official_tournaments').ensureOfficialTournaments();
  await require('../lib/ensure_categories')();
  await require('../lib/ensure_categories_catalog')();
  await require('../lib/tournament_config').seedAllTournaments();

  const express = require('express');
  const path = require('path');
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.locals.formatCategoryName = require('../lib/categories').formatCategoryName;
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  // Usuario simulado, elegible con ?como=profe|admin|ambos
  let current = 'profe';
  app.use((req, res, next) => {
    if (req.query.como && USERS[req.query.como]) current = req.query.como;
    req.session = { user: { ...USERS[current] } };
    res.locals.user = req.session.user;
    next();
  });

  app.use('/', require('../routes/index'));
  app.use('/profesor', require('../routes/profesor'));
  app.use('/admin', require('../routes/admin'));

  app.use((err, req, res, next) => {
    console.error('ERROR:', req.originalUrl, err);
    res.status(500).send('<pre>' + err.stack + '</pre>');
  });

  app.listen(3100, () => console.log('🔎 Vista previa de prueba en http://localhost:3100'));
}

main().catch(err => { console.error(err); process.exit(1); });
