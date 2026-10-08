// Growth Intelligence — the member database.
//
//   GET                      -> { db, store }          the document (settings, import index, corrections)
//   GET  ?import=<id>        -> { import }             one import's normalised rows
//   GET  ?import=<id>&raw=1  -> { import }             ...with the original submitted text, for audit
//   POST { op:'import', import, baseVersion }          add an import (a CSV or a pasted block)
//   PUT  { db, baseVersion, audit }                    save settings, corrections, revert/restore flags
//   DELETE ?import=<id>&baseVersion=<n>                remove one import permanently
//
// NOTHING HERE COMPUTES A FIGURE. Member history is replayed from the imports
// by assets/growth/engine.js, in the browser and in the weekly-report cron
// alike. This endpoint only guards what is allowed into storage:
//
//   - An import is written ONCE and never edited. Reversing one sets a flag in
//     the index and keeps the evidence; REMOVING one is a separate, explicit
//     DELETE that names a single import and deletes it for good.
//   - A PUT cannot add or remove imports, and cannot rewrite the audit trail —
//     it may only append to it. Removal therefore cannot happen as a side
//     effect of saving something else, and the removal itself is audited.
//   - Everything from the browser is rebuilt field by field. This is a login-
//     gated tool, and it is also a write path into a storage bill.

import crypto from 'node:crypto';
import { requireSession, noStore } from '../lib/auth.js';
import { loadDb, saveDb, loadImport, saveImport, deleteImport, storeStatus, ID_RE } from '../lib/growth/store.js';
import { withDefaults, emptyDb, SOURCES, STATUSES, EVENT_LABEL, isDay } from '../assets/growth/engine.js';

const MAX_ROWS = 20000;
const MAX_RAW = 3_000_000;
const STATUS_KEYS = new Set(STATUSES.map((s) => s[0]));
const INTERVALS = new Set(['month', 'year', 'once', 'none']);
const MANUAL_EVENTS = new Set(['joined', 'trial_started', 'trial_canceled', 'trial_declined', 'trial_ended', 'paid_verified', 'cancel_scheduled', 'churned', 'returned', 'reactivated', 'note']);
const OVERRIDE_FIELDS = new Set(['source', 'price', 'interval', 'attribution', 'name']);

