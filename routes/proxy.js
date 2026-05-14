const express = require('express');
const fetch   = require('node-fetch');
const fs      = require('fs');
const path    = require('path');
const db      = require('../db');

const router = express.Router();

const PROVIDERS = {
  groq: {
    type: 'openai',
    base_url: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile'
  },
  openai: {
    type: 'openai',
    base_url: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini'
  },
  gemini: {
    type: 'gemini',
    base_url: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash'
  },
  github: {
    type: 'github',
    base_url: 'https://models.github.ai/inference/chat/completions',
    model: 'openai/gpt-4.1'
  },
  xai: {
    type: 'openai',
    base_url: 'https://api.x.ai/v1',
    model: 'grok-4.20-reasoning'
  },
  compatible: {
    type: 'openai',
    base_url: '',
    model: ''
  }
};

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

function providerConfig(row) {
  const provider = row?.provider || 'groq';
  const preset = PROVIDERS[provider] || PROVIDERS.compatible;
  return {
    id: row?.id || null,
    provider,
    type: preset.type,
    key_value: row?.key_value || process.env.GROQ_API_KEY,
    base_url: row?.base_url || preset.base_url,
    model: row?.model || preset.model
  };
}

async function readProviderError(res) {
  const data = await res.json().catch(() => null);
  if (data?.error?.message) return data.error.message;
  if (data?.message) return data.message;
  return data ? JSON.stringify(data) : `HTTP ${res.status}`;
}

function openAIMessages(systemPrompt, history, userMsg) {
  return [
    { role: 'system', content: systemPrompt },
    ...history.map(h => ({
      role: h.role === 'bot' ? 'assistant' : h.role,
      content: h.content
    })),
    { role: 'user', content: userMsg }
  ];
}

function geminiMessages(systemPrompt, history, userMsg) {
  const contents = [];
  for (const h of history) {
    if (h.role === 'system') continue;
    contents.push({
      role: h.role === 'assistant' || h.role === 'bot' ? 'model' : 'user',
      parts: [{ text: h.content }]
    });
  }
  contents.push({ role: 'user', parts: [{ text: userMsg }] });
  return {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents
  };
}

