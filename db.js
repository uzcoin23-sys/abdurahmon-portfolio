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

// Kalit turini avtomatik aniqlash
function detectProvider(key) {
  if (!key) return null;
  if (key.startsWith('gsk_'))                                    return { provider: 'groq',   base_url: 'https://api.groq.com/openai/v1',                              model: 'llama-3.3-70b-versatile' };
  if (key.startsWith('AIza'))                                    return { provider: 'gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta',             model: 'gemini-2.5-flash' };
  if (/^(github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)/.test(key))     return { provider: 'github', base_url: 'https://models.github.ai/inference/chat/completions',          model: 'openai/gpt-4.1' };
  if (key.startsWith('xai-'))                                    return { provider: 'xai',    base_url: 'https://api.x.ai/v1',                                         model: 'grok-3-mini' };
  if (key.startsWith('sk-'))                                     return { provider: 'openai', base_url: 'https://api.openai.com/v1',                                   model: 'gpt-4.1-mini' };
  return null;
}

// Env dagi kalitlar — server qayta ishga tushganda ham saqlanadi
const envKeys = [
  { env: process.env.ACTIVE_API_KEY,  label: 'Asosiy kalit',   forceActive: true  },
  { env: process.env.GROQ_API_KEY,    label: 'Groq kalit',     forceActive: false },
  { env: process.env.XAI_API_KEY,     label: 'xAI kalit',      forceActive: false },
  { env: process.env.GITHUB_TOKEN,    label: 'GitHub kalit',   forceActive: false },
  { env: process.env.GEMINI_API_KEY,  label: 'Gemini kalit',   forceActive: false },
  { env: process.env.OPENAI_API_KEY,  label: 'OpenAI kalit',   forceActive: false },
];

for (const k of envKeys) {
  if (!k.env) continue;
  const info = detectProvider(k.env);
  if (!info) continue;

  const existing = db.prepare('SELECT id, is_active FROM api_keys WHERE key_value = ?').get(k.env);
  if (existing) {
    // Kalit bor — agar forceActive bo'lsa doim aktiv qil
    if (k.forceActive) {
      db.prepare('UPDATE api_keys SET is_active = 0').run();
      db.prepare('UPDATE api_keys SET is_active = 1 WHERE id = ?').run(existing.id);
    }
  } else {
    // Kalit yo'q — qo'sh
    const hasActive = db.prepare('SELECT id FROM api_keys WHERE is_active = 1').get();
    const makeActive = k.forceActive ? 1 : (hasActive ? 0 : 1);
    if (k.forceActive) db.prepare('UPDATE api_keys SET is_active = 0').run();
    db.prepare('INSERT INTO api_keys (label, provider, base_url, model, key_value, is_active) VALUES (?, ?, ?, ?, ?, ?)')
      .run(k.label, info.provider, info.base_url, info.model, k.env, makeActive);
  }
}

module.exports = db;
