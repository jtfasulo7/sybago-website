// Serving an uploaded video from our own domain.
//
// TikTok's PULL_FROM_URL fetches the file itself, and refuses any host that is
// not verified in the developer portal. Videos live in Vercel Blob, on
// *.public.blob.vercel-storage.com — a domain nobody can add a verification
// record to. So the file is served through sybago.ai instead, which is a domain
// we do control and can verify.
//
// The endpoint has to be PUBLIC: TikTok's servers fetch it and carry no session
// cookie. That makes an unsigned version an open relay — anyone could point it
// at any object in the store and have our domain serve it. So every URL is
// signed and expires, and the endpoint serves nothing it did not mint.

import crypto from 'node:crypto';

/** Long enough for TikTok to fetch and transcode, short enough to be useless later. */
const TTL_MS = 6 * 60 * 60 * 1000;

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unb64url = (s) => Buffer.from(String(s), 'base64url').toString('utf8');

function sign(key, expiry, secret) {
  return crypto.createHmac('sha256', String(secret)).update(`${key}|${expiry}`).digest('base64url');
}

/**
 * Only our own store, and only a path that looks like one of our uploads.
 *
 * Checked when the URL is minted AND again when it is served: a signature
 * proves we issued it, not that what we issued was sensible.
 */
export function blobPathFromUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (!/(^|\.)blob\.vercel-storage\.com$/i.test(u.hostname)) return null;
  const path = u.pathname.replace(/^\/+/, '');
  if (!path || path.length > 300 || path.includes('..')) return null;
  return { host: u.hostname, path };
}

/** A signed, expiring URL on our own origin for a Blob video. */
export function signVideoUrl(blobUrl, origin, env = process.env, now = Date.now()) {
  const parsed = blobPathFromUrl(blobUrl);
  if (!parsed) return null;

  const secret = env.DASHBOARD_SESSION_SECRET;
  if (!secret) return null;

  // Host and path together: the store id lives in the hostname, so signing the
  // path alone would let one signature serve a file from a different store.
  const key = b64url(`${parsed.host}/${parsed.path}`);
  const expiry = now + TTL_MS;

  const u = new URL('/api/video', origin);
  u.searchParams.set('k', key);
  u.searchParams.set('e', String(expiry));
  u.searchParams.set('s', sign(key, expiry, secret));
  return u.toString();
}

/** Verify a request and return the upstream Blob URL, or a reason it is refused. */
export function resolveSignedVideo(query, env = process.env, now = Date.now()) {
  const { k, e, s } = query || {};
  if (!k || !e || !s) return { ok: false, status: 400, message: 'Incomplete link.' };

  const secret = env.DASHBOARD_SESSION_SECRET;
  if (!secret) return { ok: false, status: 500, message: 'Server is not configured to serve video.' };

  const expiry = Number(e);
  if (!Number.isFinite(expiry)) return { ok: false, status: 400, message: 'Bad link.' };
  if (now > expiry) return { ok: false, status: 410, message: 'This video link has expired.' };

  const expected = sign(String(k), String(e), secret);
  let matches = false;
  try {
    matches = crypto.timingSafeEqual(Buffer.from(String(s)), Buffer.from(expected));
  } catch {
    matches = false;                                  // length mismatch: forged
  }
  if (!matches) return { ok: false, status: 403, message: 'That link is not valid.' };

  // The signature only proves we minted it. What it points at is checked again,
  // so a signing bug can never become a way to read an arbitrary host.
  let decoded;
  try { decoded = unb64url(k); } catch { return { ok: false, status: 400, message: 'Bad link.' }; }
  const upstream = `https://${decoded}`;
  if (!blobPathFromUrl(upstream)) return { ok: false, status: 400, message: 'Bad link.' };

  return { ok: true, url: upstream };
}
