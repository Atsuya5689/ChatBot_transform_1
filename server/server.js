// server/server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import fetch from 'node-fetch';

const app = express();

// ---------- security / basics ----------
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.json({ limit: '1mb' }));

// CORS: 開発中は http://localhost:5500 を許可（.envで変更）
const ALLOWED = (process.env.ALLOWED_ORIGIN || 'http://localhost:5500')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // file:// を使う場合は origin が null になるので、開発中のみ許可したい時は↓を true に
      const ALLOW_NULL_ORIGIN = false;
      if (origin === null && ALLOW_NULL_ORIGIN) return cb(null, true);
      if (!origin) return cb(new Error('CORS: missing origin')); // 本番は必ず origin を要求
      if (ALLOWED.includes(origin)) return cb(null, true);
      return cb(new Error('Not allowed by CORS: ' + origin));
    },
    credentials: false,
  })
);

// レート制限（雑に連打されないための最低限）
app.use('/api/', rateLimit({ windowMs: 60_000, max: 30 }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.warn('⚠️  OPENAI_API_KEY is not set. Set it in server/.env');
}

// ---------- health ----------
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ---------- summarize ----------
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

    // レート制限はニュートラルで返す
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
    const sentiment =
      /Sentiment:\s*(.*)/i.exec(content)?.[1]?.trim() || 'neutral';
    const hint =
      /Style hint:\s*(.*)/i.exec(content)?.[1]?.trim() || 'neutral casual';

    res.json({ topics, sentiment, hint, raw: content });
  } catch (e) {
    console.error('[summarize] server error:', e);
    res.status(500).json({ error: 'server_error', detail: String(e) });
  }
});

// ---------- chat (casual 60-char reply) ----------
app.post('/api/chat', async (req, res) => {
  try {
    // フロントから { messages: [{role:'user'|'assistant', text:string}] } を想定
    const msgs = (req.body?.messages || [])
      .slice(-10)
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text }));

    const payload = {
      model: 'gpt-4o-mini',
      temperature: 0.8,
      max_tokens: 80, // 日本語60文字目安
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
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const bodyText = await r.text();

    if (r.status === 429) {
      return res.json({ reply: 'ちょっと待って、今混み合ってるみたい。' });
    }
    if (!r.ok) {
      console.error('[chat] OpenAI error:', bodyText);
      return res.status(r.status).json({ error: 'openai_error', detail: bodyText });
    }

    const data = JSON.parse(bodyText);
    let reply = data.choices?.[0]?.message?.content?.trim() || 'うん、わかったよ。';

    // 念のため60文字でサーバー側でもカット（安全網）
    if (reply.length > 60) reply = reply.slice(0, 60);

    res.json({ reply });
  } catch (e) {
    console.error('[chat] server error:', e);
    res.status(500).json({ error: 'server_error', detail: String(e) });
  }
});


// ---------- generate avatar ----------
app.post('/api/generate-avatar', async (req, res) => {
  try {
    const hint = req.body?.hint;
    if (!hint || typeof hint !== 'string') {
      return res
        .status(400)
        .json({ error: 'bad_request', detail: 'hint must be a string' });
    }

    const prompt =
      `Waist-up avatar on a dark background. Keep the same neutral face/identity.\n` +
      `Change ONLY clothing/accessories to: ${hint}.\n` +
      `Clean flat style, centered, high-contrast, no text.`;

    // 注: ここは REST 直叩き。必須は model / prompt / size
    const payload = {
      model: 'gpt-image-1',
      prompt,
      size: '1024x1024', // ← ここは必ず "512x512" などの文字列
      // background を入れると環境により弾かれることがあるため省略
      // n も省略（デフォルト1）
    };

    console.log('[generate-avatar] payload:', payload);

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

    let data;
    try {
      data = JSON.parse(bodyText);
    } catch {
      data = {};
    }

    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) {
      console.error('[generate-avatar] no b64_json in response:', data);
      return res.status(502).json({ error: 'no_image' });
    }

    res.json({ dataUrl: `data:image/png;base64,${b64}` });
  } catch (e) {
    console.error('[generate-avatar] server error:', e);
    res.status(500).json({ error: 'server_error', detail: String(e) });
  }
});

// ---------- start ----------
const PORT = Number(process.env.PORT || 8787);
app.listen(PORT, () => {
  console.log(`✅ API listening on http://localhost:${PORT}`);
  console.log(`   Allowed origins: ${ALLOWED.join(', ')}`);
});
