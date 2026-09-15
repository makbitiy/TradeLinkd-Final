const jwt = require('jsonwebtoken');

// Requires a valid login session. Rejects the request if missing/invalid.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'You need to be logged in to do that.' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, email, type }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  }
}

// Attaches req.user if a valid token is present, but doesn't block the request
// if it's missing. Useful for endpoints that behave differently when logged in
// (e.g. showing contact info) without requiring login to view at all.
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      // ignore invalid/expired token, just proceed unauthenticated
    }
  }
  next();
}

module.exports = { requireAuth, optionalAuth };
