const express = require('express');
const db = require('../db/init');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { distanceMiles, findCityCoords } = require('../utils/geo');
const { STATES } = require('../constants');

const router = express.Router();

function photosFor(userId) {
  return db.prepare('SELECT filename FROM contractor_photos WHERE user_id = ? ORDER BY id').all(userId)
    .map(r => `/uploads/${r.filename}`);
}

function reviewSummary(userId) {
  const row = db.prepare('SELECT COUNT(*) AS n, AVG(rating) AS avg FROM reviews WHERE contractor_id = ?').get(userId);
  return { count: row.n, average: row.n ? Math.round(row.avg * 10) / 10 : null };
}

const tradeStmt = () => db.prepare('SELECT trade FROM contractor_trades WHERE user_id = ?');
const profileStmt = () => db.prepare('SELECT area, years, bio FROM contractor_profiles WHERE user_id = ?');

function contactFor(u, loggedIn) {
  if (!loggedIn) return null;
  return { email: u.email, phone: u.phone_public ? u.phone : null };
}

function serializeContractor(u, loggedIn, isOwn) {
  const trades = tradeStmt().all(u.id).map(r => r.trade);
  const profile = profileStmt().get(u.id) || { area: '', years: '', bio: '' };
  return {
    id: u.id,
    name: u.name,
    trades,
    state: u.state,
    county: (isOwn || u.county_public) ? u.county : null,
    countyPublic: isOwn ? !!u.county_public : undefined,
    area: profile.area,
    years: profile.years,
    bio: profile.bio,
    logo: u.logo ? `/uploads/${u.logo}` : null,
    photos: photosFor(u.id),
    reviews: reviewSummary(u.id),
    contact: contactFor(u, loggedIn)
  };
}

// Sorts so entries matching viewerState come first, preserving existing order otherwise.
function sortSameStateFirst(users, viewerState) {
  if (!viewerState) return users;
  return users
    .map((u, i) => ({ u, i, sameState: u.state === viewerState ? 0 : 1 }))
    .sort((a, b) => a.sameState - b.sameState || a.i - b.i)
    .map(x => x.u);
}

// Distance filtering only kicks in when a location was explicitly given (via the
// site's "filter by distance" prompt) - never assumed from a stored account.
function applyRadiusFilter(users, fromState, fromCounty, radiusMiles) {
  if (!fromState || !radiusMiles) return users;
  const key = fromCounty ? `${fromCounty}, ${fromState.toUpperCase()}` : fromState.toUpperCase();
  const center = findCityCoords(key);
  const radius = Number(radiusMiles);
  if (!center || !(radius > 0)) return users;
  return users.filter(u => {
    const uKey = u.county ? `${u.county}, ${u.state}` : u.state;
    const coords = findCityCoords(uKey);
    return coords && distanceMiles(center.lat, center.lng, coords.lat, coords.lng) <= radius;
  });
}

// GET /api/contractors?trade=Electrical&fromState=MI&fromCounty=Macomb%20County&radiusMiles=25
// The public, homeowner-facing directory. Open to guests and homeowners
// (contact info shown only once logged in). Contractor accounts don't browse this -
// they show up IN it, but use /api/contractors/network to find each other instead.
router.get('/', optionalAuth, (req, res) => {
  if (req.user && req.user.type === 'contractor') {
    return res.status(403).json({ error: 'Contractor accounts use the contractor network to connect with other contractors.', useNetwork: true });
  }

  const { trade, fromState, fromCounty, radiusMiles } = req.query;
  let users = trade
    ? db.prepare(`
        SELECT DISTINCT users.*
        FROM users
        JOIN contractor_trades ON contractor_trades.user_id = users.id
        WHERE users.type = 'contractor' AND contractor_trades.trade = ?
        ORDER BY users.created_at DESC
      `).all(trade)
    : db.prepare(`SELECT * FROM users WHERE type = 'contractor' ORDER BY created_at DESC`).all();

  users = applyRadiusFilter(users, fromState, fromCounty, radiusMiles);

  const viewerState = req.user ? (db.prepare('SELECT state FROM users WHERE id = ?').get(req.user.id) || {}).state : null;
  users = sortSameStateFirst(users, viewerState);

  const loggedIn = !!req.user;
  res.json({ contractors: users.map(u => serializeContractor(u, loggedIn)), loggedIn });
});

