import { getValidToken } from './tiktok-auth.js';
import { getValidToken as getValidYoutubeToken } from './youtube-auth.js';
// One adapter per platform. Each takes { videoUrl, caption, title, hashtags }
// and returns { ok, id?, url?, message } — never throwing, so one platform
// failing cannot stop the other three from posting.
//
// Three of the four PULL the video: we hand over a public URL and they fetch the
// bytes themselves, which costs us one small API call no matter how big the file
// is. YouTube is the exception and has to be PUSHED, which is the only place a
// large video can run into the function timeout.

const GRAPH = 'https://graph.facebook.com';
const GRAPH_VERSION = process.env.META_API_VERSION || 'v23.0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Compose the text a platform actually receives. */
export function fullCaption({ caption, hashtags }) {
  const tags = Array.isArray(hashtags) ? hashtags.filter(Boolean) : [];
  return tags.length ? `${caption}\n\n${tags.join(' ')}` : caption;
}

/** Meta returns errors in a consistent envelope; surface the useful part. */
function metaError(json, fallback) {
  const e = json?.error;
  if (!e) return fallback;
  const bits = [e.message];
  if (e.error_user_msg && e.error_user_msg !== e.message) bits.push(e.error_user_msg);
  return bits.filter(Boolean).join(' — ');
}

/* --------------------------------------------------------------- facebook */

/**
 * Publishing as a Page needs a PAGE access token, and Meta hands out two kinds
 * that look identical in a config field — a user token and a page token.
 * Pasting the wrong one fails at publish time with a permissions error that
 * reads like a missing scope.
 *
 * So the kind is resolved rather than assumed: asking the Page for its own
 * access_token returns the page token when a user token is supplied, and
 * returns the same token back when a page token already is. Either way the
 * publish call gets what it needs, and a failure here falls back to the
 * configured token so this can never make things worse than not trying.
 */
async function pageToken(pageId, token) {
  try {
    const u = new URL(`${GRAPH}/${GRAPH_VERSION}/${pageId}`);
    u.searchParams.set('fields', 'access_token');
    u.searchParams.set('access_token', token);
    const resp = await fetch(u);
    const json = await resp.json().catch(() => ({}));
    return resp.ok && json.access_token ? json.access_token : token;
  } catch {
    return token;
  }
}

export async function publishFacebook({ videoUrl, caption, hashtags }, env = process.env) {
  const pageId = env.FB_PAGE_ID;
  const token = await pageToken(pageId, env.FB_PAGE_ACCESS_TOKEN);

  const url = new URL(`${GRAPH}/${GRAPH_VERSION}/${pageId}/videos`);
  const form = new URLSearchParams({
    file_url: videoUrl,
    description: fullCaption({ caption, hashtags }),
    access_token: token,
  });

  const resp = await fetch(url, { method: 'POST', body: form });
  const json = await resp.json().catch(() => ({}));

  if (!resp.ok || json.error) {
    return { ok: false, message: metaError(json, `Facebook returned HTTP ${resp.status}.`) };
  }
  return {
    ok: true,
    id: json.id,
    url: json.id ? `https://www.facebook.com/${json.id}` : null,
    message: 'Posted to the Page.',
  };
}

/* -------------------------------------------------------------- instagram */

/**
 * Instagram is two steps with a wait in between: create a container, poll until
 * it has finished ingesting the video, then publish it. Publishing a container
 * that is not FINISHED fails, so the poll is required rather than defensive.
 */