async function callProviderStream(config, fullPrompt, history, userMsg, onChunk) {
  if (config.type === 'gemini') {
    const url = geminiEndpoint(config.base_url, config.model, 'streamGenerateContent') + '?alt=sse';
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.key_value
      },
      body: JSON.stringify({
        ...geminiMessages(fullPrompt, history, userMsg),
        generationConfig: { maxOutputTokens: 700, temperature: 0.7 }
      })
    });
    if (!r.ok) throw new Error(await readProviderError(r));

    let fullText = '';
    let buf = '';
    for await (const chunk of r.body) {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const json = JSON.parse(raw);
          const piece = (json.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
          if (piece) { fullText += piece; onChunk(piece); }
        } catch {}
      }
    }
    return fullText;
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.key_value}`
  };

  const body = {
    model: config.model,
    stream: true,
    messages: openAIMessages(fullPrompt, history, userMsg)
  };
  if (config.provider === 'openai') body.max_completion_tokens = 700;
  else { body.max_tokens = 700; body.temperature = 0.7; }

  const r = await fetch(config.type === 'github' ? config.base_url : chatEndpoint(config.base_url), {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(await readProviderError(r));

  let fullText = '';
  let buf = '';
  for await (const chunk of r.body) {
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === '[DONE]') continue;
      try {
        const json = JSON.parse(raw);
        const piece = json.choices?.[0]?.delta?.content || '';
        if (piece) { fullText += piece; onChunk(piece); }
      } catch {}
    }
  }
  return fullText;
}

// ── BILIM FAYLINI O'QI ────────────────────────
const MD_PATH = path.join(__dirname, '../knowledge/abdurahmon-knowledge.md');
const mdContent = fs.existsSync(MD_PATH) ? fs.readFileSync(MD_PATH, 'utf8') : '';

// ── KNOWLEDGE BASE QURISH ─────────────────────
function cleanMd(text) {
  return text
    .replace(/\|[-|: ]+\|/g, '')
    .replace(/^\s*>\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const SECTION_MAP = [
  { match: /SHAXSIY|👤/,            cat: 'shaxsiy', kw: 'ism kim yosh yoshingiz millat shahar holat shaxsiy' },
  { match: /TA.LIM|🎓/,             cat: 'talim',   kw: "qayerda oqiydi universitet talim fakultet kurs fanlar o'rganilgan" },
  { match: /TEXNIK|KO.NIKMA|💻/,    cat: 'skill',   kw: 'html css javascript python ai api konikma skill dasturlash texnik frontend backend' },
  { match: /TILLAR|🌐/,             cat: 'til',     kw: 'til ingliz rus uzbek biladi gapiradi language' },
  { match: /KONTAKT|📞/,            cat: 'kontakt', kw: 'email telegram telefon kontakt boglanish murojaat' },
  { match: /MAQSAD|MOTIVATSIYA|🎯/, cat: 'maqsad',  kw: "nima uchun bank stajerofka maqsad motivatsiya nega kelajak reja" },
  { match: /LOYIHA|💼/,             cat: 'loyiha',  kw: 'loyiha portfolio sayt yasagan texnologiya project' },
  { match: /XIZMAT|NARX|💰/,        cat: 'narx',    kw: "narx sayt landing korporativ do'kon ilova xizmat qancha" },
  { match: /KUCHLI|💪/,             cat: 'kuchli',  kw: 'nega tanlash afzallik kuchli yaxshi ijobiy strength' },
  { match: /ZAIF|⚠/,                cat: 'zaif',    kw: 'zaif kamchilik tajriba yoq muammo weakness' },
  { match: /TEZKOR JAVOB|🤔/,       cat: 'faq',     kw: 'nega tanlash tez organa ishlayoladi qancha vaqt' },
];

const SKILL_SUB = [
  { match: /^HTML/i,        kw: 'html html5 semantik forma media' },
  { match: /^CSS/i,         kw: 'css3 flexbox grid animatsiya responsive glassmorphism' },
  { match: /^JAVASCRIPT/i,  kw: 'javascript js dom event async fetch promise massiv' },
  { match: /^PYTHON/i,      kw: 'python backend script pip' },
  { match: /^AI KODLASH/i,  kw: 'ai kodlash copilot chatgpt claude vibe prompt engineering' },
  { match: /^AI API/i,      kw: 'ai api rest http json openai groq gemini endpoint' },
  { match: /^VOSITALAR/i,   kw: 'vscode git github devtools figma tools asbob' },
];

function buildKnowledgeBase(md) {
  if (!md) return [];
  const entries = [];
  const h2parts = md.split(/\n(?=## )/);
  for (const part of h2parts) {
    const lines = part.split('\n');
    const heading = lines[0].replace(/^#+\s*/, '').trim();
    const content = lines.slice(1).join('\n').trim();
    if (!content) continue;
    for (const s of SECTION_MAP) {
      if (s.match.test(heading)) {
        entries.push({ category: s.cat, question: s.kw, answer: cleanMd(content) });
        if (s.cat === 'skill') {
          const subs = content.split(/\n(?=#### )/);
          for (const sub of subs) {
            const sl = sub.split('\n');
            const sh = sl[0].replace(/^#+\s*/, '').trim();
            const sc = sl.slice(1).join('\n').trim();
            if (!sh || !sc) continue;
            for (const sk of SKILL_SUB) {
              if (sk.match.test(sh)) {
                entries.push({ category: 'skill', question: sk.kw, answer: cleanMd(sc) });
                break;
              }
            }
          }
        }
        break;
      }
    }
  }
  return entries;
}

const KNOWLEDGE_BASE = buildKnowledgeBase(mdContent);

// ── SYSTEM PROMPT ─────────────────────────────
const ABDURAHMON_FULL = mdContent
  ? '\n\n=== ABDURAHMON TO\'LIQ BILIM OMBORI ===\n' +
    mdContent
      .replace(/^# .+$/m, '')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/\|[-|: ]+\|/g, '')
      .replace(/^\s*>\s*/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  : '';

const SYSTEM_PROMPT = `
Sen Odilbekov Abdurahmonning shaxsiy AI yordamchisisan.
Sening vazifang: Abdurahmon haqida so'ralgan ma'lumotni aniq va samimiy berish.
FAQAT o'zbek tilida gaplash.

ROL QOIDALARI:
- "kimsan", "o'zingni tanishtir" savolida: "Men Abdurahmonning shaxsiy AI yordamchisiman. Ta'limi, ko'nikmalari, loyihalari, xizmatlari va kontaktlari haqida savol bera olasiz." deb javob ber.
- O'zingni Abdurahmon deb ko'rsatma. "Abdurahmon 20 yoshda" de, "Men 20 yoshdaman" dema.
- Faqat bilim omborida bor ma'lumotga tayan. Aniq ma'lumot yo'q bo'lsa, "Bu haqda ma'lumotim yo'q" de.
- Abdurahmonni maqtama, ortiqcha ta'riflar ishlatma. Faqat faktlarni ayt.
- Raqam, foiz, telefon, email, narx va universitet ma'lumotlarini o'zgartirma.

