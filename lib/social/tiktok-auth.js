// TikTok OAuth, and keeping the token alive.
//
// TikTok access tokens last 24 HOURS. Refresh tokens last 365 days. That single
// fact is why this file exists: pasting an access token into an environment
// variable produces an integration that works this afternoon and is dead
// tomorrow morning, with an error that looks like a permissions problem.
//
// So the refresh token is what is stored, encrypted, and the access token is
// minted from it on demand. Nothing here is ever put in an environment
// variable by hand except the app's own client key and secret.

import { loadJson, saveJson, storeStatus } from '../secure-store.js';

const AUTHORIZE = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN = 'https://open.tiktokapis.com/v2/oauth/token/';

const STORE_PATH = 'social/tiktok-auth.enc';
const NAMESPACE = 'sybago:tiktok-auth';

/** Posting a video needs publish; the creator_info call needs basic info. */
export const SCOPES = ['user.info.basic', 'video.publish'];

/**
 * A minted token is refreshed BEFORE it expires, not after.
 *
 * Waiting for a 401 means one request has already failed, and TikTok's auth
 * errors do not distinguish "expired" from "revoked" — the first post of the
 * day would fail for a reason nobody could diagnose from the message.
 */
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

export function tiktokConfig(env = process.env) {
  const clientKey = String(env.TIKTOK_CLIENT_KEY || '').trim();
  const clientSecret = String(env.TIKTOK_CLIENT_SECRET || '').trim();
  if (!clientKey || !clientSecret) return null;
  return { clientKey, clientSecret };
}

export function missingTiktokEnv(env = process.env) {
  return ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'].filter((n) => !String(env[n] || '').trim());
}

/**
 * The redirect TikTok sends the browser back to.
 *
 * Derived from the request rather than configured, so it cannot drift from the
 * URL the app is actually reached at — TikTok rejects the token exchange if the
 * two differ by so much as a trailing slash, and the error says only
 * "invalid_request".
 */
export function redirectUri(req, env = process.env) {
  const explicit = String(env.TIKTOK_REDIRECT_URI || '').trim();
  if (explicit) return explicit;
  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host || 'sybago.ai';
  const proto = host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https';
  return `${proto}://${host}/api/tiktok-auth`;
}

export function authUrl({ clientKey, redirect, state }) {
  const u = new URL(AUTHORIZE);
  u.searchParams.set('client_key', clientKey);
  u.searchParams.set('scope', SCOPES.join(','));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', redirect);
  u.searchParams.set('state', state);
  return u.toString();
}

/** TikTok's token endpoint is form-encoded, not JSON. JSON returns a 400. */
async function tokenRequest(body) {
  const resp = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const json = await resp.json().catch(() => ({}));

  // The token endpoint reports failure in `error`, a string, rather than in the
  // `error.code` object shape the rest of the v2 API uses.
  if (!resp.ok || json.error) {
    const code = json.error || `HTTP ${resp.status}`;
    const detail = json.error_description || '';
    throw new Error(`TikTok refused the token request: ${code}${detail ? ` — ${detail}` : ''}`);
  }
  return json;
}

function shape(json, now = Date.now()) {
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    openId: json.open_id || null,
    scope: json.scope || '',
    // Absolute instants, not durations. A stored "expires_in" is only true at
    // the moment it was written, and this document outlives that moment.
    expiresAt: now + (Number(json.expires_in) || 86400) * 1000,
    refreshExpiresAt: now + (Number(json.refresh_expires_in) || 31536000) * 1000,
    obtainedAt: now,
  };
}

export async function exchangeCode({ code, redirect }, env = process.env) {
  const cfg = tiktokConfig(env);
  if (!cfg) throw new Error(`Set ${missingTiktokEnv(env).join(' and ')}.`);

  const json = await tokenRequest({
    client_key: cfg.clientKey,
    client_secret: cfg.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirect,
  });

  const tokens = shape(json);
  await saveJson(STORE_PATH, tokens, NAMESPACE, env);
  return tokens;
}

export async function refreshTokens(refreshToken, env = process.env) {
  const cfg = tiktokConfig(env);
  if (!cfg) throw new Error(`Set ${missingTiktokEnv(env).join(' and ')}.`);

  const json = await tokenRequest({
    client_key: cfg.clientKey,
    client_secret: cfg.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const tokens = shape(json);
  await saveJson(STORE_PATH, tokens, NAMESPACE, env);
  return tokens;
}

/** What the UI shows without ever touching a token value. */
export async function tiktokStatus(env = process.env) {
  const missing = missingTiktokEnv(env);
  const store = storeStatus(env);
  if (missing.length) return { connected: false, reason: 'app', missing, store };
  if (!store.configured) return { connected: false, reason: 'store', missing: [], store };

  let tokens = null;
  try { tokens = await loadJson(STORE_PATH, NAMESPACE, env); } catch { /* treated as not connected */ }
  if (!tokens) return { connected: false, reason: 'authorise', missing: [], store };

  return {
    connected: true,
    openId: tokens.openId,
    scope: tokens.scope,
    expiresAt: tokens.expiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt,
    store,
  };
}

/**
 * A usable access token, refreshed if it is close to expiring.
 *
 * Falls back to TIKTOK_ACCESS_TOKEN when nothing has been authorised, so a
 * hand-pasted token still works for a first manual test — it just stops working
 * within the day, which is the whole reason for the rest of this file.
 */
export async function getValidToken(env = process.env) {
  let tokens = null;
  try { tokens = await loadJson(STORE_PATH, NAMESPACE, env); } catch { /* fall through */ }

  if (!tokens) {
    const manual = String(env.TIKTOK_ACCESS_TOKEN || '').trim();
    if (manual) return { token: manual, source: 'TIKTOK_ACCESS_TOKEN' };
    return { token: null, source: null, message: 'TikTok is not connected. Authorise it from the Social post tab.' };
  }

  if (Date.now() < tokens.expiresAt - REFRESH_MARGIN_MS) {
    return { token: tokens.accessToken, source: 'stored' };
  }

  if (Date.now() >= tokens.refreshExpiresAt) {
    return {
      token: null,
      source: null,
      message: 'The TikTok refresh token has expired — they last a year. Authorise TikTok again.',
    };
  }

  try {
    const fresh = await refreshTokens(tokens.refreshToken, env);
    return { token: fresh.accessToken, source: 'refreshed' };
  } catch (e) {
    return { token: null, source: null, message: e.message };
  }
}
