// Posts one already-uploaded video to the selected platforms.
//
// GET  -> { platforms: [...] }   configuration status, for the UI
// POST { videoUrl, posts: { <platform>: { caption, hashtags, title? } } }
//     -> { results: { <platform>: { ok, id, url, message } } }
//
// Platforms are published CONCURRENTLY and independently. One failing must not
// stop or roll back the others: a video already live on Facebook cannot be
// un-posted because TikTok refused it, so partial success is the honest outcome
// and the response reports per platform.

import { requireSession, noStore } from '../lib/auth.js';
import { PLATFORMS, PLATFORM_IDS, isConfigured, missingEnv, platformStatus } from '../lib/social/platforms.js';
import { ADAPTERS } from '../lib/social/adapters.js';

/** Credentials must never appear in a response, whatever a platform echoes. */
function scrubSecrets(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  const names = new Set(Object.values(PLATFORMS).flatMap((p) => p.env));
  for (const name of names) {
    const v = String(process.env[name] || '').trim();
    if (v.length > 8) out = out.split(v).join('REDACTED');
  }
  return out.replace(/access_token=[^&\s]*/gi, 'access_token=REDACTED');
}

/**
 * The video must live somewhere the platforms can actually reach. Accepting an
 * arbitrary URL from the browser would turn this endpoint into a way to make
 * the server fetch anything, so only our own Blob store is allowed.
 */
function validVideoUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return { ok: false, message: 'That is not a valid video URL.' };
  }
  if (u.protocol !== 'https:') {
    return { ok: false, message: 'The video URL must be https — every platform refuses plain http.' };
  }
  if (!/(^|\.)blob\.vercel-storage\.com$/i.test(u.hostname) && !/(^|\.)public\.blob\.vercel-storage\.com$/i.test(u.hostname)) {
    return {
      ok: false,
      message: 'Only videos uploaded through this dashboard can be posted.',
    };
  }
  return { ok: true, url: u.toString() };
}

export default async function handler(req, res) {
  noStore(res);
  const session = requireSession(req, res);
  if (!session) return;

  if (req.method === 'GET') {
    return res.status(200).json({ platforms: platformStatus() });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const body = req.body || {};

  const video = validVideoUrl(body.videoUrl);
  if (!video.ok) return res.status(400).json({ error: 'bad_video_url', message: video.message });

  const posts = body.posts && typeof body.posts === 'object' ? body.posts : {};
  const requested = PLATFORM_IDS.filter((id) => posts[id]);
  if (!requested.length) {
    return res.status(400).json({ error: 'no_platforms', message: 'Pick at least one platform to post to.' });
  }

  // Refuse the whole request if any chosen platform is unconfigured, rather
  // than posting to three and reporting the fourth as an error afterwards.
  // Half-posting is much harder to undo than not starting.
  const unconfigured = requested.filter((id) => !isConfigured(id));
  if (unconfigured.length) {
    return res.status(400).json({
      error: 'not_configured',
      message:
        `Not connected yet: ${unconfigured.map((id) => PLATFORMS[id].label).join(', ')}. ` +
        'Deselect them, or add the missing credentials.',
      missing: Object.fromEntries(unconfigured.map((id) => [id, missingEnv(id)])),
    });
  }

  for (const id of requested) {
    const entry = posts[id];
    if (!entry || typeof entry.caption !== 'string' || !entry.caption.trim()) {
      return res.status(400).json({
        error: 'missing_caption',
        message: `${PLATFORMS[id].label} has no caption.`,
      });
    }
    const tags = Array.isArray(entry.hashtags) ? entry.hashtags : [];
    const length = entry.caption.length + (tags.length ? tags.join(' ').length + 2 : 0);
    if (length > PLATFORMS[id].captionLimit) {
      return res.status(400).json({
        error: 'caption_too_long',
        message: `The ${PLATFORMS[id].label} caption is ${length} characters, over its ${PLATFORMS[id].captionLimit} limit.`,
      });
    }
  }

  const settled = await Promise.all(
    requested.map(async (id) => {
      try {
        const out = await ADAPTERS[id](
          {
            videoUrl: video.url,
            caption: posts[id].caption.trim(),
            hashtags: posts[id].hashtags || [],
            title: posts[id].title || '',
          },
          process.env,
        );
        return [id, { ...out, message: scrubSecrets(out.message) }];
      } catch (e) {
        // An adapter throwing is a bug, not a platform refusal — but it still
        // must not take the other three down with it.
        return [id, { ok: false, message: scrubSecrets(e?.message || 'Unexpected failure.') }];
      }
    }),
  );

  const results = Object.fromEntries(settled);
  const posted = settled.filter(([, r]) => r.ok).length;

  return res.status(200).json({
    results,
    summary: {
      requested: requested.length,
      posted,
      failed: requested.length - posted,
    },
    postedAt: new Date().toISOString(),
  });
}
