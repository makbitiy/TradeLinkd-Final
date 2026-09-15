const express = require('express');
const db = require('../db/init');
const { requireAuth } = require('../middleware/auth');
const { upload } = require('../middleware/upload');

const router = express.Router();

function requireContractor(req, res, next) {
  if (req.user.type !== 'contractor') {
    return res.status(403).json({ error: 'The contractor network is only available to contractor accounts.' });
  }
  next();
}

function photosForPost(postId) {
  return db.prepare('SELECT filename FROM network_post_photos WHERE post_id = ? ORDER BY id').all(postId)
    .map(r => `/uploads/${r.filename}`);
}

// GET /api/network/posts - list threads, newest first, with reply counts
router.get('/posts', requireAuth, requireContractor, (req, res) => {
  const rows = db.prepare(`
    SELECT network_posts.*, users.name AS author_name, users.logo AS author_logo,
           (SELECT COUNT(*) FROM network_replies WHERE post_id = network_posts.id) AS reply_count
    FROM network_posts
    JOIN users ON users.id = network_posts.user_id
    ORDER BY network_posts.created_at DESC
  `).all();

  res.json({
    posts: rows.map(r => ({
      id: r.id, title: r.title, body: r.body, createdAt: r.created_at,
      authorId: r.user_id, authorName: r.author_name,
      authorLogo: r.author_logo ? `/uploads/${r.author_logo}` : null,
      replyCount: r.reply_count,
      photos: photosForPost(r.id)
    }))
  });
});

// POST /api/network/posts - start a new thread, with up to 3 photos
router.post('/posts', requireAuth, requireContractor, upload.array('photos', 3), (req, res) => {
  const { title, body } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'Thread title is required.' });
  if (!body || !body.trim()) return res.status(400).json({ error: 'Thread body is required.' });

  const tx = db.transaction(() => {
    const info = db.prepare('INSERT INTO network_posts (user_id, title, body) VALUES (?, ?, ?)')
      .run(req.user.id, title.trim(), body.trim());
    const postId = info.lastInsertRowid;
    if (req.files && req.files.length) {
      const insertPhoto = db.prepare('INSERT INTO network_post_photos (post_id, filename) VALUES (?, ?)');
      for (const f of req.files) insertPhoto.run(postId, f.filename);
    }
    return postId;
  });

  res.status(201).json({ id: tx() });
});

// GET /api/network/posts/:id - a thread with all its replies
router.get('/posts/:id', requireAuth, requireContractor, (req, res) => {
  const post = db.prepare(`
    SELECT network_posts.*, users.name AS author_name, users.logo AS author_logo
    FROM network_posts JOIN users ON users.id = network_posts.user_id
    WHERE network_posts.id = ?
  `).get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Thread not found.' });

  const replies = db.prepare(`
    SELECT network_replies.*, users.name AS author_name, users.logo AS author_logo
    FROM network_replies JOIN users ON users.id = network_replies.user_id
    WHERE post_id = ? ORDER BY network_replies.created_at ASC
  `).all(req.params.id);

  res.json({
    post: {
      id: post.id, title: post.title, body: post.body, createdAt: post.created_at,
      authorId: post.user_id, authorName: post.author_name,
      authorLogo: post.author_logo ? `/uploads/${post.author_logo}` : null,
      photos: photosForPost(post.id)
    },
    replies: replies.map(r => ({
      id: r.id, body: r.body, createdAt: r.created_at,
      authorId: r.user_id, authorName: r.author_name,
      authorLogo: r.author_logo ? `/uploads/${r.author_logo}` : null
    }))
  });
});

// POST /api/network/posts/:id/replies - reply to a thread
router.post('/posts/:id/replies', requireAuth, requireContractor, (req, res) => {
  const post = db.prepare('SELECT id FROM network_posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Thread not found.' });

  const { body } = req.body || {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'Reply cannot be empty.' });

  const info = db.prepare('INSERT INTO network_replies (post_id, user_id, body) VALUES (?, ?, ?)')
    .run(req.params.id, req.user.id, body.trim());
  res.status(201).json({ id: info.lastInsertRowid });
});

// DELETE /api/network/posts/:id - author only
router.delete('/posts/:id', requireAuth, requireContractor, (req, res) => {
  const post = db.prepare('SELECT * FROM network_posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: 'Thread not found.' });
  if (post.user_id !== req.user.id) return res.status(403).json({ error: 'You can only delete your own threads.' });

  db.prepare('DELETE FROM network_posts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