const str = (v, max = 200) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').slice(0, max) : '');
const line = (v, max = 200) => str(v, max).replace(/\s+/g, ' ').trim();
const numOrNull = (v, lo = -1e7, hi = 1e7) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n * 100) / 100)) : null;
};
const dayOrNull = (v) => (isDay(v) ? v : null);
const isoOrNull = (v) => {
  const d = new Date(String(v || ''));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

function sanitiseRow(r, kind, i) {
  if (!r || typeof r !== 'object') return null;
  const out = {
    k: line(r.k, 12) || String(i),
    name: line(r.name, 120),
    email: line(r.email, 160).toLowerCase() || null,
    handle: line(r.handle, 80).toLowerCase().replace(/[^a-z0-9._-]/g, '') || null,
    joinDay: dayOrNull(r.joinDay),
    price: numOrNull(r.price, 0, 100000),
    interval: INTERVALS.has(r.interval) ? r.interval : null,
    source: SOURCES.includes(r.source) ? r.source : null,
  };
  if (!out.name && !out.email && !out.handle) return null;
  if (kind === 'csv') {
    out.profileId = line(r.profileId, 80) || null;
    out.joinAt = isoOrNull(r.joinAt);
    out.ltv = numOrNull(r.ltv, 0, 1e7);
    out.sourceRaw = line(r.sourceRaw, 120) || null;
    out.invitedBy = line(r.invitedBy, 120) || null;
    out.tier = line(r.tier, 80) || null;
  } else {
    out.status = STATUS_KEYS.has(r.status) ? r.status : 'unknown';
    for (const f of ['trialStart', 'trialEnd', 'canceledAt', 'endsAt', 'churnedAt', 'paidAt', 'returnedAt']) out[f] = dayOrNull(r[f]);
    out.approx = {};
    if (r.approx && typeof r.approx === 'object') for (const f of Object.keys(r.approx).slice(0, 10)) if (r.approx[f]) out.approx[line(f, 20)] = true;
    out.raw = str(r.raw, 2000);
  }
  return out;
}

/** An import from the browser is untrusted input. */
export function sanitiseImport(input) {
  if (!input || typeof input !== 'object') throw new Error('No import supplied.');
  const kind = input.kind === 'paste' ? 'paste' : input.kind === 'csv' ? 'csv' : null;
  if (!kind) throw new Error('An import must be a CSV or a pasted block.');
  const observedAt = isoOrNull(input.observedAt);
  if (!observedAt) throw new Error('The import has no valid date.');
  if (new Date(observedAt).getTime() > Date.now() + 36 * 3600 * 1000) throw new Error('An import cannot be dated in the future.');

  const src = Array.isArray(input.rows) ? input.rows : [];
  if (!src.length) throw new Error('There are no usable rows in this import.');
  if (src.length > MAX_ROWS) throw new Error(`That is ${src.length} rows; the limit is ${MAX_ROWS}.`);
  const rows = [];
  src.forEach((r, i) => { const s = sanitiseRow(r, kind, i); if (s) rows.push(s); });
  if (!rows.length) throw new Error('None of the rows could be identified by a name, email or username.');

  const decisions = {};
  if (input.decisions && typeof input.decisions === 'object') {
    for (const k of Object.keys(input.decisions).slice(0, MAX_ROWS)) {
      const v = input.decisions[k];
      if (typeof v === 'string' && v.length <= 200) decisions[line(k, 12)] = v;
    }
  }
  const mapping = {};
  if (input.mapping && typeof input.mapping === 'object') {
    for (const k of Object.keys(input.mapping).slice(0, 30)) { const n = Number(input.mapping[k]); if (Number.isInteger(n) && n >= 0 && n < 500) mapping[line(k, 24)] = n; }
  }
  const raw = typeof input.raw === 'string' ? input.raw : '';
  if (raw.length > MAX_RAW) throw new Error('That file is too large to store. Split the export and import it in parts.');

  return {
    kind, observedAt, rows, decisions, mapping,
    filename: line(input.filename, 160) || null,
    label: line(input.label, 80) || (kind === 'csv' ? 'Skool CSV export' : 'Pasted membership status'),
    context: STATUS_KEYS.has(input.context) ? input.context : null,
    hash: line(input.hash, 40) || null,
    note: line(input.note, 300) || null,
    raw,
  };
}

function sanitiseSettings(input) {
  const s = withDefaults(input);
  let timezone = line(s.timezone, 60) || 'America/New_York';
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch { timezone = 'America/New_York'; }
  const pct = (v) => Math.min(100, Math.max(0, Number(v) || 0));
  return {
    timezone,
    csvTimestamps: s.csvTimestamps === 'local' ? 'local' : 'utc',
    trialDays: Math.min(90, Math.max(0, Math.round(Number(s.trialDays) || 0))),
    trialAppliesFrom: dayOrNull(s.trialAppliesFrom),
    plans: (s.plans || []).slice(0, 20).map((p, i) => ({
      id: line(p.id, 24) || `plan${i}`,
      label: line(p.label, 60) || `Plan ${i + 1}`,
      price: numOrNull(p.price, 0, 100000) || 0,
      interval: INTERVALS.has(p.interval) ? p.interval : 'month',
    })),
    fees: {
      platformPct: pct(s.fees.platformPct), processingPct: pct(s.fees.processingPct),
      perTransaction: Math.min(100, Math.max(0, Number(s.fees.perTransaction) || 0)),
      networkSharePct: pct(s.fees.networkSharePct),
    },
    expenses: (s.expenses || []).slice(0, 200).map((e, i) => ({
      id: line(e.id, 24) || `exp${i}`,
      label: line(e.label, 80) || 'Expense',
      amount: numOrNull(e.amount, 0, 1e7) || 0,
      cadence: ['monthly', 'annual', 'once'].includes(e.cadence) ? e.cadence : 'monthly',
      day: dayOrNull(e.day),
    })),
    graceDays: Math.min(30, Math.max(0, Math.round(Number(s.graceDays) || 0))),
    reportEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s.reportEmail || '')) ? line(s.reportEmail, 160) : '',
  };
}

