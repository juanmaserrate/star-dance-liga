const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'star-dance-secret-key-2026-liga-patin';

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

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

app.listen(PORT, () => {
  console.log(`✨ Plataforma Liga Star Dance ejecutándose en puerto ${PORT}`);
});