USLUB:
- Samimiy va oddiy gaplash — na sovuq, na haddan tashqari iliq
- Salom → faqat salom qaytarish
- Oddiy savol → 1-3 gap
- Texnik savol → qisqa ro'yxat
- Narx savoli → avval qanday sayt kerakligini so'ra, keyin narx ayt
- Hech qachon hamma narsani birdan yozma, faqat so'ralgan narsani yoz
- Ro'yxat: max 5 element

FORMAT:
- Markdown ishlat (**, -, ###)
- Emoji faqat sarlavhada

═══════════════════════════════
JAVOB NAMUNALARI
═══════════════════════════════

SAVOL: "salom"
JAVOB: "Salom! Abdurahmon haqida savol bering."

SAVOL: "kimsan?"
JAVOB: "Men Abdurahmonning shaxsiy AI yordamchisiman. Ta'limi, ko'nikmalari, loyihalari, xizmatlari va kontaktlari haqida savol bera olasiz."

SAVOL: "necha yosh"
JAVOB: "20 yoshda, Toshkentda yashaydi."

SAVOL: "skilllar?"
JAVOB:
**Frontend**
- HTML5 · 75%
- CSS3 · 70%
- JavaScript · 55%

**AI & Dasturlash**
- AI Kodlash · 60%
- Python · 40%

SAVOL: "html bilasizmi"
JAVOB: "HTML5 ni 75% darajasida biladi. Semantik teglar, formalar, responsive sahifalar."

SAVOL: "kontakt"
JAVOB:
📧 uzcoin23@gmail.com
✈️ @AT12423
📱 +998 93 548 1500

SAVOL: "sayt narxi"
JAVOB: "Qanday sayt kerak? Landing, korporativ yoki do'konmi?"

SAVOL: (narx turi aytilgandan keyin)
JAVOB: "Taxminan 300,000–1,200,000 so'm. Muddati 3–7 kun. Batafsil: @AT12423"

SAVOL: "nega uni tanlash kerak"
JAVOB: "Bu sizning qaroringiz. Qisqacha ma'lumot: HTML, CSS, JS va AI API bilan ishlaydi, portfolio loyihalari bor, bank AI bo'limida stajerofka izlayapti."

═══════════════════════════════
MA'LUMOTLAR
═══════════════════════════════

SHAXSIY:
- Ism: Odilbekov Abdurahmon, 20 yosh
- Shahar: Toshkent, O'zbekiston

TA'LIM:
- TIU — Biznes va Innovatsion Ta'lim
- Axborot tizimlari va texnologiyalari
- 2-kurs (2023 — hozir)
- Fanlar: Dasturlash, Ma'lumotlar tuzilmasi, Axborot tizimlari, Matematik tahlil, DB

KONTAKT:
- Email: uzcoin23@gmail.com
- Telegram: @AT12423
- Tel: +998 93 548 1500

SKILLLAR:
- HTML5 (75%): semantik, form, media, responsive, SEO, accessibility
- CSS3 (70%): Flexbox, Grid, animatsiya, media query, glassmorphism, gradient
- JavaScript (55%): DOM, event, fetch, async/await, JSON, massiv metodlari
- Python (40%): o'zgaruvchilar, tsikllar, funksiyalar, list/dict
- AI Kodlash (60%): Copilot, ChatGPT, Claude, prompt engineering, vibe coding
- AI API (45%): REST, HTTP, Claude/GPT/Gemini/Groq API integratsiya

MAQSAD: Bank AI bo'limida stajerofka

KUCHLI TOMONLARI:
- AI vositalar bilan samarali ishlash
- Tez o'rganish, mustaqillik
- Portfolio bilan bilimini ko'rsatgan
- 20 yosh — yangi texnologiyalarga ochiq

ZAIF TOMONLARI (so'ralganda halol ayt):
- Python hali boshlang'ich
- Korporativ tajriba yo'q

XIZMAT NARXLARI (avval qanday sayt kerakligini so'ra, keyin narx ayt):
- Landing (1 sahifa): 300k–2.5M so'm
- Korporativ (5-10 sahifa): 1M–8M so'm
- Do'kon: 2.5M–10M so'm
- Portfolio: 400k–2M so'm
- Mobil ilova: 3M–15M+ so'm
- AI chatbot qo'shish: +500k–1.5M so'm

Buyurtma: @AT12423 Telegram
${ABDURAHMON_FULL}`;

// ── KNOWLEDGE SEARCH ──────────────────────────
function searchKnowledge(query) {
  const SUFFIXES = ['larni', 'lardan', 'larda', 'larga', 'larning', 'ning', 'dan', 'lar', 'ni', 'da', 'ga'];
  const words = query.toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2)
    .map(w => {
      for (const s of SUFFIXES) {
        if (w.endsWith(s) && w.length - s.length >= 3) return w.slice(0, w.length - s.length);
      }
      return w;
    });

  let best = null, bestScore = 0;
  for (const item of KNOWLEDGE_BASE) {
    const kw = item.question.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (kw.includes(w)) score++;
    }
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return bestScore > 0 ? best : null;
}

// ── DB FUNKSIYALAR (synchronous) ──────────────
function saveMsg(sid, role, content) {
  db.prepare('INSERT INTO conversations (session_id, role, content) VALUES (?, ?, ?)').run(sid, role, content);
  const toDelete = db.prepare(
    'SELECT id FROM conversations WHERE session_id=? ORDER BY id DESC LIMIT -1 OFFSET 20'
  ).all(sid).map(r => r.id);
  if (toDelete.length) {
    const placeholders = toDelete.map(() => '?').join(',');
    db.prepare(`DELETE FROM conversations WHERE id IN (${placeholders})`).run(...toDelete);
  }
}

function getHistory(sid) {
  return db.prepare(
    'SELECT role, content FROM conversations WHERE session_id=? ORDER BY id DESC LIMIT 10'
  ).all(sid).reverse();
}

function extractMemory(sid, message) {
  const patterns = [
    { regex: /mening ismim\s+(\S+)/i,     key: 'user_name' },
    { regex: /men\s+(.+?)\s+izlayapman/i, key: 'user_goal' },
    { regex: /biznesim\s+(.+)/i,          key: 'business'  },
    { regex: /kompaniyam\s+(.+)/i,        key: 'company'   }
  ];
  for (const p of patterns) {
    const match = message.match(p.regex);
    if (match) {
      db.prepare(
        'INSERT OR REPLACE INTO user_memory (session_id, key_info, value) VALUES (?, ?, ?)'
      ).run(sid, p.key, match[1].trim());
    }
  }
}

function getMemories(sid) {
  return db.prepare('SELECT key_info, value FROM user_memory WHERE session_id=?').all(sid);
}

// ── ENDPOINT ──────────────────────────────────
router.post('/', async (req, res) => {
  const { messages, sessionId } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || typeof lastMessage.content !== 'string' || !lastMessage.content.trim()) {
    return res.status(400).json({ error: 'message content required' });
  }

  const sid     = String(sessionId || 'default').slice(0, 120);
  const userMsg = lastMessage.content.trim().slice(0, 4000);

  try {
    saveMsg(sid, 'user', userMsg);
    extractMemory(sid, userMsg);

    const knowledge = searchKnowledge(userMsg);
    const memories  = getMemories(sid);
    const history   = getHistory(sid);

    const memCtx = memories.length
      ? '\nFOYDALANUVCHI HAQIDA:\n' + memories.map(m => `${m.key_info}: ${m.value}`).join('\n')
      : '';
    const knwCtx = knowledge
      ? `\nJORIY SAVOL UCHUN ANIQ MA'LUMOT (${knowledge.category}):\n${knowledge.answer}`
      : '';

    const fullPrompt = SYSTEM_PROMPT + memCtx + knwCtx;

    // Faol kalitni DB dan ol, .env fallback
    const activeKey = providerConfig(
      db.prepare('SELECT id, provider, base_url, model, key_value FROM api_keys WHERE is_active = 1').get()
    );

    if (!activeKey.key_value) {
      return res.status(500).json({ error: 'API kalit sozlanmagan. Admin paneldan kalit qo\'shing.' });
    }
    if (!activeKey.base_url || !activeKey.model) {
      return res.status(500).json({ error: 'Aktiv API kalit uchun base URL yoki model sozlanmagan.' });
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (req.socket) req.socket.setNoDelay(true);
    res.flushHeaders();

    let fullText = '';
    try {
      fullText = await callProviderStream(activeKey, fullPrompt, history, userMsg, (piece) => {
        res.write(`data: ${JSON.stringify({ d: piece })}\n\n`);
      });
      if (!fullText) {
        res.write(`data: ${JSON.stringify({ d: 'Javob ololmadim.' })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      const cleaned = fullText
        .replace(/^(Abdurahmon\s+quyidagi[^:]*:?\s*)/gi, '')
        .replace(/(Abdurahmon\s+){2,}/gi, 'U ')
        .replace(/Agar sizga[^]*?@AT12423[^.]*/gi, '')
        .replace(/\s*[😊🙂👍✨]+\s*$/g, '')
        .trim();
      try { saveMsg(sid, 'assistant', cleaned || 'Javob ololmadim.'); } catch {}
      res.end();
    } catch (e) {
      res.write(`data: ${JSON.stringify({ error: e.message || 'AI provider xatosi' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }

  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  }
});

module.exports = router;
