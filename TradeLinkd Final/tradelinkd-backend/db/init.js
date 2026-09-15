const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'homeconnect.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('homeowner','contractor')),
  city           TEXT NOT NULL DEFAULT '',
  state          TEXT NOT NULL DEFAULT '',
  county         TEXT NOT NULL DEFAULT '',
  county_public  INTEGER NOT NULL DEFAULT 0,
  phone          TEXT NOT NULL,
  phone_public   INTEGER NOT NULL DEFAULT 0,
  profile_pic    TEXT DEFAULT NULL,
  logo           TEXT DEFAULT NULL,
  stripe_customer_id     TEXT DEFAULT NULL,
  stripe_subscription_id TEXT DEFAULT NULL,
  subscription_status    TEXT NOT NULL DEFAULT 'inactive',
  reset_token_hash    TEXT DEFAULT NULL,
  reset_token_expires TEXT DEFAULT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contractor_trades (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trade       TEXT NOT NULL,
  UNIQUE(user_id, trade)
);

CREATE TABLE IF NOT EXISTS contractor_profiles (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  area        TEXT DEFAULT '',
  years       TEXT DEFAULT '',
  bio         TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS contractor_photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  trade           TEXT NOT NULL,
  location        TEXT NOT NULL,
  description     TEXT NOT NULL,
  budget          TEXT DEFAULT '',
  contractor_id   INTEGER DEFAULT NULL REFERENCES users(id) ON DELETE SET NULL,
  homeowner_done  INTEGER NOT NULL DEFAULT 0,
  contractor_done INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_trades (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  trade       TEXT NOT NULL,
  UNIQUE(job_id, trade)
);

CREATE TABLE IF NOT EXISTS job_photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reviews (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  contractor_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reviewer_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating         INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment        TEXT DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(contractor_id, reviewer_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id        INTEGER DEFAULT NULL REFERENCES jobs(id) ON DELETE SET NULL,
  body          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  read_at       TEXT DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS pinned_threads (
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  other_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pinned_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, other_user_id)
);

CREATE TABLE IF NOT EXISTS network_posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS network_post_photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     INTEGER NOT NULL REFERENCES network_posts(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS network_replies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     INTEGER NOT NULL REFERENCES network_posts(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_trade ON jobs(trade);
CREATE INDEX IF NOT EXISTS idx_job_trades_trade ON job_trades(trade);
CREATE INDEX IF NOT EXISTS idx_trades_trade ON contractor_trades(trade);
CREATE INDEX IF NOT EXISTS idx_reviews_contractor ON reviews(contractor_id);
CREATE INDEX IF NOT EXISTS idx_messages_participants ON messages(sender_id, recipient_id);
CREATE INDEX IF NOT EXISTS idx_network_replies_post ON network_replies(post_id);
`);

// Safe migration for databases created before password reset support existed -
// adds the columns without wiping existing data. Harmless no-op if they're
// already there (SQLite throws "duplicate column", which we just ignore).
try { db.exec("ALTER TABLE users ADD COLUMN reset_token_hash TEXT DEFAULT NULL"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN reset_token_expires TEXT DEFAULT NULL"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN state TEXT NOT NULL DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN county TEXT NOT NULL DEFAULT ''"); } catch (e) {}
try { db.exec("ALTER TABLE users ADD COLUMN county_public INTEGER NOT NULL DEFAULT 0"); } catch (e) {}

module.exports = db;
