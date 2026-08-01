const express = require('express');
const router = express.Router();
const db = require('../database');

// Helper to get CMS setting by key
function getSetting(key, fallback = '') {
  try {
    const row = db.prepare(`SELECT value FROM site_settings WHERE key = ?`).get(key);
    return row ? row.value : fallback;
  } catch (e) {
    return fallback;
  }
}

// Home / Landing Page
router.get('/', (req, res) => {
  const upcomingTournaments = db.prepare(`
    SELECT * FROM tournaments 
    ORDER BY event_date ASC LIMIT 3
  `).all();

  const stats = {
    tournaments: db.prepare(`SELECT COUNT(*) as count FROM tournaments`).get().count,
    clubs: db.prepare(`SELECT COUNT(*) as count FROM clubs`).get().count,
    skaters: db.prepare(`SELECT COUNT(*) as count FROM students`).get().count
  };

  const cms = {
    hero_title: getSetting('hero_title', 'LIGA DE PATINAJE ARTÍSTICO STAR DANCE'),
    hero_subtitle: getSetting('hero_subtitle', 'Plataforma oficial de gestión de torneos, cuerpo de jueces e inscripciones.'),
    about_title: getSetting('about_title', 'SOBRE LA LIGA STAR DANCE Y NUESTRO PROPÓSITO'),
    about_content: getSetting('about_content', 'La Liga Star Dance nace con el propósito de promover y profesionalizar el Patinaje Artístico sobre ruedas.'),
    slides: db.prepare(`SELECT * FROM home_slides WHERE is_active = 1 ORDER BY order_index ASC`).all(),
    disciplines: db.prepare(`SELECT * FROM discipline_info ORDER BY order_index ASC`).all(),
    judges: db.prepare(`SELECT * FROM judge_profiles ORDER BY order_index ASC`).all()
  };

  res.render('public/index', {
    user: req.session.user || null,
    tournaments: upcomingTournaments,
    stats,
    cms
  });
});

// Public Tournaments List
router.get('/torneos', (req, res) => {
  const tournaments = db.prepare(`
    SELECT t.*, 
    (SELECT COUNT(*) FROM categories c WHERE c.tournament_id = t.id) as total_categories,
    (SELECT COUNT(*) FROM registrations r WHERE r.tournament_id = t.id) as total_registered
    FROM tournaments t
    ORDER BY t.event_date DESC
  `).all();

  res.render('public/torneos', {
    user: req.session.user || null,
    tournaments
  });
});

// Tournament Detail
router.get('/torneos/:id', (req, res) => {
  const tournamentId = req.params.id;
  const tournament = db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(tournamentId);

  if (!tournament) {
    return res.status(404).render('error', { title: 'Torneo No Encontrado', message: 'El torneo solicitado no existe.' });
  }

  const categories = db.prepare(`SELECT * FROM categories WHERE tournament_id = ? ORDER BY min_age ASC, division ASC`).all(tournamentId);
  const totalRegistrations = db.prepare(`SELECT COUNT(*) as count FROM registrations WHERE tournament_id = ?`).get(tournamentId).count;

  res.render('public/torneo_detail', {
    user: req.session.user || null,
    tournament,
    categories,
    totalRegistrations
  });
});

// Public Judges Panel Page
router.get('/jueces', (req, res) => {
  const judges = db.prepare(`SELECT * FROM judge_profiles ORDER BY order_index ASC`).all();

  res.render('public/jueces', {
    user: req.session.user || null,
    judges
  });
});

module.exports = router;
