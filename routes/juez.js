const express = require('express');
const router = express.Router();
const db = require('../database');
const { requireAuth, requireRole } = require('../middleware/auth');

// All routes require role 'juez' or 'admin'
router.use(requireAuth, requireRole('juez', 'admin'));

// Planilla de Competencia para Jueces
router.get('/planilla', (req, res) => {
  const tournaments = db.prepare(`SELECT * FROM tournaments ORDER BY event_date DESC`).all();
  const selectedTournamentId = req.query.tournament_id || (tournaments.length > 0 ? tournaments[0].id : null);
  const selectedCategoryId = req.query.category_id || null;

  let categories = [];
  if (selectedTournamentId) {
    categories = db.prepare(`SELECT * FROM categories WHERE tournament_id = ? ORDER BY min_age ASC, level ASC`).all(selectedTournamentId);
  }

  let query = `
    SELECT r.*, 
    s.first_name, s.last_name, s.birth_date,
    cl.name as club_name,
    c.name as category_name, c.discipline, c.level, c.min_age, c.max_age, c.schedule
    FROM registrations r
    JOIN students s ON r.student_id = s.id
    JOIN clubs cl ON r.club_id = cl.id
    JOIN categories c ON r.category_id = c.id
    WHERE r.tournament_id = ?
  `;
  const params = [selectedTournamentId];

  if (selectedCategoryId) {
    query += ` AND r.category_id = ?`;
    params.push(selectedCategoryId);
  }

  query += ` ORDER BY c.min_age ASC, c.name ASC, s.last_name ASC`;

  const competitors = db.prepare(query).all(...params);

  // Group competitors by category
  const groupedCategories = {};
  competitors.forEach(comp => {
    if (!groupedCategories[comp.category_name]) {
      groupedCategories[comp.category_name] = {
        name: comp.category_name,
        discipline: comp.discipline,
        level: comp.level,
        schedule: comp.schedule,
        skaters: []
      };
    }
    groupedCategories[comp.category_name].skaters.push(comp);
  });

  res.render('juez/planilla', {
    user: req.session.user,
    tournaments,
    selectedTournamentId,
    categories,
    selectedCategoryId,
    groupedCategories
  });
});

module.exports = router;
