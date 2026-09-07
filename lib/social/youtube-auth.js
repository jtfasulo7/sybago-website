// Google OAuth for YouTube uploads, and keeping the refresh token alive.
//
// This exists for a different reason than its TikTok sibling. Google's refresh
// tokens do not expire on a clock, so a hand-pasted one CAN work indefinitely —
// but only if it was minted while the OAuth app's publishing status was already
// "In production". A token issued while the project sat in "Testing" dies after
// 7 DAYS, and the failure arrives as `invalid_grant`, which reads exactly like a
// wrong client secret. That trap has no signal until it fires.
//
// Getting the token by hand also means the OAuth Playground, and registering
// `https://developers.google.com/oauthplayground` as a redirect URI on a client
// of exactly the right type. Getting that wrong produces "Access blocked: this
// app's request is invalid", which reads like a verification wall and is not
// one. Running the flow here instead means the redirect URI is our own origin —
// a domain we control, register once, and cannot mistype.

import { loadJson, saveJson, storeStatus } from '../secure-store.js';

const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REVOKE = 'https://oauth2.googleapis.com/revoke';

const STORE_PATH = 'social/youtube-auth.enc';
const NAMESPACE = 'sybago:youtube-auth';

/**
 * Upload only.
 *
 * `youtube.upload` is a SENSITIVE scope, not a restricted one, so it does not
 * drag in the restricted-scope security assessment. Asking for the broader
 * `youtube` or `youtube.force-ssl` scope would buy nothing this app uses and
 * would make the eventual verification materially harder.
 */
export const SCOPES = ['https://www.googleapis.com/auth/youtube.upload'];

/** Refresh before expiry, never after: a 401 means a post has already failed. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export function youtubeConfig(env = process.env) {
  const clientId = String(env.YOUTUBE_CLIENT_ID || '').trim();
  const clientSecret = String(env.YOUTUBE_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function missingYoutubeEnv(env = process.env) {
  return ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET'].filter((n) => !String(env[n] || '').trim());
}

/**
 * The redirect Google sends the browser back to.
 *
 * Google compares this byte for byte against the registered value, twice: once
 * when issuing the code and again at the exchange. `YOUTUBE_REDIRECT_URI` pins
 * it, because deriving it from `x-forwarded-host` means reaching the dashboard
 * on a *.vercel.app host would silently send a redirect_uri that matches
 * nothing, and Google answers that with a bare `redirect_uri_mismatch`.
 */
export function redirectUri(req, env = process.env) {
  const explicit = String(env.YOUTUBE_REDIRECT_URI || '').trim();
  if (explicit) return explicit;
  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host || 'sybago.ai';
  const proto = host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https';
  return `${proto}://${host}/api/youtube-auth`;
}

export function authUrl({ clientId, redirect, state }) {
  const u = new URL(AUTHORIZE);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirect);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPES.join(' '));
  u.searchParams.set('state', state);

  /* Both of these are required, and both are silent when omitted.
     Without `access_type=offline` Google returns an access token and no refresh
     token at all. Without `prompt=consent` it omits the refresh token on every
     authorisation after the first — so re-connecting to fix a problem would
     hand back a document with no refresh token in it, and the integration would
     break again in an hour with nothing to renew from. */
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  return u.toString();
}

/** Google's token endpoint is form-encoded. JSON gets a 400. */
async function tokenRequest(body) {
  const resp = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const json = await resp.json().catch(() => ({}));

  if (!resp.ok || json.error) {
    const code = json.error || `HTTP ${resp.status}`;
    let detail = json.error_description || '';

    /* `invalid_grant` is the one worth translating. It means the refresh token
       is gone, and by far the most common cause is that it was minted while the
       OAuth app was still in "Testing" — Google expires those after 7 days. The
       raw message says only "Bad Request", which sends people to check their
       client secret. */
    if (code === 'invalid_grant') {
      detail =
        'the refresh token is no longer valid. Google expires refresh tokens after 7 days ' +
        'for apps whose publishing status is still "Testing" — check Google Auth Platform → ' +
        'Audience says "In production", then connect YouTube again.';
    }
    throw new Error(`Google refused the token request: ${code}${detail ? ` — ${detail}` : ''}`);
  }
  return json;
}

/**
 * @param previous - the stored document, when refreshing.
 *
 * A refresh response carries NO refresh_token. Shaping it without carrying the
 * old one forward would overwrite the stored document with a null, and the next
 * refresh would have nothing to present — an integration that works for exactly
 * one hour after every reconnection.
 */
