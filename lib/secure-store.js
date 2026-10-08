// Small encrypted documents in Vercel Blob.
//
// A Blob store is PUBLIC — every object is served at a URL with no
// authentication in front of it — so anything private has to be ciphertext
// before it gets there. The finances ledger needed this first; OAuth refresh
// tokens need it more, since a leaked one is a live credential rather than a
// disclosure.
//
// AES-256-GCM: authenticated, so a corrupted or tampered blob fails to decrypt
// rather than quietly returning something wrong.
//
// Keys are derived per NAMESPACE from DASHBOARD_SESSION_SECRET. One secret to
// rotate, and two documents that can never be decrypted with each other's key.

import crypto from 'node:crypto';
import * as vercelBlob from '@vercel/blob';
import { findBlobToken, blobSetupHint } from './blob-token.js';

/* Written first, both accepted on read. The ledger predates this module and
   its documents are stamped SYBLEDGER1; refusing them would turn a live
   spreadsheet into an unreadable blob on deploy. */
const MAGIC = 'SYBSTORE1';
const READABLE_MAGICS = [MAGIC, 'SYBLEDGER1'];

/**
 * The Blob client, behind a seam.
 *
 * An ES module namespace is frozen, so a test cannot replace @vercel/blob's
 * exports the way it can replace globalThis.fetch. Rather than leave storage
 * untested — the half that can lose someone's work, or their credentials —
 * the client is held in a variable a test can swap. Production never calls the
 * setter.
 */
let blob = vercelBlob;

export function useBlobClient(client) {
  blob = client || vercelBlob;
}

/**
 * The namespace IS the HKDF salt, used verbatim.
 *
 * Not decorated into `sybago:${namespace}` — that would have been tidier and
 * would have changed the ledger's key, quietly making every document already in
 * the store impossible to open. A key derivation is a format: once something is
 * encrypted with it, it is frozen.
 */
function keyFor(secret, namespace) {
  if (!secret || String(secret).length < 16) {
    throw new Error('DASHBOARD_SESSION_SECRET is missing or too short to derive a storage key from.');
  }
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(String(secret)), Buffer.from(namespace), Buffer.from('aes-256-gcm'), 32),
  );
}

export function encrypt(plaintext, secret, namespace) {
  const key = keyFor(secret, namespace);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [MAGIC, iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}

export function decrypt(payload, secret, namespace) {
  const parts = String(payload).split('.');
  if (parts.length !== 4 || !READABLE_MAGICS.includes(parts[0])) {
    throw new Error('Stored document is not in a format this version understands.');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(secret, namespace), Buffer.from(parts[1], 'base64'));
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

/** Read one document. Null when nothing is stored yet, which is a first run. */
export async function loadJson(pathname, namespace, env = process.env) {
  const found = findBlobToken(env);
  if (!found) throw new Error(blobSetupHint());

  const { blobs } = await blob.list({ prefix: pathname, token: found.token });
  const existing = blobs.find((b) => b.pathname === pathname);
  if (!existing) return null;

  // Blob caches aggressively at the edge; a stale read here would resurrect an
  // old document over a newer one on the next save.
  const resp = await fetch(existing.url, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Could not read the stored document (HTTP ${resp.status}).`);

  return JSON.parse(decrypt(await resp.text(), env.DASHBOARD_SESSION_SECRET, namespace));
}

export async function saveJson(pathname, doc, namespace, env = process.env) {
  const found = findBlobToken(env);
  if (!found) throw new Error(blobSetupHint());

  await blob.put(pathname, encrypt(JSON.stringify(doc), env.DASHBOARD_SESSION_SECRET, namespace), {
    access: 'public',              // the only access Blob offers; hence the encryption
    addRandomSuffix: false,        // a stable path, so it can be found again
    allowOverwrite: true,
    contentType: 'text/plain',
    cacheControlMaxAge: 0,
    token: found.token,
  });
  return doc;
}

export async function deleteJson(pathname, env = process.env) {
  const found = findBlobToken(env);
  if (!found) return;
  const { blobs } = await blob.list({ prefix: pathname, token: found.token });
  for (const b of blobs) await blob.del(b.url, { token: found.token });
}

/* ---------------------------------------------------------------------------
   Write-once storage, for documents that change.

   saveJson() above overwrites one fixed path, and Blob's CDN goes on serving
   an overwritten object's OLD bytes for up to a minute. A read-modify-write
   that follows another inside that minute starts from the stale copy and
   silently discards the first write. That is acceptable for a document saved
   rarely by one person, and it is what lost imports in Growth Intelligence.

   The functions below never reuse a path. A caller names each write uniquely,
   finds the current one by LISTING — the list comes from the Blob API, not the
   CDN — and reads a URL that has never existed before, so it cannot be stale.
   --------------------------------------------------------------------------- */

/** Every object under a prefix, straight from the Blob API. */
export async function listBlobs(prefix, env = process.env) {
  const found = findBlobToken(env);
  if (!found) throw new Error(blobSetupHint());
  const out = [];
  let cursor;
  for (let page = 0; page < 50; page++) {
    const r = await blob.list({ prefix, token: found.token, cursor, limit: 1000 });
    for (const b of r.blobs || []) out.push(b);
    if (!r.hasMore || !r.cursor) break;
    cursor = r.cursor;
  }
  return out;
}

/** Read and decrypt one object by the URL a listing gave. */
export async function readUrl(url, namespace, env = process.env) {
  // The query string is belt and braces: the path is already unique.
  const resp = await fetch(`${url}${url.includes('?') ? '&' : '?'}nocache=${Date.now()}`, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`Could not read the stored document (HTTP ${resp.status}).`);
  return JSON.parse(decrypt(await resp.text(), env.DASHBOARD_SESSION_SECRET, namespace));
}

/** Encrypt and store at a path the caller guarantees has never been used. */
export async function writeNew(pathname, doc, namespace, env = process.env) {
  const found = findBlobToken(env);
  if (!found) throw new Error(blobSetupHint());
  await blob.put(pathname, encrypt(JSON.stringify(doc), env.DASHBOARD_SESSION_SECRET, namespace), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: false,         // a collision is a bug to hear about, not to paper over
    contentType: 'text/plain',
    token: found.token,
  });
  return doc;
}

export async function deleteUrls(urls, env = process.env) {
  const found = findBlobToken(env);
  if (!found || !urls.length) return;
  await blob.del(urls, { token: found.token });
}
