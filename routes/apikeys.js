const express = require('express');
const fetch = require('node-fetch');
const db = require('../db');

const PROVIDERS = {
  groq: {
    label: 'Groq',
    type: 'openai',
    base_url: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile'
  },
  openai: {
    label: 'OpenAI',
    type: 'openai',
    base_url: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini'
  },
  gemini: {
    label: 'Gemini',
    type: 'gemini',
    base_url: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash'
  },
  github: {
    label: 'GitHub Models',
    type: 'github',
    base_url: 'https://models.github.ai/inference/chat/completions',
    model: 'openai/gpt-4.1'
  },
  xai: {
    label: 'xAI / Grok',
    type: 'openai',
    base_url: 'https://api.x.ai/v1',
    model: 'grok-4.20-reasoning'
  },
  compatible: {
    label: 'OpenAI-compatible',
    type: 'openai',
    base_url: '',
    model: ''
  }
};

module.exports = function(sessions) {
  const router = express.Router();

  function authCheck(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (!token || !sessions.has(token)) {
      return res.status(401).json({ error: "Ruxsat yo'q" });
    }
    next();
  }

  function detectProvider(keyValue, baseUrl = '') {
    const key = String(keyValue || '');
    const url = String(baseUrl || '').toLowerCase();

    if (key.startsWith('gsk_') || url.includes('groq.com')) return 'groq';
    if (key.startsWith('AIza') || url.includes('generativelanguage.googleapis.com')) return 'gemini';
    if (/^(github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)/.test(key) || url.includes('models.github.ai')) return 'github';
    if (key.startsWith('xai-') || url.includes('api.x.ai')) return 'xai';
    if (key.startsWith('sk-') || key.startsWith('sk-proj-') || url.includes('api.openai.com')) return 'openai';
    return 'compatible';
  }

  function normalizeBaseUrl(provider, baseUrl) {
    const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
    const preset = PROVIDERS[provider] || PROVIDERS.compatible;
    const value = raw || preset.base_url;

    if (provider === 'github') return value || PROVIDERS.github.base_url;
    if (provider === 'gemini') return value || PROVIDERS.gemini.base_url;
    return value;
  }

  function normalizeConfig(body = {}) {
    const keyValue = String(body.key_value || '').trim();
    const requestedProvider = String(body.provider || 'auto').trim().toLowerCase();
    const provider = requestedProvider && requestedProvider !== 'auto'
      ? (PROVIDERS[requestedProvider] ? requestedProvider : 'compatible')
      : detectProvider(keyValue, body.base_url);
    const preset = PROVIDERS[provider] || PROVIDERS.compatible;
    const baseUrl = normalizeBaseUrl(provider, body.base_url);
    const model = String(body.model || '').trim() || preset.model;

    if (!keyValue) throw new Error('API key kiritilmagan');
    if (!baseUrl) throw new Error('Bu API uchun base URL yoki endpoint kerak');
    if (!model) throw new Error('Bu API uchun model nomi kerak');

    return {
      provider,
      provider_label: preset.label,
      provider_type: preset.type,
      base_url: baseUrl,
      model,
      key_value: keyValue,
      label: String(body.label || '').trim() || `${preset.label} kalit`,
      make_active: Boolean(body.make_active)
    };
  }

  function chatEndpoint(baseUrl) {
    const url = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(url)) return url;
    return `${url}/chat/completions`;
  }

  function geminiEndpoint(baseUrl, model, action = 'generateContent') {
    const root = String(baseUrl || PROVIDERS.gemini.base_url).trim().replace(/\/+$/, '');
    const cleanModel = String(model || PROVIDERS.gemini.model).replace(/^models\//, '');
    return `${root}/models/${encodeURIComponent(cleanModel)}:${action}`;
  }

  function extractOpenAILimits(res) {
    const total = parseInt(res.headers.get('x-ratelimit-limit-tokens') || '0', 10);
    const remaining = parseInt(res.headers.get('x-ratelimit-remaining-tokens') || '0', 10);
    const reset = res.headers.get('x-ratelimit-reset-tokens') || res.headers.get('x-ratelimit-reset-requests') || null;
    if (!total) {
      return { total: 100000, used: 0, remaining: 100000, reset };
    }
    return {
      total,
      used: Math.max(0, total - (Number.isFinite(remaining) ? remaining : total)),
      remaining: Number.isFinite(remaining) ? remaining : total,
      reset
    };
  }

  async function readError(res) {
    const data = await res.json().catch(() => null);
    if (data?.error?.message) return data.error.message;
    if (data?.message) return data.message;
    const text = data ? JSON.stringify(data) : await res.text().catch(() => '');
    return text || `HTTP ${res.status}`;
  }

  async function fetchKeyInfo(config) {
    if (config.provider_type === 'gemini') {
      const res = await fetch(geminiEndpoint(config.base_url, config.model), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': config.key_value
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
          generationConfig: { maxOutputTokens: 1 }
        })
      });

      if (!res.ok) return { valid: false, error: await readError(res) };
      return { valid: true, rate_limited: false, total: 100000, used: 0, remaining: 100000, reset: null };
    }

    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.key_value}`
    };

    const body = {
      model: config.model,
      stream: false,
      messages: [{ role: 'user', content: 'hi' }]
    };
    if (config.provider === 'openai') body.max_completion_tokens = 1;
    else body.max_tokens = 1;

    const res = await fetch(config.provider_type === 'github' ? config.base_url : chatEndpoint(config.base_url), {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (res.status === 429) {
      const msg = await readError(res);
      const m = msg.match(/Limit (\d+), Used (\d+)/);
      const total = m ? parseInt(m[1], 10) : 100000;
      const used = m ? parseInt(m[2], 10) : total;
      return { valid: true, rate_limited: true, total, used, remaining: Math.max(0, total - used), reset: null };
    }
    if (!res.ok) return { valid: false, error: await readError(res) };

    return { valid: true, rate_limited: false, ...extractOpenAILimits(res) };
  }

  router.get('/', authCheck, (req, res) => {
    try {
      const keys = db.prepare(`
        SELECT id, label, provider, base_url, model, key_value, is_active,
               limit_total, limit_used, limit_reset, created_at
        FROM api_keys
        ORDER BY id ASC
      `).all();
      const masked = keys.map(k => ({
        ...k,
        provider_label: PROVIDERS[k.provider]?.label || k.provider || 'API',
        key_masked: k.key_value.slice(0, 10) + '...' + k.key_value.slice(-4),
        key_value: undefined
      }));
      res.json(masked);
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/', authCheck, async (req, res) => {
    let config;
    try {
      config = normalizeConfig(req.body);
      const info = await fetchKeyInfo(config);
      if (!info.valid) {
        return res.status(400).json({ error: `API kalit yaroqsiz (${info.error || "tekshiruvdan o'tmadi"})` });
      }

      const hasActive = db.prepare('SELECT id FROM api_keys WHERE is_active = 1').get();
      const shouldActivate = config.make_active || !hasActive ? 1 : 0;
      if (shouldActivate) db.prepare('UPDATE api_keys SET is_active = 0').run();

      const result = db.prepare(`
        INSERT OR IGNORE INTO api_keys
          (label, provider, base_url, model, key_value, is_active, limit_total, limit_used, limit_reset)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        config.label,
        config.provider,
        config.base_url,
        config.model,
        config.key_value,
        shouldActivate,
        info.total,
        info.used,
        info.reset
      );

      if (result.changes === 0) {
        return res.status(400).json({ error: 'Bu kalit allaqachon mavjud' });
      }

      res.json({ ok: true, id: result.lastInsertRowid, provider: config.provider, info });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put('/:id', authCheck, async (req, res) => {
    try {
      const row = db.prepare('SELECT id, label, provider, base_url, model, key_value FROM api_keys WHERE id = ?').get(req.params.id);
      if (!row) return res.status(404).json({ error: 'Kalit topilmadi' });

      const requestedProvider = String(req.body.provider || 'auto').trim().toLowerCase();
      const provider = requestedProvider && requestedProvider !== 'auto'
        ? (PROVIDERS[requestedProvider] ? requestedProvider : 'compatible')
        : row.provider;
      const preset = PROVIDERS[provider] || PROVIDERS.compatible;
      const base_url = normalizeBaseUrl(provider, req.body.base_url || row.base_url);
      const model = String(req.body.model || '').trim() || row.model || preset.model;
      const label = String(req.body.label || '').trim() || row.label || `${preset.label} kalit`;
      const newKeyValue = String(req.body.key_value || '').trim();
      const make_active = Boolean(req.body.make_active);

      if (!base_url) return res.status(400).json({ error: 'Bu API uchun base URL kerak' });
      if (!model) return res.status(400).json({ error: 'Bu API uchun model nomi kerak' });

      if (make_active) {
        db.prepare('UPDATE api_keys SET is_active = 0').run();
      }

      if (newKeyValue) {
        db.prepare(`UPDATE api_keys SET label=?, provider=?, base_url=?, model=?, key_value=?, is_active=? WHERE id=?`)
          .run(label, provider, base_url, model, newKeyValue, make_active ? 1 : 0, row.id);
      } else {
        db.prepare(`UPDATE api_keys SET label=?, provider=?, base_url=?, model=?, is_active=? WHERE id=?`)
          .run(label, provider, base_url, model, make_active ? 1 : 0, row.id);
      }

      res.json({ ok: true });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.put('/:id/activate', authCheck, (req, res) => {
    try {
      const existing = db.prepare('SELECT id FROM api_keys WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Kalit topilmadi' });
      db.prepare('UPDATE api_keys SET is_active = 0').run();
      db.prepare('UPDATE api_keys SET is_active = 1 WHERE id = ?').run(req.params.id);
      res.json({ ok: true });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post('/:id/check', authCheck, async (req, res) => {
    try {
      const row = db.prepare(`
        SELECT id, provider, base_url, model, key_value
        FROM api_keys
        WHERE id = ?
      `).get(req.params.id);
      if (!row) return res.status(404).json({ error: 'Kalit topilmadi' });

      const preset = PROVIDERS[row.provider] || PROVIDERS.compatible;
      const info = await fetchKeyInfo({
        ...row,
        provider_label: preset.label,
        provider_type: preset.type,
        base_url: normalizeBaseUrl(row.provider, row.base_url),
        model: row.model || preset.model
      });
      if (!info.valid) {
        return res.status(400).json({ error: `Kalit yaroqsiz (${info.error || "tekshiruvdan o'tmadi"})` });
      }

      db.prepare('UPDATE api_keys SET limit_total=?, limit_used=?, limit_reset=? WHERE id=?')
        .run(info.total, info.used, info.reset, row.id);

      res.json({ ok: true, ...info });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.delete('/:id', authCheck, (req, res) => {
    try {
      const key = db.prepare('SELECT is_active FROM api_keys WHERE id = ?').get(req.params.id);
      if (!key) return res.status(404).json({ error: 'Kalit topilmadi' });
      if (key.is_active) return res.status(400).json({ error: "Faol kalitni o'chirib bo'lmaydi" });
      db.prepare('DELETE FROM api_keys WHERE id = ?').run(req.params.id);
      res.json({ ok: true });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
