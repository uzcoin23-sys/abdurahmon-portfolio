require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const crypto  = require('crypto');
const db      = require('./db');

const app = express();

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 kun

const sessions = {
  has(token) {
    const row = db.prepare('SELECT created_at FROM admin_sessions WHERE token = ?').get(token);
    if (!row) return false;
    if (Date.now() - row.created_at > SESSION_TTL_MS) {
      db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
      return false;
    }
    return true;
  },
  set(token) {
    db.prepare('DELETE FROM admin_sessions WHERE created_at < ?').run(Date.now() - SESSION_TTL_MS);
    db.prepare('INSERT OR REPLACE INTO admin_sessions (token, created_at) VALUES (?, ?)').run(token, Date.now());
  },
  delete(token) {
    db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
  }
};

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Admin auth ──
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!process.env.ADMIN_PASS) {
    return res.status(500).json({ ok: false, error: 'ADMIN_PASS sozlanmagan' });
  }
  if (typeof password === 'string' && password === process.env.ADMIN_PASS) {
    const token = crypto.randomUUID();
    sessions.set(token);
    res.json({ ok: true, token });
  } else {
    res.status(401).json({ ok: false, error: "Noto'g'ri parol" });
  }
});

app.post('/api/admin/logout', (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

// ── API routes ──
app.use('/api/projects',   require('./routes/projects')(sessions));
app.use('/api/admin/keys', require('./routes/apikeys')(sessions));
app.use('/api/chat',       require('./routes/proxy'));

// ── SPA fallback ──
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'portfolio.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server    → http://localhost:${PORT}`);
  console.log(`Admin     → http://localhost:${PORT}/admin.html`);
});
