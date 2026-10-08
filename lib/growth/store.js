// Where Growth Intelligence keeps its data.
//
// Three kinds of object, all encrypted through lib/secure-store because a Blob
// store is public:
//
//   growth/db/v<version>-….enc   settings, the import index, manual
//                                corrections, the audit trail. ONE NEW OBJECT
//                                PER SAVE — see below.
//   growth/imports/<id>.enc      one per import: the normalised rows AND the
//                                original text exactly as it was submitted.
//                                Written once and never edited.
//   growth/meta/<time>-….enc     the daily per-ad history synced from Meta.
//
// NOTHING HERE IS EVER OVERWRITTEN, AND THAT IS THE WHOLE DESIGN.
//
// The first version kept the index at one fixed path, growth/db.enc, and
// overwrote it on every save. Vercel Blob serves objects through a CDN that
// keeps an overwritten object's OLD bytes for up to a minute, whatever
// cache-control asks for. So a save that followed another within that minute
// read the previous index, added its import to THAT, and wrote it back —
// dropping the import saved a moment earlier. The upload "worked", the import
// history showed fewer imports than had been made, and it changed again on
// refresh as the cache caught up. Every symptom of a lost update.
//
// A save now writes a brand-new object whose name carries its version, and a
// read asks the Blob API (not the CDN) to LIST the names and takes the highest.
// A URL that has never existed before cannot be served stale. The same applies
// to the Meta history. Old versions are pruned, keeping a few as a safety net.
//
// Imports are separate objects because a serverless request body is capped at
// 4.5 MB: one document holding every CSV ever uploaded would eventually stop
// saving, and it would do so on exactly the day there was the most to lose.

import crypto from 'node:crypto';
import * as secure from '../secure-store.js';

const NAMESPACE = 'peps-growth-intelligence';
const DB_PREFIX = 'growth/db/';
const META_PREFIX = 'growth/meta/';
const IMPORT_PREFIX = 'growth/imports/';
/* The fixed paths the first version used. Read once, as a starting point, when
   no versioned object exists yet; never written again. */
const LEGACY_DB = 'growth/db.enc';
const LEGACY_META = 'growth/meta.enc';

const KEEP_DB_VERSIONS = 12;
const KEEP_META_VERSIONS = 3;
const importPath = (id) => `${IMPORT_PREFIX}${id}.enc`;

export const ID_RE = /^[a-z0-9][a-z0-9-]{3,60}$/;

export function useBlobClient(client) { secure.useBlobClient(client); }
export const storeStatus = secure.storeStatus;

const rand = () => crypto.randomBytes(4).toString('hex');
const pad = (n, w) => String(Math.max(0, Math.floor(Number(n) || 0))).padStart(w, '0');
const dbName = (version) => `${DB_PREFIX}v${pad(version, 9)}-${pad(Date.now(), 14)}-${rand()}.enc`;
const versionKey = (pathname) => pathname.slice(0, DB_PREFIX.length + 10);        // "growth/db/v000000012"

/**
 * Which stored object is the current document.
 *
 * Highest version wins. Two objects at the same version only coexist for the
 * instant before saveDb() makes the later one back out; until then the one
 * that sorts first is read.
 */
export function pickCurrent(blobs) {
  const mine = blobs.filter((b) => b.pathname.startsWith(DB_PREFIX + 'v')).sort((a, b) => a.pathname.localeCompare(b.pathname));
  if (!mine.length) return null;
  const top = versionKey(mine[mine.length - 1].pathname);
  return mine.find((b) => versionKey(b.pathname) === top);
}

export async function loadDb(env) {
  const blobs = await secure.listBlobs(DB_PREFIX, env);
  const current = pickCurrent(blobs);
  if (current) return secure.readUrl(current.url, NAMESPACE, env);
  return secure.loadJson(LEGACY_DB, NAMESPACE, env);
}

/**
 * Save a new version. Throws an error with code 'conflict' if another save
 * claimed the same version first — the caller answers 409 and nothing is lost.
 */
export async function saveDb(doc, env) {
  const pathname = dbName(doc.version);
  await secure.writeNew(pathname, doc, NAMESPACE, env);

  const blobs = await secure.listBlobs(DB_PREFIX, env);
  const rivals = blobs.filter((b) => versionKey(b.pathname) === versionKey(pathname)).sort((a, b) => a.pathname.localeCompare(b.pathname));
  /* ANY rival means this save backs out. Not "the later name loses": the
     first writer has already listed, seen nobody, and reported success, so a
     second writer must never be able to win on a tie-break. If two land in
     the same instant both see each other and both back out — two retries,
     and nothing lost. */
  if (rivals.length > 1) {
    await secure.deleteUrls(blobs.filter((b) => b.pathname === pathname).map((b) => b.url), env).catch(() => {});
    throw Object.assign(new Error('This data was changed somewhere else at the same moment. Reload to see that version, then try again.'), { code: 'conflict' });
  }

  // Keep the most recent few versions; the rest have nothing left to say.
  const versions = [...new Set(blobs.map((b) => versionKey(b.pathname)))].sort();
  const stale = new Set(versions.slice(0, Math.max(0, versions.length - KEEP_DB_VERSIONS)));
  const doomed = blobs.filter((b) => stale.has(versionKey(b.pathname))).map((b) => b.url);
  if (doomed.length) await secure.deleteUrls(doomed, env).catch(() => {});
  return doc;
}

export async function loadImport(id, env) {
  if (!ID_RE.test(String(id))) return null;
  return secure.loadJson(importPath(id), NAMESPACE, env);
}
export async function saveImport(imp, env) {
  if (!ID_RE.test(String(imp.id))) throw new Error('Bad import id.');
  return secure.writeNew(importPath(imp.id), imp, NAMESPACE, env);
}

/** Permanent. Only reached through the explicit Remove action. */
export async function deleteImport(id, env) {
  if (!ID_RE.test(String(id))) throw new Error('Bad import id.');
  return secure.deleteJson(importPath(id), env);
}

/** Every import object in storage, whether or not the index names it. */
export async function listImportBlobs(env) {
  const blobs = await secure.listBlobs(IMPORT_PREFIX, env);
  return blobs
    .map((b) => ({ id: b.pathname.slice(IMPORT_PREFIX.length).replace(/\.enc$/, ''), uploadedAt: b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0 }))
    .filter((b) => ID_RE.test(b.id));
}

export async function loadMeta(env) {
  const blobs = (await secure.listBlobs(META_PREFIX, env)).sort((a, b) => a.pathname.localeCompare(b.pathname));
  if (blobs.length) return secure.readUrl(blobs[blobs.length - 1].url, NAMESPACE, env);
  return secure.loadJson(LEGACY_META, NAMESPACE, env);
}
export async function saveMeta(doc, env) {
  await secure.writeNew(`${META_PREFIX}${pad(Date.now(), 14)}-${rand()}.enc`, doc, NAMESPACE, env);
  const blobs = (await secure.listBlobs(META_PREFIX, env)).sort((a, b) => a.pathname.localeCompare(b.pathname));
  const doomed = blobs.slice(0, Math.max(0, blobs.length - KEEP_META_VERSIONS)).map((b) => b.url);
  if (doomed.length) await secure.deleteUrls(doomed, env).catch(() => {});
  return doc;
}

/** Every live import in full, for the server-side replay the weekly report needs. */
export async function loadAllImports(db, env) {
  const ids = ((db && db.imports) || []).filter((i) => !i.reverted).map((i) => i.id);
  const out = await Promise.all(ids.map((id) => loadImport(id, env).catch(() => null)));
  return out.filter(Boolean);
}
