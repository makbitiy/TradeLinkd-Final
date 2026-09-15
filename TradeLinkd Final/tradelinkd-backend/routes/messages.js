const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const { sendMail } = require('../utils/mailer');
const { messageNotificationEmail } = require('../utils/emailTemplates');

const router = express.Router();

// GET /api/messages/threads?q=keyword - list conversations, most recent first.
// Pinned threads always sort to the top. ?q= filters by the other person's name
// OR by matching text anywhere in the conversation.
router.get('/threads', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT
      CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END AS other_id,
      MAX(created_at) AS last_at
    FROM messages
    WHERE sender_id = ? OR recipient_id = ?
    GROUP BY other_id
    ORDER BY last_at DESC
  `).all(req.user.id, req.user.id, req.user.id);

  const userStmt = db.prepare('SELECT id, name, type, profile_pic FROM users WHERE id = ?');
  const lastMsgStmt = db.prepare(`
    SELECT body, sender_id, created_at FROM messages
    WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
    ORDER BY created_at DESC LIMIT 1
  `);
  const unreadStmt = db.prepare(`
    SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL
  `);
  const pinnedStmt = db.prepare('SELECT 1 FROM pinned_threads WHERE user_id = ? AND other_user_id = ?');
  const anyMatchStmt = db.prepare(`
    SELECT 1 FROM messages
    WHERE ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
      AND body LIKE ? LIMIT 1
  `);

  const q = (req.query.q || '').trim().toLowerCase();

  let threads = rows.map(r => {
    const other = userStmt.get(r.other_id);
    if (!other) return null;
    const last = lastMsgStmt.get(req.user.id, r.other_id, r.other_id, req.user.id);
    const unread = unreadStmt.get(r.other_id, req.user.id).n;
    const pinned = !!pinnedStmt.get(req.user.id, r.other_id);
    return {
      userId: other.id,
      name: other.name,
      type: other.type,
      profilePic: other.profile_pic ? `/uploads/${other.profile_pic}` : null,
      lastMessage: last ? last.body : '',
      lastAt: last ? last.created_at : null,
      unread,
      pinned
    };
  }).filter(Boolean);

  if (q) {
    threads = threads.filter(t => {
      if (t.name.toLowerCase().includes(q)) return true;
      return !!anyMatchStmt.get(req.user.id, t.userId, t.userId, req.user.id, `%${q}%`);
    });
  }

  threads.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return new Date(b.lastAt || 0) - new Date(a.lastAt || 0);
  });

  res.json({ threads });
});

// GET /api/messages/thread/:userId - full conversation with one other user
router.get('/thread/:userId', requireAuth, (req, res) => {
  const otherId = Number(req.params.userId);
  const other = db.prepare('SELECT id, name, type FROM users WHERE id = ?').get(otherId);
  if (!other) return res.status(404).json({ error: 'User not found.' });

  const rows = db.prepare(`
    SELECT * FROM messages
    WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
    ORDER BY created_at ASC
  `).all(req.user.id, otherId, otherId, req.user.id);

  db.prepare(`UPDATE messages SET read_at = datetime('now') WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL`)
    .run(otherId, req.user.id);

  const pinned = !!db.prepare('SELECT 1 FROM pinned_threads WHERE user_id = ? AND other_user_id = ?').get(req.user.id, otherId);

  res.json({
    other: { id: other.id, name: other.name, type: other.type },
    pinned,
    messages: rows.map(m => ({
      id: m.id, senderId: m.sender_id, body: m.body, jobId: m.job_id, createdAt: m.created_at
    }))
  });
});

// POST /api/messages - send a message to another user, optionally about a specific job
router.post('/', requireAuth, (req, res) => {
  const { recipientId, body, jobId } = req.body || {};
  const recipient = Number(recipientId);
  const recipientUser = db.prepare('SELECT * FROM users WHERE id = ?').get(recipient);
  if (!recipient || !recipientUser) {
    return res.status(400).json({ error: 'Recipient not found.' });
  }
  if (recipient === req.user.id) return res.status(400).json({ error: "You can't message yourself." });
  if (!body || !body.trim()) return res.status(400).json({ error: 'Message cannot be empty.' });

  const info = db.prepare(`INSERT INTO messages (sender_id, recipient_id, job_id, body) VALUES (?, ?, ?, ?)`)
    .run(req.user.id, recipient, jobId || null, body.trim());

  const sender = db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.id);
  const { subject, html, text } = messageNotificationEmail(sender.name, body.trim());
  sendMail({ to: recipientUser.email, subject, html, text });

  res.status(201).json({ id: info.lastInsertRowid });
});

// POST /api/messages/pin/:userId - pin a conversation
router.post('/pin/:userId', requireAuth, (req, res) => {
  const otherId = Number(req.params.userId);
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(otherId)) {
    return res.status(404).json({ error: 'User not found.' });
  }
  db.prepare('INSERT OR IGNORE INTO pinned_threads (user_id, other_user_id) VALUES (?, ?)').run(req.user.id, otherId);
  res.json({ ok: true, pinned: true });
});

// DELETE /api/messages/pin/:userId - unpin a conversation
router.delete('/pin/:userId', requireAuth, (req, res) => {
  db.prepare('DELETE FROM pinned_threads WHERE user_id = ? AND other_user_id = ?').run(req.user.id, req.params.userId);
  res.json({ ok: true, pinned: false });
});

module.exports = router;
