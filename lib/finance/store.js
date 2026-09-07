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

import * as secure from '../secure-store.js';
import { findBlobToken, blobSetupHint } from '../blob-token.js';

const PATHNAME = 'finance/ledger.enc';

/* The ledger's namespace, and therefore its key. This exact string predates the
   shared store — changing it would derive a different key and orphan every
   ledger already saved. It is also what keeps this document's key distinct from
   the one protecting the TikTok tokens. */
const NAMESPACE = 'sybago-finance-ledger';

/** Test seam, forwarded to the shared store. */
export function useBlobClient(client) {
  secure.useBlobClient(client);
}

export function encrypt(plaintext, secret) { return secure.encrypt(plaintext, secret, NAMESPACE); }
export function decrypt(payload, secret) { return secure.decrypt(payload, secret, NAMESPACE); }

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
  return secure.loadJson(PATHNAME, NAMESPACE, env);
}

export async function saveLedger(doc, env = process.env) {
  return secure.saveJson(PATHNAME, doc, NAMESPACE, env);
}

/** Only used by the tests, and by a deliberate reset. */
export async function deleteLedger(env = process.env) {
  return secure.deleteJson(PATHNAME, env);
}