function shape(json, previous = null, now = Date.now()) {
  const refreshToken = json.refresh_token || previous?.refreshToken || null;
  return {
    accessToken: json.access_token,
    refreshToken,
    scope: json.scope || previous?.scope || '',
    // An absolute instant. A stored duration is only true at the moment it was
    // written, and this document outlives that moment.
    expiresAt: now + (Number(json.expires_in) || 3600) * 1000,
    obtainedAt: previous?.obtainedAt || now,
    refreshedAt: now,
  };
}

export async function exchangeCode({ code, redirect }, env = process.env) {
  const cfg = youtubeConfig(env);
  if (!cfg) throw new Error(`Set ${missingYoutubeEnv(env).join(' and ')}.`);

  const json = await tokenRequest({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirect,
  });

  const tokens = shape(json);
  if (!tokens.refreshToken) {
    /* Refusing to store this is the point. A document with an access token and
       no refresh token looks connected, works for an hour, then fails — and the
       fix (re-authorise with prompt=consent) is invisible from the symptom. */
    throw new Error(
      'Google returned no refresh token. This happens when the account has already granted ' +
      'access and consent was not re-requested. Remove this app at ' +
      'myaccount.google.com/permissions, then connect again.',
    );
  }
  await saveJson(STORE_PATH, tokens, NAMESPACE, env);
  return tokens;
}

export async function refreshTokens(previous, env = process.env) {
  const cfg = youtubeConfig(env);
  if (!cfg) throw new Error(`Set ${missingYoutubeEnv(env).join(' and ')}.`);

  const json = await tokenRequest({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: previous.refreshToken,
    grant_type: 'refresh_token',
  });

  const tokens = shape(json, previous);
  await saveJson(STORE_PATH, tokens, NAMESPACE, env);
  return tokens;
}

/** What the UI shows, without ever touching a token value. */
export async function youtubeStatus(env = process.env) {
  const missing = missingYoutubeEnv(env);
  const store = storeStatus(env);
  if (missing.length) return { connected: false, reason: 'app', missing, store };

  let tokens = null;
  try { tokens = await loadJson(STORE_PATH, NAMESPACE, env); } catch { /* not connected */ }

  if (!tokens) {
    // A refresh token in the environment is still a connection, just one that
    // was made by hand. Reporting it as unconnected would be a lie the Connect
    // button then acts on.
    if (String(env.YOUTUBE_REFRESH_TOKEN || '').trim()) {
      return { connected: true, source: 'YOUTUBE_REFRESH_TOKEN', scope: null, store };
    }
    if (!store.configured) return { connected: false, reason: 'store', missing: [], store };
    return { connected: false, reason: 'authorise', missing: [], store };
  }

  return {
    connected: true,
    source: 'stored',
    scope: tokens.scope,
    expiresAt: tokens.expiresAt,
    obtainedAt: tokens.obtainedAt,
    store,
  };
}

/**
 * A usable access token, refreshed when it is close to expiring.
 *
 * Falls back to YOUTUBE_REFRESH_TOKEN so an existing hand-pasted setup keeps
 * working unchanged. That path cannot store the result, so it mints a fresh
 * access token on every post — one extra round trip, and correct.
 */
export async function getValidToken(env = process.env) {
  let tokens = null;
  try { tokens = await loadJson(STORE_PATH, NAMESPACE, env); } catch { /* fall through */ }

  if (!tokens) {
    const manual = String(env.YOUTUBE_REFRESH_TOKEN || '').trim();
    if (!manual) {
      return {
        token: null,
        source: null,
        message: 'YouTube is not connected. Authorise it from the Social post tab.',
      };
    }
    try {
      const cfg = youtubeConfig(env);
      if (!cfg) throw new Error(`Set ${missingYoutubeEnv(env).join(' and ')}.`);
      const json = await tokenRequest({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        refresh_token: manual,
        grant_type: 'refresh_token',
      });
      return { token: json.access_token, source: 'YOUTUBE_REFRESH_TOKEN' };
    } catch (e) {
      return { token: null, source: null, message: e.message };
    }
  }

  if (Date.now() < tokens.expiresAt - REFRESH_MARGIN_MS) {
    return { token: tokens.accessToken, source: 'stored' };
  }

  try {
    const fresh = await refreshTokens(tokens, env);
    return { token: fresh.accessToken, source: 'refreshed' };
  } catch (e) {
    return { token: null, source: null, message: e.message };
  }
}

/** Hand the refresh token back to Google, then forget it. Used on disconnect. */
export async function revoke(env = process.env) {
  let tokens = null;
  try { tokens = await loadJson(STORE_PATH, NAMESPACE, env); } catch { /* nothing stored */ }
  if (!tokens?.refreshToken) return false;
  try {
    await fetch(REVOKE, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: tokens.refreshToken }),
    });
  } catch { /* revoking is best-effort; dropping our copy is what matters */ }
  return true;
}
