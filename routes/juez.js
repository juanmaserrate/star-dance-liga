const express = require('express');
const router = express.Router();
const db = require('../database');
const { requireAuth, requireRole } = require('../middleware/auth');

// All routes require role 'juez' or 'admin'
router.use(requireAuth, requireRole('juez', 'admin'));

// Helper: entero positivo o null (evita que ?tournament_id=abc tumbe la consulta)
function toInt(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Planilla de Competencia para Jueces
router.get('/planilla', async (req, res) => {
  const tournaments = await db.prepare(`SELECT * FROM tournaments ORDER BY event_date DESC`).all();
  const selectedTournamentId = toInt(req.query.tournament_id) || (tournaments.length > 0 ? tournaments[0].id : null);
  const selectedCategoryId = toInt(req.query.category_id);

  let categories = [];
  if (selectedTournamentId) {
    categories = await db.prepare(`
      SELECT * FROM categories
      WHERE tournament_id = ? AND COALESCE(is_active, true) = true
      ORDER BY min_age ASC, division ASC
    `).all(selectedTournamentId);
  }

  let query = `
    SELECT r.*,
    COALESCE(s.first_name, r.group_name) as first_name,
    COALESCE(s.last_name, 'GRUPO') as last_name,
    s.birth_date,
    cl.name as club_name,
    c.name as category_name, c.discipline, c.division as level, c.min_age, c.max_age, c.schedule
    FROM registrations r
    LEFT JOIN students s ON r.student_id = s.id
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

  const competitors = await db.prepare(query).all(...params);

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
