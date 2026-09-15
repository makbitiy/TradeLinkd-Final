const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db = require('../db/init');
const { STATES } = require('../constants');
const { upload } = require('../middleware/upload');
const { requireAuth } = require('../middleware/auth');
const { sendMail } = require('../utils/mailer');
const { welcomeEmail, passwordResetEmail } = require('../utils/emailTemplates');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many attempts. Please try again in a few minutes.' }
});

const SALT_ROUNDS = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 6+ characters, at least one digit or special character (letters alone aren't enough)
const PASSWORD_RE = /^(?=.*[0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]).{6,}$/;

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, type: user.type },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

function publicUser(user, trades, profile) {
  const logoUrl = user.logo ? `/uploads/${user.logo}` : null;
  return {
    id: user.id,
    name: user.name,
    type: user.type,
    email: user.email,
    phone: user.phone,
    phonePublic: !!user.phone_public,
    state: user.state,
    county: user.county,
    countyPublic: !!user.county_public,
    profilePic: user.type === 'contractor' ? logoUrl : (user.profile_pic ? `/uploads/${user.profile_pic}` : null),
    logo: logoUrl,
    trades: trades || [],
    subscriptionStatus: user.type === 'contractor' ? (user.subscription_status || 'inactive') : undefined,
    area: profile ? profile.area : undefined,
    years: profile ? profile.years : undefined,
    bio: profile ? profile.bio : undefined
  };
}

