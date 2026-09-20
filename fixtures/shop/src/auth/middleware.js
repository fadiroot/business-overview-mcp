function requireAuth(req, res, next) { if (!req.user) return res.status(401).end(); next(); }
function requireRole(...roles) { return (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).end(); }
module.exports = { requireAuth, requireRole };
