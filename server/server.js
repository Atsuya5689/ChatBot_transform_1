// server/server.js
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import fetch from 'node-fetch';

const app = express();

/* ---------------- security / basics ---------------- */
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.json({ limit: '1mb' }));

/* ---------------- health ---------------- */
app.get('/api/health', (_req, res) => res.json({ ok: true }));

/* ---------------- CORS（全パス・手動・確実） ----------------
 * - .env: ALLOWED_ORIGIN="https://chatbot-transform-1.onrender.com"
 * - 末尾スラ無しで一致判定。許可Originには必ずACAOを付与
 * - OPTIONSは必ず204で必要ヘッダを返す
 */
const ALLOWED = (process.env.ALLOWED_ORIGIN || 'http://localhost:5500')
  .split(',')
  .map(s => s.trim().replace(/\/+$/,'').toLowerCase())
  .filter(Boolean);

console.log('✅ Allowed origins:', ALLOWED.join(', ') || '(none)');

app.use((req, res, next) => {
  const raw = req.headers.origin || '';
  const norm = raw.replace(/\/+$/,'').toLowerCase();
  const isAllowed = !!raw && ALLOWED.includes(norm);

  // 許可Originには常に付与
  if (isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', raw); // そのまま返す
    res.setHeader('Vary', 'Origin');
  }

  // プリフライトをここで完了
  if (req.method === 'OPTIONS') {
    if (isAllowed) {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      return res.status(204).end();
    }
    return res.status(403).end();
  }

  next();
});

/* ---------------- rate limit（APIだけ） ---------------- */
app.use('/api/', rateLimit({ windowMs: 60_000, max: 30 }));

/* ---------------- API keys ---------------- */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.warn('⚠️  OPENAI_API_KEY is not set. Set it in Render Web Service env.');
}

/* ---------------- summarize ---------------- */
app.post('/api/summarize', async (req, res) => {
  try {
    const msgs = (req.body?.messages || [])
      .slice(-10)
      .map((m) => `- ${m.role}: ${m.text}`)
      .join('\n');

    const payload = {
      model: 'gpt-4o-mini',
      temperature: 0.4,
      messages: [
        {
          role: 'system',
          content:
            'Summarize the last 10 chat turns and respond ONLY with:\n' +
            'Topics: <comma-separated>\n' +
            'Sentiment: <positive|neutral|negative>\n' +
            'Style hint: <short clothing/accessory hint>',
        },
        { role: 'user', content: msgs },
      ],
    };

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const bodyText = await r.text();

    if (r.status === 429) {
      console.warn('[summarize] 429 rate-limited');
      return res.json({
        topics: 'casual',
        sentiment: 'neutral',
        hint: 'neutral casual',
        raw: 'fallback:429',
      });
    }
    if (!r.ok) {
      console.error('[summarize] OpenAI error:', bodyText);
      return res.status(r.status).json({ error: 'openai_error', detail: bodyText });
    }

    const data = JSON.parse(bodyText);
    const content = data.choices?.[0]?.message?.content || '';

    const topics = /Topics:\s*(.*)/i.exec(content)?.[1]?.trim() || 'casual';
    const sentiment = /Sentiment:\s*(.*)/i.exec(content)?.[1]?.trim() || 'neutral';
    const hint = /Style hint:\s*(.*)/i.exec(content)?.[1]?.trim() || 'neutral casual';

    res.json({ topics, sentiment, hint, raw: content });
  } catch (e) {
    console.error('[summarize] server error:', e);
    res.status(500).json({ error: 'server_error', detail: String(e) });
  }
});

/* ---------------- generate avatar ---------------- */
app.post('/api/generate-avatar', async (req, res) => {
  try {
    const hint = req.body?.hint;
    if (!hint || typeof hint !== 'string') {
      return res.status(400).json({ error: 'bad_request', detail: 'hint must be a string' });
    }

    const prompt =
      `Waist-up avatar on a dark background. Keep the same neutral face/identity.\n` +
      `Change ONLY clothing/accessories to: ${hint}.\n` +
      `Clean flat style, centered, high-contrast, no text.`;

    const payload = { model: 'gpt-image-1', prompt, size: '1024x1024' };

    const r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Organization': process.env.ORG_ID,
      },
      body: JSON.stringify(payload),
    });

    const bodyText = await r.text();
    if (!r.ok) {
      console.error('[generate-avatar] OpenAI error:', bodyText);
      return res.status(r.status).json({ error: 'openai_error', detail: bodyText });
    }

    let data; try { data = JSON.parse(bodyText); } catch { data = {}; }
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) return res.status(502).json({ error: 'no_image' });

    res.json({ dataUrl: `data:image/png;base64,${b64}` });
  } catch (e) {
    console.error('[generate-avatar] server error:', e);
    res.status(500).json({ error: 'server_error', detail: String(e) });
  }
});

/* ---------------- chat (60文字以内の雑談) ---------------- */
app.post('/api/chat', async (req, res) => {
  try {
    const msgs = (req.body?.messages || [])
      .slice(-10)
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text }));

    const payload = {
      model: 'gpt-4o-mini',
      temperature: 0.8,
      max_tokens: 80,
      messages: [
        {
          role: 'system',
          content: [
            'あなたはフレンドリーでくだけた雑談相手。',
            'カジュアルで自然体、型にはめすぎない。',
            '絵文字はユーザーが使った時だけ軽く返す。',
            '必ず60文字以内に収める。'
          ].join('\n')
        },
        ...msgs
      ]
    };

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify(payload),
    });

    const bodyText = await r.text();
    if (r.status === 429) return res.json({ reply: 'ちょっと待って、今混み合ってるみたい。' });
    if (!r.ok) {
      console.error('[chat] OpenAI error:', bodyText);
      return res.status(r.status).json({ error: 'openai_error', detail: bodyText });
    }

    const data = JSON.parse(bodyText);
    let reply = data.choices?.[0]?.message?.content?.trim() || 'うん、わかったよ。';
    if (reply.length > 60) reply = reply.slice(0, 60);
    res.json({ reply });
  } catch (e) {
    console.error('[chat] server error:', e);
    res.status(500).json({ error: 'server_error', detail: String(e) });
  }
});

/* ---------------- start ---------------- */
const PORT = Number(process.env.PORT || 8787);
app.listen(PORT, () => {
  console.log(`✅ API listening on http://localhost:${PORT}`);
  console.log(`   Allowed origins: ${ALLOWED.join(', ') || '(none)'}`);
});