export async function publishInstagram({ videoUrl, caption, hashtags }, env = process.env, opts = {}) {
  const userId = env.IG_USER_ID;
  // Instagram publishing rides the same Meta credential as the Page, so one
  // token covers both unless a separate one is deliberately supplied.
  const token = env.IG_ACCESS_TOKEN || env.FB_PAGE_ACCESS_TOKEN;
  const maxWaitMs = opts.maxWaitMs ?? 90_000;
  const pollMs = opts.pollMs ?? 3_000;

  const create = await fetch(`${GRAPH}/${GRAPH_VERSION}/${userId}/media`, {
    method: 'POST',
    body: new URLSearchParams({
      media_type: 'REELS',
      video_url: videoUrl,
      caption: fullCaption({ caption, hashtags }),
      access_token: token,
    }),
  });
  const created = await create.json().catch(() => ({}));
  if (!create.ok || !created.id) {
    return { ok: false, message: metaError(created, `Instagram refused the video (HTTP ${create.status}).`) };
  }

  const containerId = created.id;
  const deadline = Date.now() + maxWaitMs;
  let status = 'IN_PROGRESS';

  while (Date.now() < deadline) {
    await sleep(pollMs);
    const check = await fetch(
      `${GRAPH}/${GRAPH_VERSION}/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(token)}`,
    );
    const s = await check.json().catch(() => ({}));
    status = s.status_code || status;
    if (status === 'FINISHED') break;
    if (status === 'ERROR') {
      return { ok: false, message: `Instagram could not process the video. ${s.status || ''}`.trim() };
    }
  }

  if (status !== 'FINISHED') {
    return {
      ok: false,
      message:
        'Instagram was still processing the video when we stopped waiting. The container may ' +
        'still publish on its own; check the account before re-posting.',
    };
  }

  const pub = await fetch(`${GRAPH}/${GRAPH_VERSION}/${userId}/media_publish`, {
    method: 'POST',
    body: new URLSearchParams({ creation_id: containerId, access_token: token }),
  });
  const published = await pub.json().catch(() => ({}));
  if (!pub.ok || !published.id) {
    return { ok: false, message: metaError(published, `Instagram would not publish the container (HTTP ${pub.status}).`) };
  }

  return { ok: true, id: published.id, url: null, message: 'Published as a Reel.' };
}

/* ----------------------------------------------------------------- tiktok */

const TIKTOK_API = 'https://open.tiktokapis.com/v2';

/**
 * Ask TikTok what this creator and this app are actually allowed to do.
 *
 * Required before publishing — TikTok's UX rules say the creator must be shown
 * their real options rather than assumed into one — and it is also where every
 * genuine constraint lives: which privacy levels the app may use, whether the
 * account has comments or duets switched off, how long a video may be.
 *
 * It doubles as the cheapest possible check that the token works, with a clear
 * error, before a video is handed over.
 */
export async function tiktokCreatorInfo(token, fetchImpl = fetch) {
  let resp;
  try {
    resp = await fetchImpl(`${TIKTOK_API}/post/publish/creator_info/query/`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=UTF-8',
      },
    });
  } catch {
    return { ok: false, message: 'Could not reach TikTok.' };
  }

  const json = await resp.json().catch(() => ({}));
  const err = json?.error;

  if (!resp.ok || (err && err.code && err.code !== 'ok')) {
    const code = err?.code || `HTTP ${resp.status}`;
    let message = err?.message || 'TikTok would not return the creator info.';
    if (/access_token|token|unauthor/i.test(`${code} ${message}`)) {
      message =
        'TikTok rejected the access token. It expires every 24 hours, so this is usually a ' +
        'stale token rather than a wrong one — refresh it and update TIKTOK_ACCESS_TOKEN.';
    }
    if (/scope/i.test(`${code} ${message}`)) {
      message = 'The TikTok token is missing the video.publish scope.';
    }
    return { ok: false, message: `${message} (${code})` };
  }

  const d = json?.data || {};
  return {
    ok: true,
    username: d.creator_username || null,
    // No fallback list. Inventing options TikTok did not return is how a post
    // gets rejected for asking to be more public than the app may be.
    privacyOptions: Array.isArray(d.privacy_level_options) ? d.privacy_level_options : [],
    maxDurationSec: d.max_video_post_duration_sec ?? null,
    commentDisabled: !!d.comment_disabled,
    duetDisabled: !!d.duet_disabled,
    stitchDisabled: !!d.stitch_disabled,
  };
}

/**
 * The most public level TikTok says is available, in descending order.
 *
 * An UNAUDITED app is only ever offered SELF_ONLY. Hardcoding
 * PUBLIC_TO_EVERYONE — as this did — means the very first post is rejected,
 * and the error does not say why.
 */
export function pickPrivacyLevel(options) {
  const order = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'];
  for (const level of order) if (options.includes(level)) return level;
  return options[0] || null;
}

/**
 * What TikTok requires the CREATOR to have chosen, checked again here.
 *
 * The UI enforces all of this, and the UI is a browser — it can be bypassed,
 * and a request that skips it would post at a visibility nobody picked. These
 * are TikTok's audit rules, so breaking them is not just a bug: it is the
 * thing that gets the app's posting access revoked.
 */
