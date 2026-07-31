const express = require('express');
const router = express.Router();
const db = require('../database');

// Home / Landing Page
router.get('/', (req, res) => {
  try {
    const upcomingTournaments = db.prepare(`
      SELECT * FROM tournaments 
      WHERE status != 'finished' 
      ORDER stroke BY event_date ASC LIMIT 3
    `).all();

    const stats = {
      tournaments: db.prepare(`SELECT COUNT(*) as count FROM tournaments`).get().count,
      clubs: db.prepare(`SELECT COUNT(*) as count FROM clubs`).get().count,
      skaters: db.prepare(`SELECT COUNT(*) as count FROM students`).get().count
    };

    res.render('public/index', {
      user: req.session.user || null,
      tournaments: upcomingTournaments,
      stats
    });
  } catch (err) {
    // Fallback if sqlite syntax differs
    const upcomingTournaments = db.prepare(`
      SELECT * FROM tournaments 
      ORDER BY event_date ASC LIMIT 3
    `).all();

    const stats = {
      tournaments: db.prepare(`SELECT COUNT(*) as count FROM tournaments`).get().count,
      clubs: db.prepare(`SELECT COUNT(*) as count FROM clubs`).get().count,
      skaters: db.prepare(`SELECT COUNT(*) as count FROM students`).get().count
    };

    res.render('public/index', {
      user: req.session.user || null,
      tournaments: upcomingTournaments,
      stats
    });
  }
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

  const categories = db.prepare(`SELECT * FROM categories WHERE tournament_id = ? ORDER BY min_age ASC, level ASC`).all(tournamentId);
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
  const judges = db.prepare(`
    SELECT id, full_name, email, phone 
    FROM users 
    WHERE role = 'juez'
  `).all();

  res.render('public/jueces', {
    user: req.session.user || null,
    judges
  });
});

module.exports = router;
