// Login / logout for the internal ads dashboard.
//
// POST { password }        -> sets a signed httpOnly session cookie
// POST { action:'logout' } -> clears it
// GET                      -> reports whether the caller is already signed in
//
// The password never round-trips back to the client and the session cookie is
// httpOnly, so no credential is ever readable from JavaScript.

import {
  createSessionCookie, clearSessionCookie, readSession, noStore, safeEqual,
  ROLE_DAVE, ROLE_MASTER,
} from '../lib/auth.js';

// Best-effort throttle. Serverless instances are ephemeral and there may be
// several at once, so this is not a real rate limiter — it just makes a naive
// online guessing loop unpleasant. Meaningful protection comes from choosing a
// long password; a short one is guessable regardless of what this does.
const attempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;

function tooManyAttempts(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.first > WINDOW_MS) {
    attempts.set(ip, { first: now, count: 1 });
    return false;
  }
  rec.count += 1;
  return rec.count > MAX_ATTEMPTS;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  noStore(res);

  const secret = process.env.DASHBOARD_SESSION_SECRET;
  const password = process.env.DASHBOARD_PASSWORD;

  const master = process.env.DASHBOARD_MASTER_PASSWORD;

  if (req.method === 'GET') {
    const session = readSession(req, secret);
    return res.status(200).json({
      authenticated: session !== null,
      role: session ? session.role : null,
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const body = req.body || {};

  if (body.action === 'logout') {
    res.setHeader('Set-Cookie', clearSessionCookie());
    return res.status(200).json({ ok: true, authenticated: false });
  }

  // Surface configuration problems explicitly rather than rejecting every
  // login with a generic "wrong password", which would be baffling to debug.
  if (!secret || !password) {
    return res.status(500).json({
      error: 'server_misconfigured',
      message:
        'DASHBOARD_PASSWORD and DASHBOARD_SESSION_SECRET must both be set in the Vercel project environment variables.',
    });
  }

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';

  if (tooManyAttempts(ip)) {
    return res.status(429).json({
      error: 'too_many_attempts',
      message: 'Too many sign-in attempts. Wait a few minutes and try again.',
    });
  }

  // Both passwords are always compared, and the result is chosen afterwards,
  // so how long this takes does not reveal which one was closer to matching.
  // The master password only counts when it is actually configured AND is not
  // the same string as the standard one — otherwise a deployment that set them
  // identically would silently hand master access to the standard password.
  const supplied = typeof body.password === 'string' ? body.password : '';
  const matchesStandard = safeEqual(supplied, password);
  const matchesMaster = Boolean(master) && !safeEqual(master, password) && safeEqual(supplied, master);

  if (!matchesStandard && !matchesMaster) {
    // Small fixed delay so a failure is not measurably faster than a success.
    await sleep(400);
    return res.status(401).json({ error: 'invalid_password', message: 'Incorrect password.' });
  }

  const role = matchesMaster ? ROLE_MASTER : ROLE_DAVE;
  res.setHeader('Set-Cookie', createSessionCookie(secret, role));
  return res.status(200).json({ ok: true, authenticated: true, role });
}