// GET /api/contractors/network?trade=Electrical&fromState=...&fromCounty=...&radiusMiles=...
// A members-only space for contractor accounts to find and connect with OTHER
// contractors. Contact info is always shown here since both sides are already
// verified, logged-in contractor accounts.
router.get('/network', requireAuth, (req, res) => {
  if (req.user.type !== 'contractor') {
    return res.status(403).json({ error: 'The contractor network is only available to contractor accounts.' });
  }

  const { trade, fromState, fromCounty, radiusMiles } = req.query;
  let users = trade
    ? db.prepare(`
        SELECT DISTINCT users.*
        FROM users
        JOIN contractor_trades ON contractor_trades.user_id = users.id
        WHERE users.type = 'contractor' AND contractor_trades.trade = ? AND users.id != ?
        ORDER BY users.created_at DESC
      `).all(trade, req.user.id)
    : db.prepare(`SELECT * FROM users WHERE type = 'contractor' AND id != ? ORDER BY created_at DESC`).all(req.user.id);

  users = applyRadiusFilter(users, fromState, fromCounty, radiusMiles);

  const viewerState = (db.prepare('SELECT state FROM users WHERE id = ?').get(req.user.id) || {}).state;
  users = sortSameStateFirst(users, viewerState);

  res.json({ contractors: users.map(u => serializeContractor(u, true)) });
});

// PATCH /api/contractors/me - update area/years/bio (state/county now handled by
// PATCH /api/auth/me/location, shared with homeowner accounts)
router.patch('/me', requireAuth, (req, res) => {
  if (req.user.type !== 'contractor') {
    return res.status(403).json({ error: 'Only contractor accounts have a profile to edit.' });
  }
  const { area, years, bio } = req.body || {};
  db.prepare(`UPDATE contractor_profiles SET area = ?, years = ?, bio = ? WHERE user_id = ?`)
    .run(area || '', years || '', bio || '', req.user.id);
  res.json({ ok: true });
});

// GET /api/contractors/:id - a single contractor's business page.
// Viewable by everyone - guests, homeowners, AND other contractor accounts.
router.get('/:id', optionalAuth, (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return next();
  const user = db.prepare(`SELECT * FROM users WHERE id = ? AND type = 'contractor'`).get(id);
  if (!user) return res.status(404).json({ error: 'Contractor not found.' });

  const loggedIn = !!req.user;
  const isOwn = req.user && req.user.id === id;
  res.json({ contractor: serializeContractor(user, loggedIn, isOwn) });
});

// POST /api/contractors/me/photos - work highlights (optional, contractors only)
router.post('/me/photos', requireAuth, upload.array('photos', 6), (req, res) => {
  if (req.user.type !== 'contractor') {
    return res.status(403).json({ error: 'Only contractor accounts can upload work photos.' });
  }
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No images were uploaded.' });

  const insert = db.prepare('INSERT INTO contractor_photos (user_id, filename) VALUES (?, ?)');
  const tx = db.transaction((files) => { for (const f of files) insert.run(req.user.id, f.filename); });
  tx(req.files);

  res.json({ photos: photosFor(req.user.id) });
});

// GET /api/contractors/:id/reviews
router.get('/:id/reviews', (req, res) => {
  const rows = db.prepare(`
    SELECT reviews.*, users.name AS reviewer_name
    FROM reviews JOIN users ON users.id = reviews.reviewer_id
    WHERE contractor_id = ? ORDER BY reviews.created_at DESC
  `).all(req.params.id);

  res.json({
    reviews: rows.map(r => ({
      id: r.id, rating: r.rating, comment: r.comment,
      reviewerName: r.reviewer_name, createdAt: r.created_at
    })),
    summary: reviewSummary(req.params.id)
  });
});

// POST /api/contractors/:id/reviews - leave a review (any logged-in user, once per contractor)
router.post('/:id/reviews', requireAuth, (req, res) => {
  const contractorId = Number(req.params.id);
  const contractor = db.prepare(`SELECT * FROM users WHERE id = ? AND type = 'contractor'`).get(contractorId);
  if (!contractor) return res.status(404).json({ error: 'Contractor not found.' });
  if (contractorId === req.user.id) return res.status(400).json({ error: "You can't review yourself." });

  const { rating, comment } = req.body || {};
  const r = Number(rating);
  if (!Number.isInteger(r) || r < 1 || r > 5) {
    return res.status(400).json({ error: 'Rating must be a whole number from 1 to 5.' });
  }

  try {
    db.prepare(`
      INSERT INTO reviews (contractor_id, reviewer_id, rating, comment) VALUES (?, ?, ?, ?)
      ON CONFLICT(contractor_id, reviewer_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment, created_at = datetime('now')
    `).run(contractorId, req.user.id, r, (comment || '').trim());
  } catch (err) {
    return res.status(500).json({ error: 'Could not save review.' });
  }

  res.status(201).json({ summary: reviewSummary(contractorId) });
});

module.exports = router;
