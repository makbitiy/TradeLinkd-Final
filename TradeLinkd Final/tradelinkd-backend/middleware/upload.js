const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

// Same DATA_DIR as db/init.js - keeps uploaded photos on the same persistent
// volume as the database, so both survive redeploys on a host like Railway.
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..');
const uploadsDir = path.join(dataDir, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const EXT_BY_TYPE = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = EXT_BY_TYPE[file.mimetype] || '.jpg';
    cb(null, crypto.randomBytes(16).toString('hex') + ext);
  }
});

function fileFilter(req, file, cb) {
  if (!ALLOWED_TYPES.has(file.mimetype)) {
    return cb(new Error('Only JPG, PNG, WEBP, or GIF images are allowed.'));
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024, files: 6 } // 5MB per file, max 6 files at once
});

module.exports = { upload, uploadsDir };