// POST /api/auth/signup
// Multipart request: an optional profile picture (homeowners) or a REQUIRED
// business logo (contractors) travels in the same request as the account fields.
router.post('/signup', authLimiter, upload.single('avatar'), (req, res) => {
  const { password, name, type, email, phone, state, county } = req.body || {};
  const phonePublic = type === 'contractor' && (req.body.phonePublic === 'true' || req.body.phonePublic === true);
  const countyPublic = req.body.countyPublic === 'true' || req.body.countyPublic === true;

  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }
  if (!password || typeof password !== 'string' || !PASSWORD_RE.test(password)) {
    return res.status(400).json({ error: 'Password must be at least 6 characters and include a number or special character.' });
  }
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Please provide your name (or business name).' });
  }
  if (type !== 'homeowner' && type !== 'contractor') {
    return res.status(400).json({ error: "Account type must be 'homeowner' or 'contractor'." });
  }
  const phoneDigits = (phone || '').replace(/\D/g, '');
  if (!phone || phoneDigits.length !== 10) {
    return res.status(400).json({ error: 'Please provide a valid 10-digit phone number.' });
  }
  const stateCode = (state || '').trim().toUpperCase();
  if (!stateCode || !STATES.some(s => s.code === stateCode)) {
    return res.status(400).json({ error: 'Please select your state.' });
  }

  let cleanTrades = [];
  if (type === 'contractor') {
    if (!req.file) {
      return res.status(400).json({ error: 'A business logo is required for contractor accounts.' });
    }
    let trades = [];
    try { trades = JSON.parse(req.body.trades || '[]'); } catch (e) { trades = []; }
    if (!Array.isArray(trades)) trades = [];
    cleanTrades = [...new Set(trades.map(t => String(t).trim()).filter(Boolean))].slice(0, 20);
    if (cleanTrades.length === 0) {
      return res.status(400).json({ error: 'Select at least one type of contractor work you do.' });
    }
  }

  const emailNorm = email.trim().toLowerCase();

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(emailNorm);
  if (existing) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }

  const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);
  const logoFilename = type === 'contractor' && req.file ? req.file.filename : null;
  const profilePicFilename = type === 'homeowner' && req.file ? req.file.filename : null;
  const countyClean = (county || '').trim();

  const insertUser = db.prepare(`
    INSERT INTO users (email, password_hash, name, type, state, county, county_public, phone, phone_public, logo, profile_pic)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    const info = insertUser.run(
      emailNorm, passwordHash, name.trim(), type, stateCode, countyClean, countyPublic ? 1 : 0,
      phone.trim(), phonePublic ? 1 : 0, logoFilename, profilePicFilename
    );
    const userId = info.lastInsertRowid;

    if (type === 'contractor') {
      const insertTrade = db.prepare('INSERT OR IGNORE INTO contractor_trades (user_id, trade) VALUES (?, ?)');
      for (const t of cleanTrades) insertTrade.run(userId, t);
      db.prepare('INSERT INTO contractor_profiles (user_id, area, years, bio) VALUES (?, ?, ?, ?)')
        .run(userId, req.body.area || '', req.body.years || '', req.body.bio || '');
    }
    return userId;
  });

  const userId = tx();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const token = signToken(user);

  const { subject, html, text } = welcomeEmail(user.name);
  sendMail({ to: user.email, subject, html, text });

  const profile = type === 'contractor' ? { area: req.body.area || '', years: req.body.years || '', bio: req.body.bio || '' } : null;
  res.status(201).json({ token, user: publicUser(user, cleanTrades, profile) });
});

// POST /api/auth/login
router.post('/login', authLimiter, (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const emailNorm = String(email).trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(emailNorm);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }

  const trades = user.type === 'contractor'
    ? db.prepare('SELECT trade FROM contractor_trades WHERE user_id = ?').all(user.id).map(r => r.trade)
    : [];
  const profile = user.type === 'contractor'
    ? db.prepare('SELECT area, years, bio FROM contractor_profiles WHERE user_id = ?').get(user.id)
    : null;

  const token = signToken(user);
  res.json({ token, user: publicUser(user, trades, profile) });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const trades = user.type === 'contractor'
    ? db.prepare('SELECT trade FROM contractor_trades WHERE user_id = ?').all(user.id).map(r => r.trade)
    : [];
  const profile = user.type === 'contractor'
    ? db.prepare('SELECT area, years, bio FROM contractor_profiles WHERE user_id = ?').get(user.id)
    : null;
  res.json({ user: publicUser(user, trades, profile) });
});

// PATCH /api/auth/me/location - update state/county/county visibility (both account types)
router.patch('/me/location', requireAuth, (req, res) => {
  const { state, county } = req.body || {};
  const countyPublic = req.body.countyPublic === true || req.body.countyPublic === 'true';

  const stateCode = (state || '').trim().toUpperCase();
  if (!stateCode || !STATES.some(s => s.code === stateCode)) {
    return res.status(400).json({ error: 'Please select your state.' });
  }

  db.prepare('UPDATE users SET state = ?, county = ?, county_public = ? WHERE id = ?')
    .run(stateCode, (county || '').trim(), countyPublic ? 1 : 0, req.user.id);

  res.json({ ok: true });
});

// POST /api/auth/me/profile-pic - homeowners only
router.post('/me/profile-pic', requireAuth, upload.single('photo'), (req, res) => {
  if (req.user.type === 'contractor') {
    return res.status(403).json({ error: 'Contractor accounts use their business logo as their profile picture. Upload a logo instead.' });
  }
  if (!req.file) return res.status(400).json({ error: 'No image was uploaded.' });
  db.prepare('UPDATE users SET profile_pic = ? WHERE id = ?').run(req.file.filename, req.user.id);
  res.json({ profilePic: `/uploads/${req.file.filename}` });
});

// POST /api/auth/me/logo - contractors only
router.post('/me/logo', requireAuth, upload.single('logo'), (req, res) => {
  if (req.user.type !== 'contractor') {
    return res.status(403).json({ error: 'Only contractor accounts can upload a logo.' });
  }
  if (!req.file) return res.status(400).json({ error: 'No image was uploaded.' });
  db.prepare('UPDATE users SET logo = ? WHERE id = ?').run(req.file.filename, req.user.id);
  res.json({ logo: `/uploads/${req.file.filename}` });
});

// POST /api/auth/forgot-password - always responds the same way whether or not
// the email exists, so this can't be used to check who has an account.
router.post('/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body || {};
  const generic = { message: "If that email has an account, we've sent a reset link." };
  if (!email || !EMAIL_RE.test(String(email).trim())) return res.json(generic);

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).trim().toLowerCase());
  if (!user) return res.json(generic);

  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

  db.prepare('UPDATE users SET reset_token_hash = ?, reset_token_expires = ? WHERE id = ?')
    .run(tokenHash, expires, user.id);

  const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const resetUrl = `${appUrl}/?resetToken=${rawToken}`;
  const { subject, html, text } = passwordResetEmail(user.name, resetUrl);
  sendMail({ to: user.email, subject, html, text });

  res.json(generic);
});

// POST /api/auth/reset-password
router.post('/reset-password', authLimiter, (req, res) => {
  const { token, password } = req.body || {};
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Reset link is invalid or missing.' });
  }
  if (!password || !PASSWORD_RE.test(password)) {
    return res.status(400).json({ error: 'Password must be at least 6 characters and include a number or special character.' });
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const user = db.prepare('SELECT * FROM users WHERE reset_token_hash = ?').get(tokenHash);

  if (!user || !user.reset_token_expires || new Date(user.reset_token_expires) < new Date()) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
  }

  const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);
  db.prepare('UPDATE users SET password_hash = ?, reset_token_hash = NULL, reset_token_expires = NULL WHERE id = ?')
    .run(passwordHash, user.id);

  res.json({ ok: true });
});

module.exports = router;