export function validateTikTokOptions(opts, allowedPrivacy) {
  const o = opts || {};

  if (!o.privacyLevel) {
    return 'Choose who can see this TikTok before posting.';
  }
  if (!allowedPrivacy.includes(o.privacyLevel)) {
    return `TikTok does not allow ${o.privacyLevel} for this account right now.`;
  }
  if (o.commercial && !o.brandOrganic && !o.brandedContent) {
    return 'Say whether this promotes your own brand, a paid partnership, or both.';
  }
  // TikTok's rule, not ours: a paid partnership has to be disclosable, and a
  // post only the author can see cannot disclose anything to anyone.
  if (o.brandedContent && o.privacyLevel === 'SELF_ONLY') {
    return 'Branded content cannot be posted privately. Choose a wider audience or turn it off.';
  }
  return null;
}

export async function publishTikTok({ videoUrl, caption, hashtags, options }, env = process.env) {
  /* Not env.TIKTOK_ACCESS_TOKEN. TikTok's access tokens last 24 hours, so a
     variable set by hand is correct for one afternoon and then fails with an
     auth error that reads like a permissions problem. getValidToken refreshes
     from the stored refresh token, and falls back to the variable when nothing
     has been authorised yet. */
  const { token, message: tokenProblem } = await getValidToken(env);
  if (!token) return { ok: false, message: tokenProblem };

  const info = await tiktokCreatorInfo(token);
  if (!info.ok) return { ok: false, message: info.message };

  if (!info.privacyOptions.length) {
    return {
      ok: false,
      message:
        'TikTok returned no privacy levels for this account, so there is nothing this app is ' +
        'permitted to post as. Check the app is approved for Content Posting.',
    };
  }

  /* The creator picks the audience. TikTok's guidelines are explicit that the
     selector has no default and the app must not choose — an app that picks for
     them fails the audit even when the choice is the obvious one. */
  const problem = validateTikTokOptions(options, info.privacyOptions);
  if (problem) return { ok: false, message: problem };

  const privacy = options.privacyLevel;

  const resp = await fetch(`${TIKTOK_API}/post/publish/video/init/`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({
      post_info: {
        title: fullCaption({ caption, hashtags }).slice(0, 2200),
        privacy_level: privacy,
        /* Interactions are opt-IN: TikTok requires every box to start unchecked,
           so "not enabled" is the normal case rather than a refusal. A creator
           who has turned an interaction off in their own account settings can
           never enable it here, whatever the browser sent. */
        disable_comment: info.commentDisabled || !options.allowComment,
        disable_duet: info.duetDisabled || !options.allowDuet,
        disable_stitch: info.stitchDisabled || !options.allowStitch,
        brand_organic_toggle: !!options.brandOrganic,
        brand_content_toggle: !!options.brandedContent,
      },
      source_info: { source: 'PULL_FROM_URL', video_url: videoUrl },
    }),
  });

  const json = await resp.json().catch(() => ({}));
  const err = json?.error;

  if (!resp.ok || (err && err.code && err.code !== 'ok')) {
    const code = err?.code || `HTTP ${resp.status}`;
    let message = err?.message || 'TikTok rejected the post.';
    // The single most likely failure, and the least obvious from the raw text.
    if (/url_ownership|unverified|domain/i.test(`${code} ${message}`)) {
      message =
        'TikTok will not pull from an unverified domain. Verify the video host in the TikTok ' +
        'developer portal, or serve the file from a domain that is already verified.';
    }
    if (/privacy/i.test(`${code} ${message}`)) {
      message =
        `TikTok refused the privacy level ${privacy}. The app is probably not audited yet, ` +
        'which limits it to private posts.';
    }
    return { ok: false, message: `${message} (${code})` };
  }

  /* Saying "posted" when the post is visible only to the account holder is the
     kind of half-truth that costs weeks — somebody waits for engagement on a
     video nobody can see. The visibility leads the message. */
  const isPublic = privacy === 'PUBLIC_TO_EVERYONE';
  return {
    ok: true,
    id: json?.data?.publish_id || null,
    url: null,
    visibility: privacy,
    message: isPublic
      ? 'Handed to TikTok as a public post. It pulls and processes the video, so it appears shortly.'
      : `Uploaded, but visible to ${privacy === 'SELF_ONLY' ? 'you only' : 'a limited audience'} ` +
        `(${privacy}) — TikTok restricts unaudited apps to private posts. Nobody else can see ` +
        'this until the app passes TikTok\'s Content Posting audit.',
  };
}

