const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'star-dance-secret-key-2026-liga-patin';

// Red de seguridad: un error no capturado (p. ej. un handler async que rechaza)
// no debe tumbar el proceso entero; eso causaba 502 y pérdida de todas las sesiones.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// Trust Railway/Heroku-style proxy headers so req.protocol is https behind TLS
app.set('trust proxy', 1);

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Helpers disponibles en todas las vistas EJS
app.locals.formatCategoryName = require('./lib/categories').formatCategoryName;

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Body parsing
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Session config
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { 
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    secure: process.env.NODE_ENV === 'production' && process.env.USE_HTTPS === 'true'
  }
}));

// Pass user session to all views
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

// Import routes
const indexRoutes = require('./routes/index');
const authRoutes = require('./routes/auth');
const profesorRoutes = require('./routes/profesor');
const adminRoutes = require('./routes/admin');
const juezRoutes = require('./routes/juez');

// Mount routes
app.use('/', indexRoutes);
app.use('/auth', authRoutes);
app.use('/profesor', profesorRoutes);
app.use('/admin', adminRoutes);
app.use('/juez', juezRoutes);

// 404 Handler
app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Página no encontrada (404)',
    message: 'La ruta especificada no existe en la plataforma de la Liga Star Dance.'
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled Error:', err);
  res.status(500).render('error', {
    title: 'Error del Servidor (500)',
    message: 'Ocurrió un error inesperado. Por favor intente más tarde.'
  });
});

db.initPromise.then(async () => {
  // Seed automático SOLO en base realmente vacía (sin usuarios), para que no
  // vuelva a crear torneos demo cuando una limpieza borra registraciones.
  const usersCount = await db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (!usersCount || Number(usersCount.count) === 0) {
    console.log('🌱 Base de datos vacía, ejecutando seed automático...');
    const seed = require('./seed');
    await seed();
  }

  // Elimina torneos demo y garantiza los torneos oficiales multifecha (idempotente)
  const { ensureOfficialTournaments } = require('./lib/ensure_official_tournaments');
  const torneosReport = await ensureOfficialTournaments();
  if (torneosReport.deleted > 0 || torneosReport.created > 0) {
    console.log(`🏆 Torneos oficiales asegurados: ${torneosReport.created} creado(s), ${torneosReport.deleted} demo eliminado(s).`);
  }

  // Habilitar categorías/disciplinas en todos los torneos (idempotente)
  const ensureAllTournamentsHaveCategories = require('./lib/ensure_categories');
  const catReport = await ensureAllTournamentsHaveCategories();
  if (catReport.copied.length > 0) {
    console.log(`🏷️ Categorías copiadas a ${catReport.copied.length} torneo(s) sin categorías: ${catReport.copied.map(t => `#${t.id} (${t.categories})`).join(', ')}`);
  }

  // Alinear catálogo de categorías/disciplinas con el Excel oficial (idempotente)
  const ensureCategoriesCatalog = require('./lib/ensure_categories_catalog');
  const catalogReport = await ensureCategoriesCatalog();
  const totalAdded = catalogReport.aligned.reduce((s, t) => s + t.added, 0);
  const totalRemoved = catalogReport.aligned.reduce((s, t) => s + t.removed, 0);
  if (totalAdded > 0 || totalRemoved > 0) {
    console.log(`📊 Catálogo alineado: +${totalAdded} / -${totalRemoved} categorías en ${catalogReport.tournaments} torneo(s).`);
  }

  app.listen(PORT, () => {
    console.log(`✨ Plataforma Liga Star Dance ejecutándose en puerto ${PORT}`);
  });
}).catch(err => {
  console.error('Error inicializando base de datos:', err);
  process.exit(1);
});
