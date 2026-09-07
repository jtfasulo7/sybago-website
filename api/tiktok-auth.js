// The TikTok OAuth round trip.
//
//   GET /api/tiktok-auth            -> redirects to TikTok to authorise
//   GET /api/tiktok-auth?code=...   -> TikTok sends the browser back here
//   GET /api/tiktok-auth?status=1   -> JSON: connected or not, and why
//
// This URL is what goes in the Redirect URI field of the TikTok developer app.
// One endpoint for both legs, because TikTok matches the redirect_uri on the
// token exchange against the one used to request the code, byte for byte — two
// URLs is two chances for them to disagree.

import crypto from 'node:crypto';
import { requireSession, noStore } from '../lib/auth.js';
import {
  authUrl,
  exchangeCode,
  missingTiktokEnv,
  redirectUri,
  tiktokConfig,
  tiktokStatus,
} from '../lib/social/tiktok-auth.js';

const STATE_COOKIE = 'sybago_tk_state';

/**
 * The state parameter, signed into a short-lived cookie.
 *
 * Without it anyone can hand this endpoint a `code` of their own and bind THEIR
 * TikTok account to this dashboard's stored credentials. The cookie proves the
 * callback belongs to the round trip this server started.
 */
function issueState(res, secret) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const sig = crypto.createHmac('sha256', secret).update(nonce).digest('hex').slice(0, 32);
  const state = `${nonce}.${sig}`;
  res.setHeader('Set-Cookie', [
    `${STATE_COOKIE}=${state}; Path=/api/tiktok-auth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
  ]);
  return state;
}

function stateMatches(req, given, secret) {
  const raw = String(req.headers?.cookie || '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${STATE_COOKIE}=`));
  if (!raw || !given) return false;

  const stored = raw.slice(STATE_COOKIE.length + 1);
  const [nonce, sig] = String(given).split('.');
  if (!nonce || !sig) return false;

  const expected = crypto.createHmac('sha256', secret).update(nonce).digest('hex').slice(0, 32);
  try {
    return (
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) &&
      crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(String(given)))
    );
  } catch {
    return false;                                  // length mismatch: forged
  }
}

function clearState(res) {
  res.setHeader('Set-Cookie', [
    `${STATE_COOKIE}=; Path=/api/tiktok-auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  ]);
}

/** A plain page, because this leg ends in a browser rather than in fetch(). */
function page(res, code, title, body) {
  res.status(code).setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body { font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif; max-width:34rem;
         margin:14vh auto; padding:0 1.25rem; color:#0f1419; }
  h1 { font-size:1.3rem; margin:0 0 .5rem; }
  p { color:rgba(15,20,25,.7); }
  a { color:#2F6779; }
</style>
<h1>${title}</h1>${body}
<p><a href="/dashboard">Back to the dashboard</a></p>`);
}

export default async function handler(req, res) {
  noStore(res);

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const secret = process.env.DASHBOARD_SESSION_SECRET;
  const q = req.query || {};

  /* ---------------------------------------------------------- status ---- */
  if (q.status) {
    // Session-gated: this reports what is connected, which is nobody's business
    // but the dashboard's.
    if (!requireSession(req, res)) return;
    try {
      return res.status(200).json(await tiktokStatus());
    } catch (e) {
      return res.status(200).json({ connected: false, reason: 'error', message: e.message });
    }
  }

  /* -------------------------------------------------------- callback ---- */
  if (q.code || q.error) {
    if (q.error) {
      clearState(res);
      return page(res, 400, 'TikTok did not authorise',
        `<p>TikTok returned <code>${String(q.error).replace(/[<>&]/g, '')}</code>. Nothing was saved.</p>`);
    }

    if (!stateMatches(req, q.state, secret)) {
      clearState(res);
      // Refusing here is the whole point of state: without it a link from
      // anywhere could bind someone else's TikTok account to this dashboard.
      return page(res, 400, 'That sign-in did not start here',
        '<p>The security check failed, so nothing was saved. Start again from the Social post tab.</p>');
    }

    try {
      const tokens = await exchangeCode(
        { code: String(q.code), redirect: redirectUri(req) },
        process.env,
      );
      clearState(res);
      // Straight back into the Social post tab, which re-reads the connection
      // on render and will now find it.
      res.status(302).setHeader('Location', '/dashboard?tiktok=connected');
      return res.end();
    } catch (e) {
      clearState(res);
      return page(res, 502, 'TikTok would not issue a token',
        `<p>${String(e.message).replace(/[<>&]/g, '')}</p>`);
    }
  }

  /* ----------------------------------------------------------- start ---- */
  // Only a signed-in dashboard user may begin the flow. The callback cannot be
  // session-gated the same way — TikTok's redirect is a fresh top-level
  // navigation — which is exactly why the state cookie carries the proof.
  if (!requireSession(req, res)) return;

  const cfg = tiktokConfig();
  if (!cfg) {
    return res.status(500).json({
      error: 'server_misconfigured',
      message: `Set ${missingTiktokEnv().join(' and ')} from the TikTok developer app, then try again.`,
    });
  }
  if (!secret) {
    return res.status(500).json({
      error: 'server_misconfigured',
      message: 'DASHBOARD_SESSION_SECRET is not set, so the sign-in cannot be secured.',
    });
  }

  const state = issueState(res, secret);
  const redirect = redirectUri(req);
  res.status(302).setHeader('Location', authUrl({ clientKey: cfg.clientKey, redirect, state }));
  res.end();
}
