function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/auth/login?error=' + encodeURIComponent('Debe iniciar sesión para acceder.'));
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.redirect('/auth/login');
    }
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).render('error', {
        title: 'Acceso Denegado',
        message: 'No posee los permisos suficientes para acceder a este módulo.'
      });
    }
    next();
  };
}

module.exports = {
  requireAuth,
  requireRole
};
