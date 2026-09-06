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

export async function publishFacebook({ videoUrl, caption, hashtags }, env = process.env) {
  const pageId = env.FB_PAGE_ID;
  const token = env.FB_PAGE_ACCESS_TOKEN;

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
  const token = env.IG_ACCESS_TOKEN;
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

export async function publishTikTok({ videoUrl, caption, hashtags }, env = process.env) {
  const token = env.TIKTOK_ACCESS_TOKEN;

  const resp = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({
      post_info: {
        title: fullCaption({ caption, hashtags }).slice(0, 2200),
        privacy_level: 'PUBLIC_TO_EVERYONE',
        disable_comment: false,
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
    if (/scope|unaudited|audit/i.test(`${code} ${message}`)) {
      message =
        'The TikTok app is not audited yet, so it can only create drafts. Complete the app ' +
        'audit to publish publicly.';
    }
    return { ok: false, message: `${message} (${code})` };
  }

  return {
    ok: true,
    id: json?.data?.publish_id || null,
    url: null,
    message: 'Handed to TikTok. It pulls and processes the video, so it appears shortly.',
  };
}

/* ---------------------------------------------------------------- youtube */

/** Exchange the long-lived refresh token for a short-lived access token. */
async function youtubeAccessToken(env) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.YOUTUBE_CLIENT_ID,
      client_secret: env.YOUTUBE_CLIENT_SECRET,
      refresh_token: env.YOUTUBE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.access_token) {
    throw new Error(
      json.error_description || json.error || 'Google would not exchange the refresh token.',
    );
  }
  return json.access_token;
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