function sanitiseManual(list) {
  const out = [];
  for (const r of (Array.isArray(list) ? list : []).slice(0, 5000)) {
    if (!r || typeof r !== 'object') continue;
    const base = { id: line(r.id, 40) || crypto.randomBytes(6).toString('hex'), at: isoOrNull(r.at) || new Date().toISOString(), removed: !!r.removed };
    if (r.type === 'void') { out.push({ ...base, type: 'void', key: line(r.key, 300) }); continue; }
    const memberId = line(r.memberId, 200);
    if (!memberId) continue;
    if (r.type === 'event' && MANUAL_EVENTS.has(r.eventType) && isDay(r.day)) {
      out.push({ ...base, type: 'event', memberId, eventType: r.eventType, day: r.day, note: line(r.note, 300) });
    } else if (['payment', 'refund', 'failed_payment'].includes(r.type) && isDay(r.day)) {
      out.push({ ...base, type: r.type, memberId, day: r.day, amount: Math.abs(numOrNull(r.amount, -1e6, 1e6) || 0), note: line(r.note, 300) });
    } else if (r.type === 'override' && OVERRIDE_FIELDS.has(r.field)) {
      let value = r.value;
      if (r.field === 'price') value = numOrNull(value, 0, 100000);
      else if (r.field === 'source') value = SOURCES.includes(value) ? value : 'unknown';
      else if (r.field === 'interval') value = INTERVALS.has(value) ? value : null;
      else value = line(value, 200) || null;
      out.push({ ...base, type: 'override', memberId, field: r.field, value });
    }
  }
  return out;
}

const auditEntry = (session, action, detail) => ({ at: new Date().toISOString(), by: session.role, action: line(action, 60), detail: line(detail, 400) });

