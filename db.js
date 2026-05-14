const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'db.sqlite'));

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token      TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    description TEXT,
    tech_stack  TEXT,
    image_url   TEXT,
    live_url    TEXT,
    github_url  TEXT,
    category    TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    role       TEXT,
    content    TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_memory (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    key_info   TEXT,
    value      TEXT,
    UNIQUE(session_id, key_info)
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    label       TEXT NOT NULL DEFAULT 'Key',
    provider    TEXT NOT NULL DEFAULT 'groq',
    base_url    TEXT,
    model       TEXT,
    key_value   TEXT NOT NULL UNIQUE,
    is_active   INTEGER NOT NULL DEFAULT 0,
    limit_total INTEGER NOT NULL DEFAULT 100000,
    limit_used  INTEGER NOT NULL DEFAULT 0,
    limit_reset TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

function ensureColumn(table, name, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === name)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`).run();
  }
}

ensureColumn('api_keys', 'provider', "TEXT NOT NULL DEFAULT 'groq'");
ensureColumn('api_keys', 'base_url', 'TEXT');
ensureColumn('api_keys', 'model', 'TEXT');

db.prepare(`
  UPDATE api_keys
  SET provider = COALESCE(NULLIF(provider, ''), 'groq'),
      base_url = COALESCE(NULLIF(base_url, ''), 'https://api.groq.com/openai/v1'),
      model = COALESCE(NULLIF(model, ''), 'llama-3.3-70b-versatile')
`).run();

// .env dagi keylarni avtomatik qo'shish (agar DB da yo'q bo'lsa)
const envKeys = [
  {
    env: process.env.GROQ_API_KEY,
    label: '.env Groq kalit',
    provider: 'groq',
    base_url: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile'
  },
  {
    env: process.env.XAI_API_KEY,
    label: 'xAI Grok kalit',
    provider: 'xai',
    base_url: 'https://api.x.ai/v1',
    model: 'grok-4.20-reasoning'
  }
];

for (const k of envKeys) {
  if (!k.env) continue;
  const existing = db.prepare('SELECT id FROM api_keys WHERE key_value = ?').get(k.env);
  if (!existing) {
    const hasActive = db.prepare('SELECT id FROM api_keys WHERE is_active = 1').get();
    db.prepare('INSERT INTO api_keys (label, provider, base_url, model, key_value, is_active) VALUES (?, ?, ?, ?, ?, ?)')
      .run(k.label, k.provider, k.base_url, k.model, k.env, hasActive ? 0 : 1);
  }
}

module.exports = db;
