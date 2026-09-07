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
    /* The OAuth client's own credentials. The refresh token is NOT an env var
       any more — it is obtained by OAuth and stored encrypted, because minting
       one by hand means the OAuth Playground and a redirect URI that has to
       match exactly. A pasted YOUTUBE_REFRESH_TOKEN still works; see envAlt. */
    env: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET'],
    tokenEnv: [],
    envAlt: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN'],
    needsAuth: true,
    setup:
      'Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET from a Google Cloud OAuth client of ' +
      'type Web application, with https://sybago.ai/api/youtube-auth as an authorised redirect ' +
      'URI and the YouTube Data API enabled, then connect the channel from this page. ' +
      'Until Google verifies the app, uploads are forced ' +
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
    /* The app's own credentials. A user access token is NOT an env var any
       more — it is obtained by OAuth and refreshed from storage, because
       TikTok's expire every 24 hours. Whether an account has actually been
       authorised is a separate state the UI asks for; see needsAuth. */
    env: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'],
    tokenEnv: [],
    // A pasted user token still works, and is how this ran before OAuth. It is
    // an alternative to the app keys, not an addition to them — see envAlt.
    envAlt: ['TIKTOK_ACCESS_TOKEN'],
    needsAuth: true,
    setup:
      'Set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET from the TikTok developer app, then ' +
      'connect the account from this page. Until the app passes ' +
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

/** Every name in the list is set to something non-empty. */
function allSet(names, env) {
  return (names || []).every((name) => String(env[name] || '').trim().length > 0);
}

/**
 * A second, complete set of credentials that also configures the platform.
 *
 * TikTok has two genuinely different ways to hold a credential: the OAuth app
 * keys, which mint and refresh a user token, or a user token pasted in whole.
 * Either is sufficient; demanding both would mean the OAuth path could never
 * report itself configured.
 */
function altSatisfied(p, env) {
  return !!(p.envAlt && p.envAlt.length && allSet(p.envAlt, env));
}

export function isConfigured(id, env = process.env) {
  const p = PLATFORMS[id];
  if (!p) return false;
  if (altSatisfied(p, env)) return true;
  const idsOk = allSet(p.env, env);
  // A platform with a tokenEnv list needs one of them set; a platform whose
  // credentials are all in env (TikTok, YouTube) has an empty list and is done.
  const tokenOk = !p.tokenEnv || !p.tokenEnv.length || resolveTokenName(id, env) !== null;
  return idsOk && tokenOk;
}

/** Which of a platform's variables are missing, for an actionable message. */
export function missingEnv(id, env = process.env) {
  const p = PLATFORMS[id];
  if (!p) return [];
  if (altSatisfied(p, env)) return [];
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
      // Configured means the app keys exist. This platform still has to have an
      // account connected before it can post, and the UI shows that separately.
      needsAuth: !!p.needsAuth,
    };
  });
}