export default async function handler(req, res) {
  noStore(res);
  const session = requireSession(req, res);
  if (!session) return;

  const store = storeStatus();

  if (req.method === 'GET') {
    if (!store.configured) return res.status(200).json({ db: emptyDb(), store, saved: false });
    try {
      const id = req.query && req.query.import;
      if (id) {
        if (!ID_RE.test(String(id))) return res.status(400).json({ error: 'bad_request', message: 'Bad import id.' });
        const imp = await loadImport(id);
        if (!imp) return res.status(404).json({ error: 'not_found', message: 'That import does not exist.' });
        // The original text is only sent when it is asked for: it is the
        // largest part of the record and nothing but an audit reads it.
        if (!(req.query && req.query.raw)) { const { raw, ...rest } = imp; return res.status(200).json({ import: rest }); }
        return res.status(200).json({ import: imp });
      }
      const db = await loadDb();
      return res.status(200).json({ db: db || emptyDb(), store, saved: !!db });
    } catch (e) {
      return res.status(502).json({ error: 'store_error', message: e.message, store });
    }
  }

  if (req.method === 'DELETE') {
    if (!store.configured) return res.status(503).json({ error: 'store_unavailable', message: store.hint, store });
    const id = String((req.query && req.query.import) || '');
    if (!ID_RE.test(id)) return res.status(400).json({ error: 'bad_request', message: 'Name one import to remove.' });
    try {
      const current = (await loadDb()) || emptyDb();
      if (Number(req.query.baseVersion) !== Number(current.version || 0)) {
        return res.status(409).json({ error: 'conflict', message: 'This data was changed somewhere else after you opened it. Reload to see that version, then try again.', db: current });
      }
      const entry = (current.imports || []).find((i) => i.id === id);
      if (!entry) return res.status(404).json({ error: 'not_found', message: 'That import does not exist. It may already have been removed.' });
      const next = {
        ...current,
        imports: current.imports.filter((i) => i.id !== id),
        audit: [...(current.audit || []), auditEntry(session, 'import removed', `${entry.label || entry.kind}${entry.filename ? ` (${entry.filename})` : ''}: ${entry.rowCount} rows, dated ${String(entry.observedAt).slice(0, 10)} — deleted permanently`)].slice(-2000),
        version: (Number(current.version) || 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      // The index stops naming it first. If deleting the blob then fails, what
      // is left is an unreferenced object, which no figure can read.
      await saveDb(next);
      await deleteImport(id).catch(() => {});
      return res.status(200).json({ db: next, removed: id, store, saved: true });
    } catch (e) {
      return res.status(502).json({ error: 'store_error', message: e.message, store });
    }
  }

  if (req.method !== 'POST' && req.method !== 'PUT') {
    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!store.configured) return res.status(503).json({ error: 'store_unavailable', message: store.hint, store });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'bad_request', message: 'Nothing was sent.' });

  try {
    const current = (await loadDb()) || emptyDb();
    /* Two people importing at once must not silently drop one another's work:
       the second is told, and reloads onto the version that won. */
    if (Number(body.baseVersion) !== Number(current.version || 0)) {
      return res.status(409).json({
        error: 'conflict',
        message: 'This data was changed somewhere else after you opened it. Reload to see that version, then try again.',
        db: current,
      });
    }

    if (req.method === 'POST') {
      if (body.op !== 'import') return res.status(400).json({ error: 'bad_request', message: 'Unknown operation.' });
      let imp;
      try { imp = sanitiseImport(body.import); } catch (e) {
        return res.status(400).json({ error: 'bad_import', message: e.message });
      }
      imp.id = `imp-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
      imp.createdAt = new Date().toISOString();
      imp.createdBy = session.role;
      // The import is written before the index names it. If the second write
      // fails the blob is an unreferenced orphan, which loses nothing; the
      // other order would leave an index pointing at an import that is not there.
      await saveImport(imp);

      const entry = {
        id: imp.id, kind: imp.kind, observedAt: imp.observedAt, filename: imp.filename, label: imp.label, context: imp.context,
        hash: imp.hash, rowCount: imp.rows.length, note: imp.note, createdAt: imp.createdAt, reverted: null,
      };
      const next = {
        ...current,
        settings: sanitiseSettings(current.settings),
        imports: [...(current.imports || []), entry],
        audit: [...(current.audit || []), auditEntry(session, 'import saved', `${imp.label}${imp.filename ? ` (${imp.filename})` : ''}: ${imp.rows.length} rows, dated ${imp.observedAt.slice(0, 10)}`)].slice(-2000),
        version: (Number(current.version) || 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      await saveDb(next);
      const { raw, ...rest } = imp;
      return res.status(200).json({ db: next, import: rest, store, saved: true });
    }

    // PUT — settings, corrections, and the revert / restore flag on an import.
    const incoming = body.db && typeof body.db === 'object' ? body.db : {};
    const flags = new Map((Array.isArray(incoming.imports) ? incoming.imports : []).map((i) => [i && i.id, i]));
    const imports = (current.imports || []).map((i) => {
      const want = flags.get(i.id);
      if (!want) return i;
      const out = { ...i, label: line(want.label, 80) || i.label };
      const wasReverted = !!i.reverted;
      const nowReverted = !!want.reverted;
      if (nowReverted && !wasReverted) out.reverted = { at: new Date().toISOString(), by: session.role, reason: line(want.reverted.reason, 300) };
      else if (!nowReverted && wasReverted) out.reverted = null;
      return out;
    });
    const appended = (Array.isArray(body.audit) ? body.audit : []).slice(0, 10)
      .map((a) => auditEntry(session, a && a.action, a && a.detail)).filter((a) => a.action);
    const next = {
      version: (Number(current.version) || 0) + 1,
      updatedAt: new Date().toISOString(),
      settings: sanitiseSettings(incoming.settings || current.settings),
      imports,
      manual: sanitiseManual(incoming.manual !== undefined ? incoming.manual : current.manual),
      audit: [...(current.audit || []), ...appended].slice(-2000),
    };
    await saveDb(next);
    return res.status(200).json({ db: next, store, saved: true });
  } catch (e) {
    return res.status(502).json({ error: 'store_error', message: e.message, store });
  }
}
