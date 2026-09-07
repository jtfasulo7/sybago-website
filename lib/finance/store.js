// Where the ledger lives.
//
// Vercel Blob, because it is already connected for the social uploader and
// needs no new infrastructure. But a Blob store is PUBLIC — anything put in it
// is served at a URL with no authentication in front of it — and this document
// is a business's revenue and costs. So it is encrypted before it is stored and
// decrypted after it is read, and the blob holds ciphertext that a URL leak
// discloses nothing from.
//
// AES-256-GCM: authenticated, so a corrupted or tampered blob fails to decrypt
// rather than quietly returning a wrong ledger.
//
// The key is derived from DASHBOARD_SESSION_SECRET, which already exists and is
// already the thing that gates this page. One secret to rotate, not two — and
// rotating it invalidates sessions and ledger reads together, which is at least
// a coherent failure rather than a confusing one.

import crypto from 'node:crypto';
import * as vercelBlob from '@vercel/blob';
import { findBlobToken, blobSetupHint } from '../blob-token.js';

/**
 * The Blob client, behind a seam.
 *
 * An ES module namespace is frozen, so a test cannot replace @vercel/blob's
 * exports the way it can replace globalThis.fetch. Rather than leave storage
 * untested — the half that can lose someone's work — the client is held in a
 * variable that a test can swap. Nothing in production calls the setter.
 */
let blob = vercelBlob;

/** Test seam. Pass nothing to restore the real client. */
export function useBlobClient(client) {
  blob = client || vercelBlob;
}

const PATHNAME = 'finance/ledger.enc';
const MAGIC = 'SYBLEDGER1';

function keyFrom(secret) {
  if (!secret || String(secret).length < 16) {
    throw new Error('DASHBOARD_SESSION_SECRET is missing or too short to derive a storage key from.');
  }
  // A fixed, distinct salt so this key can never coincide with the cookie
  // signing key, even though both come from the same secret.
  return crypto.hkdfSync('sha256', Buffer.from(String(secret)), Buffer.from('sybago-finance-ledger'), Buffer.from('aes-256-gcm'), 32);
}

export function encrypt(plaintext, secret) {
  const key = Buffer.from(keyFrom(secret));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [MAGIC, iv.toString('base64'), tag.toString('base64'), body.toString('base64')].join('.');
}

export function decrypt(payload, secret) {
  const parts = String(payload).split('.');
  if (parts.length !== 4 || parts[0] !== MAGIC) throw new Error('Stored ledger is not in a format this version understands.');
  const key = Buffer.from(keyFrom(secret));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
}

/** Is Blob storage available at all? */
export function storeStatus(env = process.env) {
  const found = findBlobToken(env);
  return {
    configured: !!found,
    tokenSource: found ? found.name : null,
    hint: found ? null : blobSetupHint(),
  };
}

/**
 * Read the ledger. Returns null when nothing has been saved yet, which is a
 * first run rather than a fault.
 */
export async function loadLedger(env = process.env) {
  const found = findBlobToken(env);
  if (!found) throw new Error(blobSetupHint());

  const { blobs } = await blob.list({ prefix: PATHNAME, token: found.token });
  const existing = blobs.find((b) => b.pathname === PATHNAME);
  if (!existing) return null;

  // Blob caches aggressively at the edge; a stale read here would silently
  // resurrect an old ledger over a newer one on the next save.
  const resp = await fetch(existing.url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Could not read the stored ledger (HTTP ${resp.status}).`);
  const payload = await resp.text();

  return JSON.parse(decrypt(payload, env.DASHBOARD_SESSION_SECRET));
}

export async function saveLedger(doc, env = process.env) {
  const found = findBlobToken(env);
  if (!found) throw new Error(blobSetupHint());

  const payload = encrypt(JSON.stringify(doc), env.DASHBOARD_SESSION_SECRET);
  await blob.put(PATHNAME, payload, {
    access: 'public',                 // the only access Blob offers; hence the encryption
    addRandomSuffix: false,           // a stable path, so it can be found again
    allowOverwrite: true,
    contentType: 'text/plain',
    cacheControlMaxAge: 0,
    token: found.token,
  });
  return doc;
}

/** Only used by the tests, and by a deliberate reset. */
export async function deleteLedger(env = process.env) {
  const found = findBlobToken(env);
  if (!found) return;
  const { blobs } = await blob.list({ prefix: PATHNAME, token: found.token });
  for (const b of blobs) await blob.del(b.url, { token: found.token });
}
