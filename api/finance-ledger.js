// The ledger document: load it, save it.
//
// GET  -> { doc, store }            the saved sheet, or a seeded starting one
// PUT  -> { doc, store }            save, if nobody else saved first
//
// Only what someone TYPED crosses this boundary. Computed values are never sent
// and never stored — the browser recalculates everything from the formulas on
// every load, so a figure on screen cannot be older than the data behind it.

import { requireSession, noStore } from '../lib/auth.js';
import { loadLedger, saveLedger, storeStatus } from '../lib/finance/store.js';
import { RECURRING_COSTS } from '../lib/finance/config.js';

/**
 * The sheet someone sees the first time.
 *
 * Seeded rather than blank because an empty grid does not tell you that
 * =META("adSpend.expectedMonthTotal") exists, and a live figure nobody knows
 * how to reference is a feature that does not exist.
 */
export function seedDocument() {
  const cells = {};
  const put = (ref, cell) => { cells[ref] = cell; };
  const money = (ref, body) => put(ref, Object.assign({ fmt: 'currency' }, body));

  put('A1', { v: 'Peps by Dave — monthly cash flow' });
  put('A2', { v: 'Type a figure in column C. Rows marked live are read from Meta on every refresh.' });

  put('A4', { v: 'REVENUE' });
  put('A5', { v: 'Line' }); put('B5', { v: 'Source' }); put('C5', { v: 'Monthly' }); put('D5', { v: 'Note' });
  put('A6', { v: 'Skool community' }); put('B6', { v: 'entered' });
  money('C6', { v: 0 });
  put('D6', { v: 'Skool has no API. Type the current MRR here.' });
  put('A7', { v: '' });
  put('A9', { v: 'Total revenue' });
  money('C9', { f: '=SUM(C6:C8)' });

  put('A11', { v: 'EXPENSES' });
  put('A12', { v: 'Line' }); put('B12', { v: 'Source' }); put('C12', { v: 'Monthly' }); put('D12', { v: 'Note' });

  put('A13', { v: 'Meta ad spend — already spent' }); put('B13', { v: 'live' });
  money('C13', { f: '=META("adSpend.monthToDate")' });
  put('D13', { v: 'Month to date, in the ad account timezone.' });

  put('A14', { v: 'Meta ad spend — rest of month' }); put('B14', { v: 'live' });
  money('C14', { f: '=META("adSpend.projectedRemainder")' });
  put('D14', { f: '=META("adSpend.dailyTotal")&" a day over the "&META("adSpend.daysRemaining")&" days left in the month"' });

  put('A15', { v: 'Higgsfield' }); put('B15', { v: 'entered' });
  money('C15', { v: RECURRING_COSTS.find((c) => c.id === 'higgsfield')?.amount ?? 99 });
  put('D15', { v: 'Video generation subscription.' });

  put('A18', { v: 'Total expenses' });
  money('C18', { f: '=SUM(C13:C17)' });

  put('A20', { v: 'NET THIS MONTH' });
  money('C20', { f: '=C9-C18' });
  put('A21', { v: 'Margin' });
  put('C21', { f: '=IFERROR(C20/C9, "")', fmt: 'percent' });

  return {
    version: 1,
    rows: 40,
    cols: 6,
    cells,
    colWidths: { A: 260, B: 96, C: 130, D: 380 },
    updatedAt: null,
  };
}

/** A document from the browser is untrusted input, so it is checked, not trusted. */
export function sanitise(input) {
  if (!input || typeof input !== 'object') throw new Error('Not a ledger document.');

  const rows = Math.min(500, Math.max(1, Number(input.rows) || 40));
  const cols = Math.min(50, Math.max(1, Number(input.cols) || 6));
  const cells = {};
  const src = input.cells && typeof input.cells === 'object' ? input.cells : {};

  const keys = Object.keys(src);
  if (keys.length > 20000) throw new Error('That sheet is too large to store.');

  for (const k of keys) {
    if (!/^[A-Z]{1,3}[0-9]{1,7}$/.test(k)) continue;      // not a cell reference
    const cell = src[k];
    if (!cell || typeof cell !== 'object') continue;

    const out = {};
    if (typeof cell.f === 'string') {
      if (cell.f.length > 2000) throw new Error(`The formula in ${k} is too long.`);
      out.f = cell.f;
    } else if (typeof cell.v === 'number' || typeof cell.v === 'boolean') {
      out.v = cell.v;
    } else if (typeof cell.v === 'string') {
      if (cell.v.length > 5000) throw new Error(`The text in ${k} is too long.`);
      out.v = cell.v;
    }
    if (typeof cell.fmt === 'string'
      && ['currency', 'percent', 'number', 'integer', 'text'].includes(cell.fmt)) {
      out.fmt = cell.fmt;
    }
    if (out.f !== undefined || out.v !== undefined || out.fmt !== undefined) cells[k] = out;
  }

  const colWidths = {};
  const widths = input.colWidths && typeof input.colWidths === 'object' ? input.colWidths : {};
  for (const c of Object.keys(widths)) {
    if (!/^[A-Z]{1,3}$/.test(c)) continue;
    const w = Number(widths[c]);
    if (Number.isFinite(w)) colWidths[c] = Math.min(600, Math.max(48, Math.round(w)));
  }

  return { version: Number(input.version) || 0, rows, cols, cells, colWidths };
}

export default async function handler(req, res) {
  noStore(res);
  const session = requireSession(req, res);
  if (!session) return;

  const store = storeStatus();

  if (req.method === 'GET') {
    if (!store.configured) {
      // Not an error: the page falls back to a read-only view and says why.
      return res.status(200).json({ doc: seedDocument(), store, saved: false });
    }
    try {
      const doc = await loadLedger();
      return res.status(200).json({ doc: doc || seedDocument(), store, saved: !!doc });
    } catch (e) {
      return res.status(502).json({ error: 'store_error', message: e.message, store });
    }
  }

  if (req.method === 'PUT') {
    if (!store.configured) {
      return res.status(503).json({ error: 'store_unavailable', message: store.hint, store });
    }

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
    if (!body) return res.status(400).json({ error: 'bad_request', message: 'No document supplied.' });

    let doc;
    try { doc = sanitise(body.doc); } catch (e) {
      return res.status(400).json({ error: 'bad_document', message: e.message });
    }

    try {
      /* Last-write-wins would be fine for one person and silently destructive
         for two. The saved version is checked first, so the second person is
         told rather than overwriting work they never saw. */
      const current = await loadLedger();
      if (current && Number(body.baseVersion) !== Number(current.version)) {
        return res.status(409).json({
          error: 'conflict',
          message: 'This sheet was saved somewhere else after you opened it. Reload to see that version.',
          doc: current,
        });
      }

      doc.version = (current ? Number(current.version) || 0 : 0) + 1;
      doc.updatedAt = new Date().toISOString();
      await saveLedger(doc);
      return res.status(200).json({ doc, store, saved: true });
    } catch (e) {
      return res.status(502).json({ error: 'store_error', message: e.message, store });
    }
  }

  res.setHeader('Allow', 'GET, PUT');
  return res.status(405).json({ error: 'method_not_allowed' });
}
