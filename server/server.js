// server/server.js
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import fetch from 'node-fetch';

const app = express();

/* ---------- CORS最優先（全レス/全エラーで必ず付与） ---------- */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');               // ★これを最優先で常に付与
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ---------- ログ（到達確認） ---------- */
app.use((req, _res, next) => {
  console.log(`[IN] ${req.method} ${req.originalUrl}`);
  next();
});

/* ---------- セキュリティ/パーサ ---------- */
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.text({ type: 'text/plain', limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

/* ---------- ヘルス & 診断 ---------- */
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/cors-test', (_req, res) => res.json({ ok: true, msg: 'cors-ok' }));

/* ---------- レート制限（APIのみ） ---------- */
app.use('/api/', rateLimit({ windowMs: 60_000, max: 30 }));

/* ---------- OpenAIキー ---------- */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) console.warn('⚠️ OPENAI_API_KEY not set');

/* ---------- summarize ---------- */
app.post('/api/summarize', async (req, res) => {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const msgs = (body.messages || []).slice(-10).map(m => `- ${m.role}: ${m.text}`).join('\n');

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', Authorization:`Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model:'gpt-4o-mini', temperature:0.4,
        messages:[
          { role:'system', content:
            'Summarize the last 10 chat turns and respond ONLY with:\n' +
            'Topics: <comma-separated>\nSentiment: <positive|neutral|negative>\n' +
            'Style hint: <short clothing/accessory hint>' },
          { role:'user', content: msgs }
        ]
      })
    });

    const tx = await r.text();
    if (r.status === 429) return res.json({ topics:'casual', sentiment:'neutral', hint:'neutral casual', raw:'fallback:429' });
    if (!r.ok) return res.status(r.status).json({ error:'openai_error', detail: tx });

    const data = JSON.parse(tx);
    const content = data.choices?.[0]?.message?.content || '';
    const topics = /Topics:\s*(.*)/i.exec(content)?.[1]?.trim() || 'casual';
    const sentiment = /Sentiment:\s*(.*)/i.exec(content)?.[1]?.trim() || 'neutral';
    const hint = /Style hint:\s*(.*)/i.exec(content)?.[1]?.trim() || 'neutral casual';
    res.json({ topics, sentiment, hint, raw: content });
  } catch (e) { res.status(500).json({ error:'server_error', detail:String(e) }); }
});

/* ---------- generate avatar ---------- */
app.post('/api/generate-avatar', async (req, res) => {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const hint = body?.hint;
    if (!hint || typeof hint !== 'string') return res.status(400).json({ error:'bad_request', detail:'hint must be a string' });

    const r = await fetch('https://api.openai.com/v1/images/generations', {
      method:'POST',
      headers: {
        'Content-Type':'application/json',
        Authorization:`Bearer ${OPENAI_API_KEY}`,
        ...(process.env.ORG_ID ? { 'OpenAI-Organization': process.env.ORG_ID } : {})
      },
      body: JSON.stringify({
        model:'gpt-image-1',
        prompt:
          `Waist-up avatar on a dark background. Keep the same neutral face/identity.\n` +
          `Change ONLY clothing/accessories to: ${hint}.\n` +
          `Clean flat style, centered, high-contrast, no text.`,
        size:'1024x1024'
      })
    });

    const tx = await r.text();
    if (!r.ok) return res.status(r.status).json({ error:'openai_error', detail: tx });
    const data = JSON.parse(tx);
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) return res.status(502).json({ error:'no_image' });
    res.json({ dataUrl: `data:image/png;base64,${b64}` });
  } catch (e) { res.status(500).json({ error:'server_error', detail:String(e) }); }
});

/* ---------- chat ---------- */
app.post('/api/chat', async (req, res) => {
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const msgs = (body.messages || [])
      .slice(-10)
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text }));

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model:'gpt-4o-mini', temperature:0.8, max_tokens:80,
        messages:[
          { role:'system', content:[
            'あなたはフレンドリーでくだけた雑談相手。',
            'カジュアルで自然体、型にはめすぎない。',
            '絵文字はユーザーが使った時だけ軽く返す。',
            '必ず60文字以内に収める。'
          ].join('\n') },
          ...msgs
        ]
      })
    });

    const tx = await r.text();
    if (r.status === 429) return res.json({ reply:'ちょっと待って、今混み合ってるみたい。' });
    if (!r.ok) return res.status(r.status).json({ error:'openai_error', detail: tx });

    const data = JSON.parse(tx);
    let reply = data.choices?.[0]?.message?.content?.trim() || 'うん、わかったよ。';
    if (reply.length > 60) reply = reply.slice(0, 60);
    res.json({ reply });
  } catch (e) { res.status(500).json({ error:'server_error', detail:String(e) }); }
});

/* ---------- 最後の保険：エラーハンドラでもCORS付与 ---------- */
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(500).json({ error:'server_error', detail:String(err) });
});

/* ---------- start ---------- */
const PORT = Number(process.env.PORT || 8787);
app.listen(PORT, () => {
  console.log(`✅ API listening on http://localhost:${PORT}`);
});
