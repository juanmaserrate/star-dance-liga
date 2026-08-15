// Asigna por única vez el rol combinado profesor + administrador a las personas
// que lo pidió la Liga. Se ejecuta solo cuando cambia ROLES_REVISION: después
// manda lo que se configure desde el panel de Usuarios, así un cambio hecho a
// mano no se pisa en el siguiente arranque.
const db = require('../database');
const { getSetting, setSetting } = require('./tournament_config');

const ROLES_KEY = 'roles_revision';
const ROLES_REVISION = '2026-08-15-profesor-admin';

// admin_scope null = administra todos los torneos.
// admin_scope 'CABA' = solo los torneos cuyo nombre contenga CABA.
const ASIGNACIONES = [
  { email: 'gisellelorenaalarcon@hotmail.com', role: 'profesor_admin', admin_scope: 'CABA' },
  { email: 'sandrasil222@hotmail.com', role: 'profesor_admin', admin_scope: null },
  { email: 'coagju@gmail.com.ar', role: 'profesor_admin', admin_scope: null }
];

async function ensureRoles() {
  const stored = await getSetting(ROLES_KEY);
  if (stored === ROLES_REVISION) return { skipped: true, updated: [], notFound: [] };

  const report = { skipped: false, updated: [], notFound: [] };

  for (const a of ASIGNACIONES) {
    // Se busca por email (o por usuario, que en los registros nuevos es el email).
    const user = await db.prepare(`
      SELECT id, full_name, email FROM users
      WHERE LOWER(email) = ? OR LOWER(username) = ?
      ORDER BY id ASC LIMIT 1
    `).get(a.email, a.email);

    if (!user) {
      report.notFound.push(a.email);
      continue;
    }

    await db.prepare(`UPDATE users SET role = ?, admin_scope = ? WHERE id = ?`)
      .run(a.role, a.admin_scope, user.id);
    report.updated.push({ id: user.id, name: user.full_name, email: a.email, scope: a.admin_scope });
  }

  await setSetting(ROLES_KEY, ROLES_REVISION);
  return report;
}

module.exports = { ensureRoles, ASIGNACIONES, ROLES_REVISION };
