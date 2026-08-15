// Roles del sistema:
//   admin          → solo panel de administración
//   profesor       → solo módulo de profesora
//   profesor_admin → las dos cosas (ve primero lo de profesora y además el admin)
//   juez           → planilla de jueces
const ROLES = ['admin', 'profesor', 'juez', 'profesor_admin'];

function isProfesor(role) {
  return role === 'profesor' || role === 'profesor_admin';
}

function isAdmin(role) {
  return role === 'admin' || role === 'profesor_admin';
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/auth/login?error=' + encodeURIComponent('Debe iniciar sesión para acceder.'));
  }
  next();
}

// Acepta los roles indicados. 'profesor_admin' cuenta como 'profesor' y como
// 'admin', para que los módulos existentes sigan funcionando sin cambios.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.redirect('/auth/login');
    }

    const role = req.session.user.role;
    const allowed = roles.some(r => {
      if (r === 'profesor') return isProfesor(role);
      if (r === 'admin') return isAdmin(role);
      return r === role;
    });

    if (!allowed) {
      return res.status(403).render('error', {
        title: 'Acceso Denegado',
        message: 'No posee los permisos suficientes para acceder a este módulo.'
      });
    }
    next();
  };
}

// Alcance del panel de administración. Un usuario sin `admin_scope` ve todos los
// torneos; con alcance (ej: 'CABA') solo ve/edita los torneos cuyo nombre lo
// contenga. Devuelve null cuando no hay restricción.
function getAdminScope(user) {
  const scope = user && user.admin_scope ? String(user.admin_scope).trim() : '';
  return scope || null;
}

// Fragmento SQL reutilizable para filtrar torneos por alcance.
// Uso: const { sql, params } = scopeFilter(user, 't.name');
function scopeFilter(user, column = 't.name') {
  const scope = getAdminScope(user);
  if (!scope) return { sql: '', params: [] };
  return { sql: ` AND UPPER(${column}) LIKE ?`, params: [`%${scope.toUpperCase()}%`] };
}

// ¿Este usuario puede tocar este torneo?
function canManageTournament(user, tournament) {
  const scope = getAdminScope(user);
  if (!scope) return true;
  if (!tournament || !tournament.name) return false;
  return String(tournament.name).toUpperCase().includes(scope.toUpperCase());
}

module.exports = {
  ROLES,
  isProfesor,
  isAdmin,
  requireAuth,
  requireRole,
  getAdminScope,
  scopeFilter,
  canManageTournament
};
