const express = require('express');
const db = require('../db/init');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { distanceMiles, findCityCoords } = require('../utils/geo');

const router = express.Router();

function photosFor(jobId) {
  return db.prepare('SELECT filename FROM job_photos WHERE job_id = ? ORDER BY id').all(jobId)
    .map(r => `/uploads/${r.filename}`);
}
function tradesFor(jobId) {
  return db.prepare('SELECT trade FROM job_trades WHERE job_id = ? ORDER BY id').all(jobId).map(r => r.trade);
}

// Builds the internal, always-accurate location string used for distance matching
// (uses the RAW county regardless of the poster's display privacy setting).
function locationKeyFor(stateCode, county) {
  return county ? `${county}, ${stateCode}` : stateCode;
}

function serializeJob(r, viewerType, loggedIn) {
  const showContact = loggedIn && viewerType !== 'contractor';
  return {
    id: r.id,
    title: r.title,
    trades: tradesFor(r.id),
    state: r.poster_state,
    county: r.poster_county_public ? r.poster_county : null,
    description: r.description,
    budget: r.budget,
    postedBy: r.poster_name,
    postedByPic: r.poster_pic ? `/uploads/${r.poster_pic}` : null,
    postedById: r.user_id,
    contractorId: r.contractor_id,
    contractorName: r.contractor_name || null,
    homeownerDone: !!r.homeowner_done,
    contractorDone: !!r.contractor_done,
    createdAt: r.created_at,
    contact: showContact ? { email: r.poster_email, phone: r.poster_phone_public ? r.poster_phone : null } : null,
    photos: photosFor(r.id)
  };
}

// GET /api/jobs?trade=Plumbing&fromState=MI&fromCounty=Macomb%20County&radiusMiles=25
// - Homeowners only ever see their OWN posts (enforced here, not just in the UI).
// - Contractors must have an ACTIVE SUBSCRIPTION to see the job board at all.
// - Results are sorted so posts from the viewer's own state come first.
// - Distance filtering only applies when fromState is explicitly given (the site
//   asks for this via a "filter by distance" prompt - it's never assumed silently).
router.get('/', optionalAuth, (req, res) => {
  const { trade, fromState, fromCounty, radiusMiles } = req.query;
  const isHomeowner = req.user && req.user.type === 'homeowner';
  const isContractor = req.user && req.user.type === 'contractor';

  const base = `
    SELECT jobs.*, users.name AS poster_name,
           users.email AS poster_email, users.phone AS poster_phone, users.phone_public AS poster_phone_public,
           users.profile_pic AS poster_pic, users.state AS poster_state, users.county AS poster_county,
           users.county_public AS poster_county_public,
           c.name AS contractor_name
    FROM jobs
    JOIN users ON users.id = jobs.user_id
    LEFT JOIN users c ON c.id = jobs.contractor_id
  `;

  const clauses = [];
  const params = [];
  if (isHomeowner) { clauses.push('jobs.user_id = ?'); params.push(req.user.id); }
  if (trade) {
    clauses.push('jobs.id IN (SELECT job_id FROM job_trades WHERE trade = ?)');
    params.push(trade);
  }
  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';

  let rows = db.prepare(base + where + ' ORDER BY jobs.created_at DESC').all(...params);

  if (fromState && radiusMiles) {
    const center = findCityCoords(locationKeyFor(fromState.trim().toUpperCase(), (fromCounty || '').trim()));
    const radius = Number(radiusMiles);
    if (center && radius > 0) {
      rows = rows.filter(r => {
        const jobCoords = findCityCoords(locationKeyFor(r.poster_state, r.poster_county));
        return jobCoords && distanceMiles(center.lat, center.lng, jobCoords.lat, jobCoords.lng) <= radius;
      });
    }
  }

  if (req.user) {
    const myAccount = db.prepare('SELECT state FROM users WHERE id = ?').get(req.user.id);
    const myState = myAccount ? myAccount.state : null;
    rows = rows
      .map((r, i) => ({ r, i, sameState: r.poster_state === myState ? 0 : 1 }))
      .sort((a, b) => a.sameState - b.sameState || a.i - b.i)
      .map(x => x.r);
  }

  const loggedIn = !!req.user;
  const viewerType = req.user ? req.user.type : null;
  res.json({ jobs: rows.map(r => serializeJob(r, viewerType, loggedIn)), loggedIn });
});

