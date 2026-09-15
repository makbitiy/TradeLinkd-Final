require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const multer = require('multer');

if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'replace_this_with_a_long_random_string') {
  console.error('\nERROR: JWT_SECRET is not set (or still the placeholder) in your .env file.');
  console.error('Open .env and set JWT_SECRET to any long random string.\n');
  process.exit(1);
}

const authRoutes = require('./routes/auth');
const jobRoutes = require('./routes/jobs');
const contractorRoutes = require('./routes/contractors');
const messageRoutes = require('./routes/messages');
const networkRoutes = require('./routes/network');
const { router: billingRoutes, webhookHandler } = require('./routes/billing');
const { uploadsDir } = require('./middleware/upload');

const app = express();

const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : true,
  credentials: true
}));

// Stripe's webhook needs the raw, unparsed request body to verify its signature,
// so this route is registered BEFORE the JSON body parser below.
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), webhookHandler);

app.use(express.json({ limit: '100kb' }));

app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));

app.use('/api/auth', authRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/contractors', contractorRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/network', networkRoutes);
app.use('/api/billing', billingRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Uploaded images (profile pics, logos, job photos, work photos)
app.use('/uploads', express.static(uploadsDir));

// Frontend
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Central error handler - catches upload errors (bad file type, too big) with a clear message
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Each image must be under 5MB.' });
    if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: 'You can upload up to 6 images at a time.' });
    return res.status(400).json({ error: err.message });
  }
  if (err && /Only JPG|Only .*images are allowed/.test(err.message || '')) {
    return res.status(400).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our end.' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`TradeLinkd API running on http://localhost:${PORT}`);
});
