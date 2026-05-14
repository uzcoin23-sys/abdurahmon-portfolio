const express = require('express');
const db = require('../db');

module.exports = function(sessions) {
  const router = express.Router();

  function authCheck(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (!token || !sessions.has(token)) {
      return res.status(401).json({ error: "Ruxsat yo'q" });
    }
    next();
  }

  function projectPayload(body = {}) {
    return {
      title: String(body.title || '').trim(),
      description: body.description || '',
      tech_stack: body.tech_stack || '',
      image_url: body.image_url || '',
      live_url: body.live_url || '',
      github_url: body.github_url || '',
      category: body.category || ''
    };
  }

  // GET /api/projects
  router.get('/', (req, res) => {
    try {
      const cat = req.query.category;
      const projects = (cat && cat !== 'all')
        ? db.prepare('SELECT * FROM projects WHERE category=? ORDER BY id DESC').all(cat)
        : db.prepare('SELECT * FROM projects ORDER BY id DESC').all();
      res.json(projects);
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/projects
  router.post('/', authCheck, (req, res) => {
    const { title, description, tech_stack, image_url, live_url, github_url, category } = projectPayload(req.body);
    if (!title) return res.status(400).json({ error: 'Sarlavha kiritilmagan' });
    try {
      const result = db.prepare(`
        INSERT INTO projects (title, description, tech_stack, image_url, live_url, github_url, category)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(title, description, tech_stack, image_url, live_url, github_url, category);
      res.json({ ok: true, id: result.lastInsertRowid });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // PUT /api/projects/:id
  router.put('/:id', authCheck, (req, res) => {
    const { title, description, tech_stack, image_url, live_url, github_url, category } = projectPayload(req.body);
    if (!title) return res.status(400).json({ error: 'Sarlavha kiritilmagan' });
    try {
      const exists = db.prepare('SELECT id FROM projects WHERE id=?').get(req.params.id);
      if (!exists) return res.status(404).json({ error: 'Loyiha topilmadi' });
      db.prepare(`
        UPDATE projects SET
          title=?, description=?, tech_stack=?,
          image_url=?, live_url=?, github_url=?, category=?
        WHERE id=?
      `).run(title, description, tech_stack, image_url, live_url, github_url, category, req.params.id);
      res.json({ ok: true });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/projects/:id
  router.delete('/:id', authCheck, (req, res) => {
    try {
      const result = db.prepare('DELETE FROM projects WHERE id=?').run(req.params.id);
      if (result.changes === 0) return res.status(404).json({ error: 'Loyiha topilmadi' });
      res.json({ ok: true });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
