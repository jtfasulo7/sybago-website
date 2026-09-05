// Session auth for the internal ads dashboard.
//
// This project has no package.json, so the serverless functions run with Node
// builtins only — no jsonwebtoken, no cookie parser. Everything here is
// node:crypto and string handling, which is enough for a signed session cookie
// and removes any dependency surface.
//
// Design: the cookie carries a base64url payload plus an HMAC-SHA256 signature
// over that payload. The server can therefore verify a session without storing
// anything, which matters on serverless where there is no shared memory.

import crypto from 'node:crypto';

const COOKIE_NAME = 'sybago_dash';
const SESSION_HOURS = 12;

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromB64url = (str) =>
  Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function sign(payloadB64, secret) {
  return b64url(crypto.createHmac('sha256', secret).update(payloadB64).digest());
}

/** Constant-time string compare that does not leak length via early return. */
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  // timingSafeEqual throws on length mismatch, so hash first to equalise length.
  const ah = crypto.createHash('sha256').update(ab).digest();
  const bh = crypto.createHash('sha256').update(bb).digest();
  return crypto.timingSafeEqual(ah, bh);
}

/** Build the Set-Cookie header value for a fresh session. */
export function createSessionCookie(secret) {
  const exp = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
  const payload = b64url(JSON.stringify({ exp }));
  const value = `${payload}.${sign(payload, secret)}`;
  const maxAge = SESSION_HOURS * 60 * 60;
  return [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',              // unreadable from JS — the whole point
    'Secure',
    'SameSite=Strict',       // not sent cross-site, so CSRF on the API is moot
    `Max-Age=${maxAge}`,
  ].join('; ');
}

/** Expire the cookie immediately. */
export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * True only if the request carries a cookie we signed and that has not expired.
 * Any malformed input returns false rather than throwing — a bad cookie is an
 * unauthenticated request, not a server error.
 */
export function hasValidSession(req, secret) {
  if (!secret) return false;
  const raw = parseCookies(req.headers?.cookie)[COOKIE_NAME];
  if (!raw) return false;

  const dot = raw.lastIndexOf('.');
  if (dot < 1) return false;

  const payloadB64 = raw.slice(0, dot);
  const givenSig = raw.slice(dot + 1);

  const expectedSig = sign(payloadB64, secret);
  let sigOk = false;
  try {
    sigOk = crypto.timingSafeEqual(Buffer.from(givenSig), Buffer.from(expectedSig));
  } catch {
    return false; // length mismatch => forged
  }
  if (!sigOk) return false;

  try {
    const { exp } = JSON.parse(fromB64url(payloadB64).toString('utf8'));
    return typeof exp === 'number' && Date.now() < exp;
  } catch {
    return false;
  }
}

/**
 * Guard for any protected endpoint. Returns true if the caller may proceed;
 * otherwise it has already written a 401 and the handler should return.
 */
export function requireSession(req, res) {
  const secret = process.env.DASHBOARD_SESSION_SECRET;
  if (!secret) {
    res.status(500).json({
      error: 'server_misconfigured',
      message: 'DASHBOARD_SESSION_SECRET is not set on this deployment.',
    });
    return false;
  }
  if (!hasValidSession(req, secret)) {
    res.status(401).json({
      error: 'unauthenticated',
      message: 'Sign in to view this data.',
    });
    return false;
  }
  return true;
}

/**
 * Responses here are per-user and behind a login, so they must never land in a
 * shared CDN cache. Vercel would otherwise happily cache a 200 at the edge and
 * serve one person's ad spend to the next request.
 */
export function noStore(res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}
