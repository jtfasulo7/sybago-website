// Where Growth Intelligence keeps its data.
//
// Three kinds of object, all encrypted through lib/secure-store because a Blob
// store is public:
//
//   growth/db.enc              settings, the import index, manual corrections,
//                              the audit trail. Small. Versioned; a stale save
//                              is refused rather than merged.
//   growth/imports/<id>.enc    one per import: the normalised rows AND the
//                              original text exactly as it was submitted.
//                              Written once and never rewritten — reversing an
//                              import flags it in the index, it does not delete
//                              the evidence.
//   growth/meta.enc            the daily per-ad history synced from Meta.
//
// Imports are separate objects because a serverless request body is capped at
// 4.5 MB: one document holding every CSV ever uploaded would eventually stop
// saving, and it would do so on exactly the day there was the most to lose.

import * as secure from '../secure-store.js';

const NAMESPACE = 'peps-growth-intelligence';
const DB_PATH = 'growth/db.enc';
const META_PATH = 'growth/meta.enc';
const importPath = (id) => `growth/imports/${id}.enc`;

export const ID_RE = /^[a-z0-9][a-z0-9-]{3,60}$/;

export function useBlobClient(client) { secure.useBlobClient(client); }
export const storeStatus = secure.storeStatus;

export const loadDb = (env) => secure.loadJson(DB_PATH, NAMESPACE, env);
export const saveDb = (doc, env) => secure.saveJson(DB_PATH, doc, NAMESPACE, env);

export async function loadImport(id, env) {
  if (!ID_RE.test(String(id))) return null;
  return secure.loadJson(importPath(id), NAMESPACE, env);
}
export async function saveImport(imp, env) {
  if (!ID_RE.test(String(imp.id))) throw new Error('Bad import id.');
  return secure.saveJson(importPath(imp.id), imp, NAMESPACE, env);
}

/** Permanent. Only reached through the explicit Remove action. */
export async function deleteImport(id, env) {
  if (!ID_RE.test(String(id))) throw new Error('Bad import id.');
  return secure.deleteJson(importPath(id), env);
}

export const loadMeta = (env) => secure.loadJson(META_PATH, NAMESPACE, env);
export const saveMeta = (doc, env) => secure.saveJson(META_PATH, doc, NAMESPACE, env);

/** Every live import in full, for the server-side replay the weekly report needs. */
export async function loadAllImports(db, env) {
  const ids = ((db && db.imports) || []).filter((i) => !i.reverted).map((i) => i.id);
  const out = await Promise.all(ids.map((id) => loadImport(id, env).catch(() => null)));
  return out.filter(Boolean);
}