/* ---------------------------------------------------------------- youtube */

/**
 * A usable access token.
 *
 * Delegated to lib/social/youtube-auth.js, which reads the refresh token from
 * encrypted storage when the channel was connected through the dashboard and
 * falls back to YOUTUBE_REFRESH_TOKEN when it was pasted in by hand. Reading
 * the environment directly here would mean a connection made in the UI was
 * invisible to the thing that posts.
 */
async function youtubeAccessToken(env) {
  const { token, message } = await getValidYoutubeToken(env);
  if (!token) throw new Error(message || 'YouTube is not connected.');
  return token;
}

/**
 * The only platform we have to push bytes to. A resumable session is opened,
 * then the video is streamed from Blob straight through to Google without ever
 * being buffered in the function — which is what keeps a 200 MB file from
 * exhausting the function's memory. It can still exceed the function's time
 * limit, which is the honest weak point of this adapter.
 */
export async function publishYouTube({ videoUrl, caption, title, hashtags }, env = process.env) {
  let accessToken;
  try {
    accessToken = await youtubeAccessToken(env);
  } catch (e) {
    return { ok: false, message: e.message };
  }

  const tags = (Array.isArray(hashtags) ? hashtags : []).map((h) => String(h).replace(/^#/, ''));
  const metadata = {
    snippet: {
      title: (title || caption || 'Untitled').slice(0, 100),
      description: fullCaption({ caption, hashtags }).slice(0, 5000),
      tags: tags.slice(0, 10),
    },
    status: {
      // Google forces private for unverified apps regardless; asking for public
      // is still correct, and the response tells us what actually happened.
      privacyStatus: 'public',
      selfDeclaredMadeForKids: false,
    },
  };

  // Google wants the length up front so it can size the resumable session.
  const head = await fetch(videoUrl, { method: 'HEAD' });
  const size = head.headers.get('content-length');

  const start = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'x-upload-content-type': head.headers.get('content-type') || 'video/mp4',
        ...(size ? { 'x-upload-content-length': size } : {}),
      },
      body: JSON.stringify(metadata),
    },
  );

  if (!start.ok) {
    const j = await start.json().catch(() => ({}));
    const reason = j?.error?.message || `HTTP ${start.status}`;
    if (start.status === 403 && /quota/i.test(reason)) {
      return {
        ok: false,
        message:
          'YouTube quota exhausted. An upload costs 1600 of the default 10,000 units a day, ' +
          'so roughly six uploads daily. Request more quota or wait for the reset.',
      };
    }
    return { ok: false, message: `YouTube would not start the upload: ${reason}` };
  }

  const session = start.headers.get('location');
  if (!session) return { ok: false, message: 'YouTube did not return a resumable upload URL.' };

  const video = await fetch(videoUrl);
  if (!video.ok || !video.body) {
    return { ok: false, message: 'Could not read the uploaded video back from storage.' };
  }

  const put = await fetch(session, {
    method: 'PUT',
    headers: {
      'content-type': head.headers.get('content-type') || 'video/mp4',
      ...(size ? { 'content-length': size } : {}),
    },
    body: video.body,
    // Required by undici to stream a request body rather than buffer it.
    duplex: 'half',
  });

  const result = await put.json().catch(() => ({}));
  if (!put.ok || !result.id) {
    return {
      ok: false,
      message: result?.error?.message || `YouTube rejected the upload (HTTP ${put.status}).`,
    };
  }

  const privacy = result?.status?.privacyStatus;
  return {
    ok: true,
    id: result.id,
    url: `https://youtube.com/shorts/${result.id}`,
    message:
      privacy && privacy !== 'public'
        ? `Uploaded, but YouTube set it to ${privacy}. That is what an unverified app is limited to — it stays ${privacy} until Google verifies the project.`
        : 'Uploaded.',
  };
}

export const ADAPTERS = {
  facebook: publishFacebook,
  instagram: publishInstagram,
  tiktok: publishTikTok,
  youtube: publishYouTube,
};