// POST /api/jobs - homeowners only. Location is derived from the poster's own
// account (state + county), never entered freehand.
router.post('/', requireAuth, (req, res) => {
  if (req.user.type !== 'homeowner') {
    return res.status(403).json({ error: 'Only homeowner accounts can post jobs.' });
  }
  const { title, description, budget } = req.body || {};
  let trades = req.body.trades;
  if (typeof trades === 'string') { try { trades = JSON.parse(trades); } catch (e) { trades = []; } }
  if (!Array.isArray(trades)) trades = [];
  trades = [...new Set(trades.map(t => String(t).trim()).filter(Boolean))];

  if (!title || !title.trim()) return res.status(400).json({ error: 'Job title is required.' });
  if (trades.length === 0) return res.status(400).json({ error: 'Select at least one trade needed.' });
  if (!description || !description.trim()) return res.status(400).json({ error: 'Description is required.' });

  const me = db.prepare('SELECT state, county FROM users WHERE id = ?').get(req.user.id);
  const location = locationKeyFor(me.state, me.county);

  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO jobs (user_id, title, trade, location, description, budget)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(req.user.id, title.trim(), trades.join(', '), location, description.trim(), (budget || '').trim());
    const jobId = info.lastInsertRowid;
    const insertTrade = db.prepare('INSERT OR IGNORE INTO job_trades (job_id, trade) VALUES (?, ?)');
    for (const t of trades) insertTrade.run(jobId, t);
    return jobId;
  });

  const jobId = tx();
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  res.status(201).json({ job: { ...job, trades } });
});

// POST /api/jobs/:id/photos - owner only
router.post('/:id/photos', requireAuth, upload.array('photos', 6), (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.user_id !== req.user.id) return res.status(403).json({ error: 'You can only add photos to your own post.' });
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No images were uploaded.' });

  const insert = db.prepare('INSERT INTO job_photos (job_id, filename) VALUES (?, ?)');
  const tx = db.transaction((files) => { for (const f of files) insert.run(job.id, f.filename); });
  tx(req.files);

  res.json({ photos: photosFor(job.id) });
});

// PATCH /api/jobs/:id - edit your own post (title/trades/description/budget only -
// location always re-derives from your current account state/county)
router.patch('/:id', requireAuth, (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.user_id !== req.user.id) return res.status(403).json({ error: 'You can only edit your own posts.' });

  const { title, description, budget } = req.body || {};
  let trades = req.body.trades;
  if (typeof trades === 'string') { try { trades = JSON.parse(trades); } catch (e) { trades = []; } }
  if (!Array.isArray(trades)) trades = [];
  trades = [...new Set(trades.map(t => String(t).trim()).filter(Boolean))];

  if (!title || !title.trim()) return res.status(400).json({ error: 'Job title is required.' });
  if (trades.length === 0) return res.status(400).json({ error: 'Select at least one trade needed.' });
  if (!description || !description.trim()) return res.status(400).json({ error: 'Description is required.' });

  const me = db.prepare('SELECT state, county FROM users WHERE id = ?').get(req.user.id);
  const location = locationKeyFor(me.state, me.county);

  const tx = db.transaction(() => {
    db.prepare(`UPDATE jobs SET title = ?, trade = ?, location = ?, description = ?, budget = ? WHERE id = ?`)
      .run(title.trim(), trades.join(', '), location, description.trim(), (budget || '').trim(), job.id);
    db.prepare('DELETE FROM job_trades WHERE job_id = ?').run(job.id);
    const insertTrade = db.prepare('INSERT OR IGNORE INTO job_trades (job_id, trade) VALUES (?, ?)');
    for (const t of trades) insertTrade.run(job.id, t);
  });
  tx();

  res.json({ job: db.prepare('SELECT * FROM jobs WHERE id = ?').get(job.id) });
});

// POST /api/jobs/:id/claim - a contractor marks themselves as the one doing this job.
router.post('/:id/claim', requireAuth, (req, res) => {
  if (req.user.type !== 'contractor') {
    return res.status(403).json({ error: 'Only contractor accounts can be assigned to a job.' });
  }
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });

  db.prepare('UPDATE jobs SET contractor_id = ?, contractor_done = 0, homeowner_done = 0 WHERE id = ?')
    .run(req.user.id, job.id);
  res.json({ ok: true });
});

// POST /api/jobs/:id/complete - either side confirms the job is done.
router.post('/:id/complete', requireAuth, (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });

  const isOwner = job.user_id === req.user.id;
  const isContractor = job.contractor_id === req.user.id;
  if (!isOwner && !isContractor) {
    return res.status(403).json({ error: 'Only the homeowner and the assigned contractor can mark this job complete.' });
  }
  if (isContractor && !job.contractor_id) {
    return res.status(400).json({ error: 'No contractor is assigned to this job yet.' });
  }

  const homeownerDone = isOwner ? 1 : job.homeowner_done;
  const contractorDone = isContractor ? 1 : job.contractor_done;

  if (homeownerDone && contractorDone && job.contractor_id) {
    db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
    return res.json({ ok: true, deleted: true });
  }

  db.prepare('UPDATE jobs SET homeowner_done = ?, contractor_done = ? WHERE id = ?')
    .run(homeownerDone, contractorDone, job.id);
  res.json({ ok: true, deleted: false, homeownerDone: !!homeownerDone, contractorDone: !!contractorDone });
});

// DELETE /api/jobs/:id - owner only
router.delete('/:id', requireAuth, (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.user_id !== req.user.id) return res.status(403).json({ error: "You can only delete your own posts." });

  db.prepare('DELETE FROM jobs WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
