// The four target platforms, their real constraints, and what each needs to be
// configured.
//
// This is the single source of truth for the whole social feature: the caption
// prompt reads the limits from here, the UI renders status from here, and the
// publisher looks up its adapter here. Adding a platform should mean adding one
// entry plus one adapter, and nothing else.
//
// X/Twitter is deliberately absent. Posting video there needs a paid API tier,
// and it was dropped from scope rather than shipped as a button that 401s.

/**
 * How the platform gets the video file.
 *
 *   'pull' — we hand it a public URL and it fetches the bytes itself.
 *   'push' — we have to stream the bytes to it ourselves.
 *
 * This distinction matters more than it looks. A 'pull' platform costs us one
 * small API call regardless of video size. A 'push' platform means the video
 * travels blob -> our function -> platform, inside the function timeout, which
 * is the one part of this feature that a large file can break.
 */
export const TRANSFER_PULL = 'pull';
export const TRANSFER_PUSH = 'push';

export const PLATFORMS = {
  instagram: {
    id: 'instagram',
    label: 'Instagram',
    kind: 'Reel',
    transfer: TRANSFER_PULL,
    // Instagram counts characters, and hashtags eat into the same budget.
    captionLimit: 2200,
    hashtags: { min: 3, max: 8 },
    // Every var must be present for the platform to be considered configured.
    // IG_ACCESS_TOKEN is optional: Instagram publishing goes through the same
    // Meta token as the Page, so a single credential covers both. Set it only
    // to use a different token for Instagram than for Facebook.
    env: ['IG_USER_ID'],
    tokenEnv: ['IG_ACCESS_TOKEN', 'FB_PAGE_ACCESS_TOKEN'],
    setup:
      'Needs an Instagram Business or Creator account linked to a Facebook Page, ' +
      'inside a Meta app with instagram_content_publish approved. IG_USER_ID is the ' +
      'Instagram user id, not the handle.',
    // Meta caps publishing per account per rolling day.
    dailyLimit: 25,
    voice:
      'Polished but personal. A hook in the first line, because everything after ' +
      'it is hidden behind "more". Line breaks between thoughts. Hashtags at the end, ' +
      'never mid-sentence.',
  },

  facebook: {
    id: 'facebook',
    label: 'Facebook',
    kind: 'Page video',
    transfer: TRANSFER_PULL,
    captionLimit: 5000,
    hashtags: { min: 0, max: 3 },
    env: ['FB_PAGE_ID'],
    tokenEnv: ['FB_PAGE_ACCESS_TOKEN'],
    setup:
      'Needs a Facebook Page access token with pages_manage_posts and pages_read_engagement. ' +
      'Use a long-lived Page token — a user token expires in about an hour.',
    voice:
      'The most room to talk of any of them, and the oldest audience. Full sentences, ' +
      'context up front rather than a cliffhanger, and a plain call to action. Hashtags ' +
      'do almost nothing here, so use very few or none.',
  },

  youtube: {
    id: 'youtube',
    label: 'YouTube Shorts',
    kind: 'Short',
    transfer: TRANSFER_PUSH,
    // YouTube splits this: a title and a separate description.
    captionLimit: 5000,
    titleLimit: 100,
    hashtags: { min: 2, max: 5 },
    env: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN'],
    tokenEnv: [],
    setup:
      'Needs a Google Cloud project with the YouTube Data API enabled and an OAuth refresh ' +
      'token for the youtube.upload scope. Until Google verifies the app, uploads are forced ' +
      'to private regardless of what is requested. Quota also bites: an upload costs 1600 of ' +
      'the default 10,000 units a day, so roughly six uploads daily.',
    quotaNote: 'about 6 uploads/day on the default quota',
    voice:
      'A title that works as a search result, not as a caption — YouTube is a search engine. ' +
      'Front-load the specific thing being shown. The description can carry more detail. ' +
      '#Shorts belongs in the tags.',
  },

  tiktok: {
    id: 'tiktok',
    label: 'TikTok',
    kind: 'Video',
    transfer: TRANSFER_PULL,
    captionLimit: 2200,
    hashtags: { min: 3, max: 6 },
    env: ['TIKTOK_ACCESS_TOKEN'],
    tokenEnv: [],
    setup:
      'Needs a TikTok developer app with the video.publish scope. Until the app passes ' +
      'TikTok audit it can only create drafts, not public posts. PULL_FROM_URL also requires ' +
      'the hosting domain to be verified in the TikTok developer portal — a Vercel Blob URL ' +
      'will be rejected until blob.vercel-storage.com is verified, or the video is served ' +
      'from a verified domain.',
    voice:
      'Native and conversational, never advertised-at. Short, punchy, lower-case is fine. ' +
      'The hook has to land in the first three words. Trend-aware hashtags, not corporate ones.',
  },
};

export const PLATFORM_IDS = Object.keys(PLATFORMS);

/** True when every environment variable the platform needs is set. */
/** The first token variable this platform can actually use, if any. */
export function resolveTokenName(id, env = process.env) {
  const p = PLATFORMS[id];
  if (!p || !p.tokenEnv || !p.tokenEnv.length) return null;
  return p.tokenEnv.find((name) => String(env[name] || '').trim().length > 0) || null;
}

export function isConfigured(id, env = process.env) {
  const p = PLATFORMS[id];
  if (!p) return false;
  const idsOk = p.env.every((name) => String(env[name] || '').trim().length > 0);
  // A platform with a tokenEnv list needs one of them set; a platform whose
  // credentials are all in env (TikTok, YouTube) has an empty list and is done.
  const tokenOk = !p.tokenEnv || !p.tokenEnv.length || resolveTokenName(id, env) !== null;
  return idsOk && tokenOk;
}

/** Which of a platform's variables are missing, for an actionable message. */
export function missingEnv(id, env = process.env) {
  const p = PLATFORMS[id];
  if (!p) return [];
  const missing = p.env.filter((name) => !String(env[name] || '').trim());
  // Name only the FIRST acceptable token variable — listing every fallback
  // would read as "set all of these" when any one will do.
  if (p.tokenEnv && p.tokenEnv.length && resolveTokenName(id, env) === null) {
    missing.push(p.tokenEnv[0]);
  }
  return missing;
}

/**
 * Status for every platform, shaped for the UI.
 *
 * Never includes a credential value — only whether each name is set. The point
 * of this endpoint is that the dashboard can grey out a platform honestly
 * instead of offering a button that quietly fails.
 */
export function platformStatus(env = process.env) {
  return PLATFORM_IDS.map((id) => {
    const p = PLATFORMS[id];
    const missing = missingEnv(id, env);
    return {
      id,
      label: p.label,
      kind: p.kind,
      configured: missing.length === 0,
      missing,
      setup: p.setup,
      captionLimit: p.captionLimit,
      titleLimit: p.titleLimit || null,
      transfer: p.transfer,
      quotaNote: p.quotaNote || null,
    };
  });
}
