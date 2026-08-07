const express = require('express');
const router = express.Router();
const db = require('../database');
const { formatEventDates, formatDeadline } = require('../lib/dates');

// Helper to get CMS setting by key
async function getSetting(key, fallback = '') {
  try {
    const row = await db.prepare(`SELECT value FROM site_settings WHERE key = ?`).get(key);
    return row ? row.value : fallback;
  } catch (e) {
    return fallback;
  }
}

// Home / Landing Page
router.get('/', async (req, res) => {
  const upcomingTournaments = await db.prepare(`
    SELECT * FROM tournaments
    ORDER BY COALESCE(date_from, event_date) ASC LIMIT 3
  `).all();
  upcomingTournaments.forEach(t => { t.datesLabel = formatEventDates(t.date_from || t.event_date, t.date_to); t.deadlineLabel = formatDeadline(t.registration_deadline); });

  const cms = {
    hero_title: await getSetting('hero_title', 'Liga Star Dance · Patín Artístico'),
    hero_subtitle: await getSetting('hero_subtitle', 'Plataforma oficial de gestión de torneos, cuerpo de jueces e inscripciones.'),
    about_title: await getSetting('about_title', 'SOBRE LA LIGA STAR DANCE Y NUESTRO PROPÓSITO'),
    about_content: await getSetting('about_content', 'La Liga Star Dance nace con el propósito de promover y profesionalizar el Patinaje Artístico sobre ruedas.'),
    slides: (await db.prepare(`SELECT * FROM home_slides WHERE is_active = true ORDER BY order_index ASC`).all()).map(s => {
      if (s.button_link && /\/jueces/.test(s.button_link)) s.button_link = '/torneos';
      return s;
    }),
    disciplines: await db.prepare(`SELECT * FROM discipline_info ORDER BY order_index ASC`).all()
  };

  res.render('public/index', {
    user: req.session.user || null,
    tournaments: upcomingTournaments,
    cms
  });
});

// Public Tournaments List
router.get('/torneos', async (req, res) => {
  const tournaments = await db.prepare(`
    SELECT t.*,
    (SELECT COUNT(*) FROM categories c WHERE c.tournament_id = t.id) as total_categories,
    (SELECT COUNT(*) FROM registrations r WHERE r.tournament_id = t.id) as total_registered
    FROM tournaments t
    ORDER BY t.event_date DESC
  `).all();
  tournaments.forEach(t => { t.datesLabel = formatEventDates(t.date_from || t.event_date, t.date_to); t.deadlineLabel = formatDeadline(t.registration_deadline); });

  res.render('public/torneos', {
    user: req.session.user || null,
    tournaments
  });
});

// Tournament Detail
router.get('/torneos/:id', async (req, res) => {
  const tournamentId = req.params.id;
  const tournament = await db.prepare(`SELECT * FROM tournaments WHERE id = ?`).get(tournamentId);

  if (!tournament) {
    return res.status(404).render('error', { title: 'Torneo No Encontrado', message: 'El torneo solicitado no existe.' });
  }

  tournament.datesLabel = formatEventDates(tournament.date_from || tournament.event_date, tournament.date_to);
  tournament.deadlineLabel = formatDeadline(tournament.registration_deadline);

  const categories = await db.prepare(`SELECT * FROM categories WHERE tournament_id = ? ORDER BY min_age ASC, division ASC`).all(tournamentId);
  const totalRegistrations = (await db.prepare(`SELECT COUNT(*) as count FROM registrations WHERE tournament_id = ?`).get(tournamentId)).count;

  res.render('public/torneo_detail', {
    user: req.session.user || null,
    tournament,
    categories,
    totalRegistrations
  });
});

module.exports = router;
