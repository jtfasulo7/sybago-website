// Generates one caption per platform for a finished video.
//
// POST { context, tone?, link?, platforms?[] } -> { captions: { <platform>: {...} } }
//
// ANTHROPIC_API_KEY is read only here and never leaves the server, same rule as
// the Meta token in api/meta-insights.js.
//
// The model is asked for JSON and the response is parsed strictly. A caption is
// going out under a client's name, so a half-parsed or truncated result is
// failed loudly rather than posted.

import { requireSession, noStore } from '../lib/auth.js';
import { PLATFORMS, PLATFORM_IDS } from '../lib/social/platforms.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const ANTHROPIC_VERSION = '2023-06-01';

/** Keep a stray key out of any outbound string, as a backstop. */
function scrub(text) {
  if (typeof text !== 'string') return text;
  const k = process.env.ANTHROPIC_API_KEY;
  return k && k.length > 8 ? text.split(k).join('REDACTED') : text;
}

/**
 * The per-platform brief. Built from the registry rather than written out four
 * times, so a limit only has to change in one place.
 */
function platformBrief(id) {
  const p = PLATFORMS[id];
  const parts = [
    `## ${p.label} (${p.kind})`,
    `- Hard caption limit: ${p.captionLimit} characters. Stay comfortably under it.`,
  ];
  if (p.titleLimit) {
    parts.push(`- Also needs a separate title, max ${p.titleLimit} characters.`);
  }
  parts.push(`- Hashtags: between ${p.hashtags.min} and ${p.hashtags.max}.`);
  parts.push(`- Voice: ${p.voice}`);
  return parts.join('\n');
}

function buildPrompt({ context, tone, link, platforms }) {
  return [
    'You write social captions for Peps by Dave, a brand selling a Skool community.',
    '',
    'Write ONE caption per platform for the same finished video. They must not be',
    'the same text with different hashtags — each platform rewards a different shape,',
    'and a caption that reads as cross-posted performs worse than one written for the',
    'place it appears.',
    '',
    '# The video',
    context,
    tone ? `\n# Tone\n${tone}` : '',
    link ? `\n# Link to include where the platform allows it\n${link}` : '',
    '',
    '# Platforms',
    platforms.map(platformBrief).join('\n\n'),
    '',
    '# Rules',
    '- No em dashes.',
    '- Never invent a statistic, a testimonial, a price, or a result.',
    '- No "link in bio" on platforms where a link is allowed in the caption.',
    '- Hashtags go at the end, never inside a sentence.',
    '- Do not use the words "unlock", "unleash", "elevate", "dive into", or "game changer".',
    '',
    '# Output',
    'Return ONLY a JSON object, no prose around it, shaped exactly like:',
    '{',
    platforms
      .map((id) => {
        const p = PLATFORMS[id];
        return p.titleLimit
          ? `  "${id}": { "title": "...", "caption": "...", "hashtags": ["...", "..."] }`
          : `  "${id}": { "caption": "...", "hashtags": ["...", "..."] }`;
      })
      .join(',\n'),
    '}',
    'The caption field must NOT already contain the hashtags; they are listed separately',
    'so the dashboard can show and count them.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Pull the JSON object out of the reply, tolerating a stray code fence. */
function parseModelJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model did not return a JSON object.');
  return JSON.parse(raw.slice(start, end + 1));
}

/**
 * Enforce the limits ourselves rather than trusting the model to have counted.
 * An over-length caption is rejected by the platform at publish time, which is a
 * much worse place to find out.
 */
function validate(id, entry) {
  const p = PLATFORMS[id];
  const problems = [];
  if (!entry || typeof entry.caption !== 'string' || !entry.caption.trim()) {
    problems.push('no caption was returned');
    return { problems };
  }
  const hashtags = Array.isArray(entry.hashtags)
    ? entry.hashtags.map((h) => String(h).replace(/^#*/, '#')).filter((h) => h.length > 1)
    : [];

  const caption = entry.caption.trim();
  const full = hashtags.length ? `${caption}\n\n${hashtags.join(' ')}` : caption;

  if (full.length > p.captionLimit) {
    problems.push(`${full.length} characters, over the ${p.captionLimit} limit`);
  }
  if (hashtags.length > p.hashtags.max) {
    problems.push(`${hashtags.length} hashtags, more than ${p.hashtags.max}`);
  }

  const out = { caption, hashtags, full, length: full.length, limit: p.captionLimit };

  if (p.titleLimit) {
    const title = typeof entry.title === 'string' ? entry.title.trim() : '';
    if (!title) problems.push('no title was returned');
    else if (title.length > p.titleLimit) {
      problems.push(`title is ${title.length} characters, over the ${p.titleLimit} limit`);
    }
    out.title = title;
    out.titleLimit = p.titleLimit;
  }

  out.problems = problems;
  return out;
}

export default async function handler(req, res) {
  noStore(res);
  const session = requireSession(req, res);
  if (!session) return;

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(500).json({
      error: 'server_misconfigured',
      message:
        'ANTHROPIC_API_KEY is not set on this deployment. Add it in Vercel → Settings → ' +
        'Environment Variables, then redeploy.',
    });
  }

  const body = req.body || {};
  const context = String(body.context || '').trim();
  if (context.length < 10) {
    return res.status(400).json({
      error: 'missing_context',
      message: 'Describe what happens in the video so the captions have something to work from.',
    });
  }
  if (context.length > 4000) {
    return res.status(400).json({ error: 'context_too_long', message: 'Keep the description under 4000 characters.' });
  }

  const requested = Array.isArray(body.platforms) && body.platforms.length
    ? body.platforms.filter((p) => PLATFORM_IDS.includes(p))
    : PLATFORM_IDS;
  if (!requested.length) {
    return res.status(400).json({ error: 'no_platforms', message: 'Pick at least one platform.' });
  }

  const prompt = buildPrompt({
    context,
    tone: String(body.tone || '').trim().slice(0, 500),
    link: String(body.link || '').trim().slice(0, 300),
    platforms: requested,
  });

  try {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const json = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      const detail = json?.error?.message || `HTTP ${resp.status}`;
      if (resp.status === 401) {
        return res.status(401).json({
          error: 'anthropic_unauthorized',
          message: 'The Anthropic API rejected the key. Check ANTHROPIC_API_KEY is current and complete.',
        });
      }
      if (resp.status === 429) {
        return res.status(429).json({
          error: 'anthropic_rate_limited',
          message: 'The Anthropic API is rate limiting this key. Wait a moment and try again.',
        });
      }
      return res.status(502).json({ error: 'anthropic_error', message: scrub(detail) });
    }

    const text = (json.content || []).map((c) => c.text || '').join('');
    let parsed;
    try {
      parsed = parseModelJson(text);
    } catch (e) {
      return res.status(502).json({
        error: 'unparseable',
        message: 'The model did not return usable JSON. Try again, or shorten the description.',
      });
    }

    const captions = {};
    for (const id of requested) captions[id] = validate(id, parsed[id]);

    return res.status(200).json({
      captions,
      model: MODEL,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    // Never interpolate the raw error — a network failure can carry the URL.
    return res.status(502).json({
      error: 'network_error',
      message: 'Could not reach the Anthropic API. Try again.',
    });
  }
}
