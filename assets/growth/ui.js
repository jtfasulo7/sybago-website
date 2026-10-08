// Peps by Dave Growth Intelligence — the interface.
//
// Loaded lazily by dashboard.html the first time the Growth tab is opened, so
// a session that never looks at it pays nothing for it.
//
// Everything on screen is computed by ./engine.js from three things held in
// memory: the stored document, the imports it indexes, and the stored Meta
// history. Nothing is cached between renders and no figure is stored, so a
// number on screen cannot be older than the data behind it.
//
// This file is the shell, the shared widgets and the analytics pages.
// ./ui-admin.js holds the pages that CHANGE data (reconciliation, the member
// record, settings) and the AI/report page.

import * as E from './engine.js';
import { buildDemo } from './demo.js';
import { adminPages } from './ui-admin.js';

/* ------------------------------------------------------------- helpers -- */

export const h = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (n, dp) => {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const d = dp != null ? dp : Math.abs(v) >= 1000 || Number.isInteger(v) ? 0 : 2;
  return (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
};
export const int = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : Math.round(Number(n)).toLocaleString('en-US'));
export const dec = (n, dp = 1) => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toFixed(dp));
export const pct = (n, dp = 0) => (n == null || !Number.isFinite(Number(n)) ? '—' : (Number(n) * 100).toFixed(dp) + '%');
export const dayLabel = (d, year) => {
  if (!E.isDay(d)) return '—';
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: year ? 'numeric' : undefined, timeZone: 'UTC' });
};
export const dayFull = (d) => dayLabel(d, true);

/** How sure a date is, as a small tag. Never colour alone — the word is the carrier. */
export function precisionTag(precision, window) {
  if (precision === 'exact' || !precision) return '<span class="gi-tag is-ok">exact</span>';
  if (precision === 'estimated') return '<span class="gi-tag is-est">estimated</span>';
  const span = window ? `between ${window.from ? dayLabel(window.from) : 'an unknown date'} and ${dayLabel(window.to)}` : 'date unknown';
  return `<span class="gi-tag is-win" title="Only bounded by two observations">${h(span)}</span>`;
}
export const tag = (text, kind = '') => `<span class="gi-tag ${kind}">${h(text)}</span>`;

export function panel(title, body, opts = {}) {
  return `<section class="panel glass gi-panel${opts.cls ? ' ' + opts.cls : ''}"${opts.id ? ` id="${opts.id}"` : ''}>
    <div class="panel-head"><div><h2>${h(title)}</h2>${opts.sub ? `<p class="sub">${opts.sub}</p>` : ''}</div>${opts.ctl ? `<div class="panel-ctl">${opts.ctl}</div>` : ''}</div>
    ${body}</section>`;
}

/**
 * A table. cols: [{ label, cell(row) -> html, num?: true, cls? }]
 * Cell functions return HTML and are responsible for escaping their own text.
 */
export function table(cols, rows, opts = {}) {
  if (!rows.length) return `<p class="gi-empty">${h(opts.empty || 'Nothing to show for this selection.')}</p>`;
  return `<div class="table-scroll gi-scroll"><table class="gi-table"${opts.caption ? '' : ''}>
    ${opts.caption ? `<caption>${h(opts.caption)}</caption>` : ''}
    <thead><tr>${cols.map((c) => `<th scope="col"${c.num ? ' class="num"' : ''}${c.title ? ` title="${h(c.title)}"` : ''}>${h(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r, i) => `<tr${opts.rowAttr ? ' ' + opts.rowAttr(r, i) : ''}>${cols.map((c) => `<td${c.num ? ' class="num"' : ''}>${c.cell(r, i)}</td>`).join('')}</tr>`).join('')}</tbody>
    ${opts.foot ? `<tfoot>${opts.foot}</tfoot>` : ''}</table></div>`;
}

function delta(now, before, invert) {
  const d = E.pctChange(now, before);
  if (d == null) return '';
  const flat = Math.abs(d) < 0.5;
  const good = flat ? '' : (d > 0) !== !!invert ? 'is-up' : 'is-down';
  return `<span class="gi-delta ${good}">${flat ? 'no change' : `${d > 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(0)}%`} <span class="gi-delta-vs">vs previous</span></span>`;
}

/** A row of figures. item: { label, value, delta?, note?, basis? } */
export function tiles(items) {
  return `<dl class="gi-tiles">${items.map((t) => `<div class="gi-tile">
    <dt>${h(t.label)}${t.basis ? ` ${tag(t.basis, t.basisKind || 'is-est')}` : ''}</dt>
    <dd>${t.value}</dd>${t.delta || ''}${t.note ? `<p class="gi-tile-note">${t.note}</p>` : ''}</div>`).join('')}</dl>`;
}

const KIND_LABEL = { fact: 'Verified fact', verified: 'Verified fact', estimate: 'Estimate', forecast: 'Forecast', correlation: 'Correlation', missing: 'Missing information' };
export function insightList(items) {
  if (!items.length) return '<p class="gi-empty">Nothing notable yet.</p>';
  return `<ul class="gi-insights">${items.map((i) => `<li class="gi-insight k-${h(i.kind)}"><span class="gi-kind">${h(KIND_LABEL[i.kind] || i.kind)}</span><span>${h(i.text)}</span></li>`).join('')}</ul>`;
}

/* ---------------------------------------------------------------- state -- */

const PAGES = [
  ['overview', 'Overview'], ['timeline', 'Growth Timeline'], ['ads', 'Meta Ads'], ['members', 'Member Analytics'],
  ['trials', 'Free Trial Tracking'], ['revenue', 'Revenue & MRR'], ['retention', 'Retention & Churn'], ['cohorts', 'Cohort Analysis'],
  ['profit', 'Profitability'], ['ai', 'AI Insights'], ['report', 'Report'], ['recon', 'Data Reconciliation'], ['settings', 'Settings'],
];

export const S = {
  root: null, Chart: null, charts: {},
  page: 'overview',
  db: E.emptyDb(), imports: new Map(), meta: null, ctx: null,
  store: null, metaConn: null, demo: false, loaded: false, busy: '', error: '', notice: '',
  range: { preset: '30', from: null, to: null },
  timeline: { on: new Set(['spend', 'joins', 'trialStarts', 'conversions']), level: 'ad', ids: [] },
  ads: { level: 'ad', sel: null },
  members: { q: '', status: '', sel: null, limit: 60 },
  trials: { by: 'week' },
  cohorts: { grain: 'week' },
  be: null,
  recon: { mode: null, draft: null, preview: null, showRaw: null },
  ai: { log: [], asking: false, report: null, email: null },
  real: null,          // the real data, parked while demonstration data is on screen
};

const todayIn = (tz) => E.dayIn(new Date(), tz);

export function rebuild() {
  const today = todayIn(E.withDefaults(S.db.settings).timezone);
  S.ctx = E.buildContext(S.db, [...S.imports.values()], S.meta, { today, demo: S.demo });
  resolveRange();
}

function firstDay() {
  const joins = S.ctx.members.map((m) => m.joinDay).filter(Boolean).sort();
  return E.minDay(S.ctx.meta.first, joins[0]) || E.addDays(S.ctx.today, -29);
}

function resolveRange() {
  const r = S.range;
  const today = S.ctx.today;
  if (r.preset === 'custom' && E.isDay(r.from) && E.isDay(r.to) && r.from <= r.to) return;
  if (r.preset === 'all') { r.from = firstDay(); r.to = today; return; }
  const n = Number(r.preset) || 30;
  r.preset = String(n);
  r.to = today; r.from = E.addDays(today, -(n - 1));
}

/* ------------------------------------------------------------------ api -- */

export async function api(path, opts = {}) {
  let resp;
  try {
    resp = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'content-type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw Object.assign(new Error('Could not reach the server.'), { status: 0 });
  }
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw Object.assign(new Error(json.message || `The server answered HTTP ${resp.status}.`), { status: resp.status, payload: json });
  return json;
}

async function loadImports(db) {
  const want = (db.imports || []).filter((i) => !i.reverted && !S.imports.has(i.id));
  const got = await Promise.all(want.map((i) => api('/api/growth?import=' + encodeURIComponent(i.id)).then((j) => j.import).catch(() => null)));
  const failed = got.filter((x) => !x).length;
  for (const imp of got) if (imp) S.imports.set(imp.id, imp);
  if (failed) S.error = `${failed} stored import${failed === 1 ? '' : 's'} could not be read. Figures may be incomplete — reload to try again.`;
}

export async function loadAll() {
  S.busy = 'Loading…'; paintStatus();
  try {
    const [g, m] = await Promise.all([api('/api/growth'), api('/api/growth-meta').catch((e) => ({ meta: null, error: e.message }))]);
    S.db = g.db; S.store = g.store;
    S.meta = m.meta || null;
    S.metaConn = { configured: m.configured, tokenSource: m.tokenSource, accountSource: m.accountSource, error: m.error || null };
    await loadImports(S.db);
    S.loaded = true;
    if (g.recovered && g.recovered.length) {
      S.notice = `${g.recovered.length} earlier upload${g.recovered.length === 1 ? ' was' : 's were'} safely stored but missing from the list, and ${g.recovered.length === 1 ? 'has' : 'have'} been restored. Check Data Reconciliation and remove any you do not want.`;
    }
  } catch (e) {
    S.error = e.message;
  }
  S.busy = '';
  rebuild(); render();
}

/** Save the document (settings, corrections, revert flags). */
export async function saveDb(mutate, audit) {
  const next = JSON.parse(JSON.stringify(S.db));
  mutate(next);
  if (S.demo) { S.db = next; rebuild(); render(); return true; }
  S.busy = 'Saving…'; paintStatus();
  try {
    const j = await api('/api/growth', { method: 'PUT', body: { db: next, baseVersion: S.db.version || 0, audit: audit ? [audit] : [] } });
    S.db = j.db;
    await loadImports(S.db);
    S.busy = ''; S.error = '';
    rebuild(); render();
    return true;
  } catch (e) {
    S.busy = '';
    if (e.status === 409 && e.payload && e.payload.db) { S.db = e.payload.db; await loadImports(S.db); rebuild(); }
    S.error = e.message; render();
    return false;
  }
}

/**
 * Save one import. Returns a RECEIPT when — and only when — the server has
 * read the upload back out of storage, and a second, independent request has
 * then found it in the list. Anything short of that returns null and says why.
 */
export async function saveImport(imp) {
  if (S.demo) {
    const id = 'local-' + Date.now().toString(36);
    const at = new Date().toISOString();
    S.imports.set(id, { ...imp, id });
    S.db.imports.push({ id, kind: imp.kind, context: imp.context || null, observedAt: imp.observedAt, filename: imp.filename, label: imp.label, hash: imp.hash, rowCount: imp.rows.length, reverted: null, createdAt: at });
    rebuild();
    return { id, label: imp.label, filename: imp.filename, rows: imp.rows.length, savedAt: at, demo: true };
  }
  S.busy = 'Saving and confirming the upload…'; paintStatus();
  const adopt = async (db) => { if (db) { S.db = db; await loadImports(S.db); rebuild(); } };
  try {
    const j = await api('/api/growth', { method: 'POST', body: { op: 'import', import: imp, baseVersion: S.db.version || 0 } });
    if (!j.receipt || !j.receipt.verified) throw Object.assign(new Error('The server did not confirm the upload, so it is not being treated as saved.'), { payload: j });
    S.imports.set(j.import.id, j.import);
    // Ask again, from scratch, the way a page refresh would. If a refresh
    // would not show this upload, it is better to find that out now.
    const again = await api('/api/growth');
    const listed = (again.db.imports || []).some((i) => i.id === j.import.id);
    await adopt(again.db);
    S.busy = '';
    if (!listed) { S.error = 'The upload was accepted but is missing from the list on a second check. It has NOT been confirmed — reload the page before trying again.'; return null; }
    S.error = '';
    return { ...j.receipt, confirmedAt: new Date().toISOString() };
  } catch (e) {
    S.busy = '';
    await adopt(e.payload && e.payload.db).catch(() => {});
    S.error = e.status === 0 ? 'The connection dropped while saving. The upload may or may not have been stored — reload the page and check the list before trying again.' : e.message;
    return null;
  }
}

export async function syncMeta(full) {
  if (S.demo) { S.notice = 'Demonstration data is on screen. Switch it off in Settings to sync the real ad account.'; render(); return; }
  S.busy = full ? 'Re-reading the full ad history from Meta…' : 'Syncing with Meta…'; paintStatus();
  try {
    const j = await api('/api/growth-meta', { method: 'POST', body: { full: !!full } });
    S.meta = j.meta; S.metaConn = { configured: j.configured, tokenSource: j.tokenSource, accountSource: j.accountSource };
    S.error = ''; S.notice = `Meta synced: ${j.meta.daily.length.toLocaleString()} ad-days stored.`;
  } catch (e) { S.error = e.message; }
  S.busy = '';
  rebuild(); render();
}

export function setDemo(on) {
  if (on === S.demo) return;
  if (on) {
    S.real = { db: S.db, imports: S.imports, meta: S.meta };
    const d = buildDemo(todayIn(E.withDefaults(S.db.settings).timezone));
    S.db = d.db; S.imports = new Map(d.imports.map((i) => [i.id, i])); S.meta = d.meta;
  } else if (S.real) {
    S.db = S.real.db; S.imports = S.real.imports; S.meta = S.real.meta; S.real = null;
  }
  S.demo = on;
  S.settingsDraft = null;
  S.report = null;
  S.members.sel = null; S.ads.sel = null; S.timeline.ids = []; S.recon = { mode: null, draft: null, preview: null, showRaw: null }; S.ai.log = []; S.ai.report = null; S.be = null;
  S.error = ''; S.notice = '';
  rebuild(); render();
}

/* --------------------------------------------------------------- charts -- */

// Chart.js paints to a canvas, where var() does not resolve — so the palette
// lives here. Brand greens first; the two warm tones are reserved for money
// going out and people leaving, and every series also has its own dash.
const C = {
  forest: '#123B31', green: '#2C7358', sage: '#8FB8A2', clay: '#B5573B', amber: '#B8892B',
  slate: '#3F6C8C', plum: '#7A4E7E', charcoal: '#2B312E', grid: 'rgba(18,59,49,.09)', text: '#4a5a52',
};
const STYLE = {
  spend: { color: C.sage, type: 'bar' },
  joins: { color: C.forest, dash: [] },
  trialStarts: { color: C.green, dash: [6, 3] },
  trialCancels: { color: C.clay, dash: [2, 3] },
  conversions: { color: C.slate, dash: [] },
  directPaid: { color: C.slate, dash: [2, 2] },
  cancelRequests: { color: C.amber, dash: [3, 3] },
  churn: { color: C.clay, dash: [8, 4] },
  returns: { color: C.plum, dash: [4, 2, 1, 2] },
  net: { color: C.charcoal, dash: [10, 3] },
  revenue: { color: C.amber, dash: [] },
  newMrr: { color: C.amber, dash: [5, 3] },
  missing: { color: '#8a8f8c', dash: [1, 3] },
  impressions: { color: '#8a8f8c', dash: [3, 3] },
  clicks: { color: C.slate, dash: [3, 3] },
  lpv: { color: C.green, dash: [1, 2] },
  metaConv: { color: C.plum, dash: [6, 2] },
};

export function draw(id, config) {
  const canvas = S.root.querySelector('#' + id);
  if (!canvas || !S.Chart) return null;
  if (S.charts[id]) { S.charts[id].destroy(); delete S.charts[id]; }
  const base = {
    responsive: true, maintainAspectRatio: false, animation: false,
    font: { family: "Manrope, Inter, system-ui, sans-serif" },
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false }, tooltip: { backgroundColor: '#123B31', titleColor: '#F5F1E7', bodyColor: '#F5F1E7', padding: 10, boxPadding: 4 } },
  };
  config.options = { ...base, ...(config.options || {}), plugins: { ...base.plugins, ...((config.options || {}).plugins || {}) } };
  S.charts[id] = new S.Chart(canvas, config);
  return S.charts[id];
}

const axis = (pos, moneyAxis, title) => ({
  position: pos, beginAtZero: true,
  grid: { color: pos === 'left' ? C.grid : 'transparent' },
  ticks: { color: C.text, precision: 0, callback: (v) => (moneyAxis ? '$' + Number(v).toLocaleString() : Number(v).toLocaleString()) },
  title: { display: !!title, text: title, color: C.text, font: { size: 11, weight: '600' } },
});
const xAxis = (days) => ({
  grid: { display: false },
  ticks: { color: C.text, maxRotation: 0, autoSkip: true, maxTicksLimit: 10, callback(v) { return dayLabel(days[v]); } },
});

/* ---------------------------------------------------------------- shell -- */

function shell() {
  return `<div class="gi">
    <header class="gi-hero">
      <div class="gi-hero-main">
        <p class="gi-lockup"><span>Peps by Dave</span><small>Peptide community</small></p>
        <h2 class="gi-hero-title">Growth <em>Intelligence.</em></h2>
        <p class="gi-hero-sub">Ad spend, sign-ups, trials, cancellations and revenue — lined up day by day.</p>
      </div>
      <div class="gi-hero-side">
        <p class="gi-hero-side-title">On record</p>
        <ul class="gi-hero-facts" id="gi-status" role="status" aria-live="polite"></ul>
      </div>
    </header>
    <div id="gi-banner"></div>
    <div class="gi-shell">
      <nav class="gi-side" aria-label="Growth Intelligence sections">
        <label class="sr-only" for="gi-jump">Section</label>
        <select id="gi-jump" class="gi-jump" data-change="page">${PAGES.map(([k, l]) => `<option value="${k}">${h(l)}</option>`).join('')}</select>
        <div class="gi-rail"><ol class="gi-nav">${PAGES.map(([k, l], i) => `<li><button type="button" data-act="page" data-page="${k}" title="${h(l)}"><span class="gi-nav-n">${String(i + 1).padStart(2, '0')}</span><span class="gi-nav-l">${h(l)}</span></button></li>`).join('')}</ol></div>
      </nav>
      <div class="gi-main" id="gi-main" tabindex="-1"></div>
    </div>
  </div>`;
}

function paintStatus() {
  const el = S.root && S.root.querySelector('#gi-status');
  if (!el) return;
  const tick = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 10.5l3.6 3.6 7.4-8.2"/></svg>';
  const dash = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M5.5 10h9"/></svg>';
  const item = (ok, text) => `<li class="${ok ? '' : 'is-off'}">${ok ? tick : dash}<span>${h(text)}</span></li>`;
  if (S.busy) { el.innerHTML = `<li class="is-busy"><span>${h(S.busy)}</span></li>`; return; }
  const c = S.ctx;
  if (!c) { el.innerHTML = ''; return; }
  el.innerHTML =
    item(!!c.lastCsv, c.lastCsv ? `Skool export · ${dayLabel(c.lastCsv.day, true)}` : 'No Skool export yet') +
    item(c.meta.available, c.meta.available ? `Meta ads · to ${dayLabel(c.meta.last, true)}` : 'Meta ads not synced') +
    item(true, `${c.settings.timezone.split('/').pop().replace(/_/g, ' ')} time`);
}

function banner() {
  const out = [];
  if (S.demo) out.push(`<div class="gi-demo" role="note"><strong>Demonstration data.</strong> Every name and figure on screen is simulated and nothing you do here is saved. <button type="button" class="gi-link" data-act="demo-off">Return to real data</button></div>`);
  if (S.error) out.push(`<div class="notice notice-error" role="alert"><span>${h(S.error)}</span> <button type="button" class="gi-link" data-act="dismiss-error">Dismiss</button></div>`);
  if (S.notice) out.push(`<div class="notice notice-info" role="status"><span>${h(S.notice)}</span> <button type="button" class="gi-link" data-act="dismiss-notice">Dismiss</button></div>`);
  if (S.loaded && S.store && !S.store.configured && !S.demo) out.push(`<div class="notice notice-warn"><span><strong>Storage is not connected, so nothing can be saved.</strong> ${h(S.store.hint || '')}</span></div>`);
  return out.join('');
}

export function rangeBar(note) {
  const r = S.range;
  const btn = (k, l) => `<button type="button" data-act="range" data-preset="${k}" aria-pressed="${r.preset === k}">${l}</button>`;
  return `<form class="gi-range glass" data-form="range" aria-label="Date range">
    <div class="seg" role="group" aria-label="Preset ranges">${btn('7', '7 days')}${btn('14', '14 days')}${btn('30', '30 days')}${btn('90', '90 days')}${btn('all', 'All time')}</div>
    <div class="gi-range-custom">
      <label>From <input type="date" name="from" value="${h(r.from)}" max="${h(S.ctx.today)}" data-change="range-custom"></label>
      <label>To <input type="date" name="to" value="${h(r.to)}" max="${h(S.ctx.today)}" data-change="range-custom"></label>
    </div>
    <p class="gi-range-note">${dayFull(r.from)} – ${dayFull(r.to)} · ${E.diffDays(r.from, r.to) + 1} days${note ? ' · ' + note : ''}</p>
  </form>`;
}

function emptyState() {
  return `<section class="panel glass gi-panel gi-welcome">
    <h2>Nothing has been imported yet</h2>
    <p>Growth Intelligence builds a member history from your Skool exports and lines it up against the daily ad history from Meta. It needs two things to start:</p>
    <ol>
      <li><strong>A Skool member CSV.</strong> Export it from Skool and upload it under Data Reconciliation. Upload a fresh one at least weekly — departures, returns and payments are found by comparing exports.</li>
      <li><strong>The Meta ad history.</strong> One click on the Meta Ads page reads every day of delivery for every ad, and it then refreshes daily.</li>
    </ol>
    <p class="gi-actions">
      <button type="button" class="btn btn-primary" data-act="page" data-page="recon">Upload a Skool CSV</button>
      <button type="button" class="btn btn-ghost" data-act="page" data-page="ads">Sync Meta ads</button>
      <button type="button" class="btn btn-ghost" data-act="demo-on">Explore with demonstration data</button>
    </p>
  </section>`;
}

export function render() {
  if (!S.root) return;
  if (!S.root.querySelector('.gi')) S.root.innerHTML = shell();
  for (const id of Object.keys(S.charts)) { S.charts[id].destroy(); delete S.charts[id]; }
  S.root.querySelector('#gi-banner').innerHTML = banner();
  S.root.querySelectorAll('.gi-nav button').forEach((b) => {
    const on = b.dataset.page === S.page;
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  S.root.querySelector('#gi-jump').value = S.page;
  paintStatus();

  const main = S.root.querySelector('#gi-main');
  if (!S.ctx) { main.innerHTML = '<p class="gi-empty">Loading…</p>'; return; }
  const isEmpty = !S.ctx.members.length && !S.ctx.meta.available;
  const page = ALL_PAGES[S.page] || ALL_PAGES.overview;
  const keepsEmpty = ['recon', 'settings', 'ads'].includes(S.page);
  const scroll = main.scrollTop;
  main.innerHTML = isEmpty && !keepsEmpty ? emptyState() : page.html();
  if (!(isEmpty && !keepsEmpty) && page.after) page.after();
  main.scrollTop = scroll;
}

/** Current paying members, split by whether they ever had a free trial. */
function paySplit(c) {
  const paying = c.members.filter((m) => m.d.isPaying);
  const viaTrial = paying.filter((m) => m.d.hasTrial).length;
  return { viaTrial, noTrial: paying.length - viaTrial };
}

/* ------------------------------------------------------------- overview -- */

function qualityBlock() {
  const q = E.dataQuality(S.ctx).filter((w) => w.code !== 'demo');
  if (!q.length) return '';
  const warn = q.filter((w) => w.level === 'warn').length;
  return `<details class="gi-quality"${warn ? ' open' : ''}>
    <summary><strong>Data quality</strong> — ${warn ? `${warn} thing${warn === 1 ? '' : 's'} that limit what the figures below can say` : `${q.length} note${q.length === 1 ? '' : 's'}`}</summary>
    <ul>${q.map((w) => `<li class="lv-${h(w.level)}">${h(w.message)}</li>`).join('')}</ul>
  </details>`;
}

const overviewPage = {
  html() {
    const c = S.ctx; const r = S.range;
    const o = E.overview(c, r.from, r.to);
    const a = o.cur.activity; const b = o.prev.activity; const co = o.cur.cohort;
    const days = o.cur.days;
    const t = o.trials; const p = o.profitability;
    const split = paySplit(c);
    const mature = co.fullyMatured ? '' : `${co.active} of this period's trials are still running — not final.`;
    return `
    <div class="gi-pagehead"><h3>Overview</h3><p class="sub">How the business is doing in the selected period, against the one before it.</p></div>
    ${rangeBar(`compared with ${dayLabel(o.previous.from)} – ${dayLabel(o.previous.to)}`)}
    ${qualityBlock()}
    ${panel('Advertising', tiles([
      { label: 'Total ad spend', value: money(a.spend), delta: delta(a.spend, b.spend, true) },
      { label: 'Daily ad spend', value: money(a.spend / days, 2), note: 'Average per day in the period' },
      { label: 'Cost per click', value: money(a.cpc, 2), delta: delta(a.cpc, b.cpc, true) },
      { label: 'Cost per landing-page view', value: money(a.costPerLpv, 2), delta: delta(a.costPerLpv, b.costPerLpv, true) },
      { label: 'Cost per trial', value: money(co.blendedCostPerTrial, 2), basis: 'blended', note: 'All spend ÷ all trials started in the period. Not attributed to ads.' },
      { label: 'Customer acquisition cost', value: money(co.blendedCac, 2), basis: 'blended', note: mature || 'All spend ÷ every verified new paying member from this period\'s joiners, with or without a trial.' },
    ]), { sub: c.meta.available ? `From Meta, in ${h((c.meta.account && c.meta.account.timezone) || 'the ad account')} time.` : 'No Meta history stored yet.' })}
    ${panel('Membership', tiles([
      { label: 'Total members', value: int(o.members.total), note: h(o.members.totalBasis) },
      { label: 'New members', value: int(a.joins), delta: delta(a.joins, b.joins) },
      { label: 'Active free trials', value: int(o.members.activeTrials), note: 'Right now' },
      { label: 'Canceled or declined trials', value: int(a.trialCancels), delta: delta(a.trialCancels, b.trialCancels, true), note: 'Verified, in the period' },
      { label: 'Completed trials', value: int(t.matured), note: `${int(t.known)} with a verified outcome, all time` },
      { label: 'Trial-to-paid conversions', value: int(a.conversions), delta: delta(a.conversions, b.conversions), basis: a.soft.conversions ? 'dates estimated' : '', note: 'Free trials that became paying, verified by payment evidence' },
      { label: 'New paying, no trial', value: int(a.directPaid), delta: delta(a.directPaid, b.directPaid), note: `Paid to join without a trial — the offer began ${dayFull(c.settings.trialAppliesFrom)}` },
      { label: 'Paying subscribers', value: int(o.members.paying), note: `Verified, right now · ${int(split.viaTrial)} came through a free trial, ${int(split.noTrial)} never had one` },
      { label: 'Canceling — still members', value: int(o.members.canceling), note: `Asked to cancel, not yet left. ${int(a.cancelRequests)} requested in the period. Still counted as paying.` },
      { label: 'Churned subscribers', value: int(a.churn), delta: delta(a.churn, b.churn, true), note: 'Paying members who have actually left, in the period' },
      { label: 'Returning members', value: int(a.returns), delta: delta(a.returns, b.returns) },
    ]), { sub: o.members.missing ? `${int(o.members.missing)} more are missing from the latest export with no verified reason; they are in none of these counts.` : '' })}
    ${panel('Financial performance', tiles([
      { label: 'Gross MRR', value: money(o.mrr.gross), delta: delta(o.mrr.gross, o.mrr.grossBefore), note: `${int(o.mrr.payers)} verified paying members` },
      { label: 'Net MRR', value: money(o.mrr.net), note: 'After the fees in Settings' },
      { label: 'New MRR', value: money(a.newMrr), delta: delta(a.newMrr, b.newMrr), note: 'From everyone who started paying in the period' },
      { label: 'Revenue collected', value: money(a.revenue), delta: delta(a.revenue, b.revenue), basis: a.soft.revenue ? 'dates estimated' : '', note: 'Totals are Skool\'s recorded LTV' },
      { label: 'Advertising expenses', value: money(a.spend), delta: delta(a.spend, b.spend, true) },
      { label: 'Net cash contribution', value: money(a.netCash), note: `Revenue − fees (${money(a.fees)}) − ad spend − other expenses (${money(a.otherExpenses)})` },
      { label: 'Estimated CAC payback', value: p.cacPaybackMonths == null ? '—' : dec(p.cacPaybackMonths) + ' mo', basis: 'estimate', note: p.cacPaybackMonths == null ? 'Needs verified conversions and paying members.' : 'Blended CAC ÷ average monthly margin per member.' },
    ]), { sub: o.mrr.atRisk.members ? `${money(o.mrr.atRisk.gross)} of MRR belongs to ${int(o.mrr.atRisk.members)} paying member${o.mrr.atRisk.members === 1 ? '' : 's'} missing from the latest export. It is excluded above until verified.` : (o.mrr.canceling.members ? `${money(o.mrr.canceling.gross)} of the MRR above comes from ${int(o.mrr.canceling.members)} member${o.mrr.canceling.members === 1 ? '' : 's'} who ${o.mrr.canceling.members === 1 ? 'has' : 'have'} asked to cancel and will stop paying when their period ends. ` : '') + 'Trials are never counted as revenue or MRR.' })}
    ${panel('Business growth', tiles([
      { label: 'Trial-to-paid conversion', value: pct(t.rate), note: `${int(t.converted)} of ${int(t.known)} trials with a known outcome · coverage ${pct(t.coverage)}` },
      { label: 'Net member growth', value: (a.net > 0 ? '+' : '') + int(a.net), delta: delta(a.net, b.net), note: 'Joins + returns − verified departures' },
      { label: 'Revenue growth', value: E.pctChange(a.revenue, b.revenue) == null ? '—' : (E.pctChange(a.revenue, b.revenue) >= 0 ? '+' : '') + E.pctChange(a.revenue, b.revenue).toFixed(0) + '%', note: 'Collected, against the previous period' },
      { label: '30-day retention', value: pct(o.retention.r30.rate), note: `${int(o.retention.r30.retained)} of ${int(o.retention.r30.eligible - o.retention.r30.unknown)} paying members old enough to measure` },
      { label: 'Monthly churn rate', value: pct(o.retention.blendedMonthlyChurn, 1), note: o.retention.churnBasisMonths ? `Verified churn over the last ${o.retention.churnBasisMonths} complete month${o.retention.churnBasisMonths === 1 ? '' : 's'}` : 'Needs a complete month of paying members.' },
      { label: 'Advertising efficiency', value: co.blendedRoas == null ? '—' : dec(co.blendedRoas, 2) + '×', basis: 'blended', note: mature || 'Revenue so far from this period\'s joiners ÷ ad spend in the period.' },
    ]))}
    ${panel('Members and spend', `<div class="gi-chart"><canvas id="gi-ov-chart" role="img" aria-label="Daily ad spend against new member signups and new paying members"></canvas></div>`, { sub: 'Daily ad spend (bars) against signups and verified new paying members. Open Growth Timeline for the full comparison.' })}
    ${panel('What the data shows', insightList(E.insights(c)), { sub: 'Each line is labelled by what kind of statement it is. A correlation is not attribution.' })}`;
  },
  after() {
    const s = E.dailySeries(S.ctx, S.range.from, S.range.to);
    draw('gi-ov-chart', {
      type: 'bar',
      data: { labels: s.days, datasets: [
        { type: 'bar', label: 'Ad spend', data: s.metrics.spend, backgroundColor: C.sage, yAxisID: 'y', order: 3 },
        { type: 'line', label: 'New member signups', data: s.metrics.joins, borderColor: C.forest, backgroundColor: C.forest, yAxisID: 'y2', tension: 0.25, pointRadius: 0, borderWidth: 2, order: 1 },
        { type: 'line', label: 'New paying members', data: s.metrics.conversions.map((v, i) => v + s.metrics.directPaid[i]), borderColor: C.slate, backgroundColor: C.slate, borderDash: [5, 3], yAxisID: 'y2', tension: 0.25, pointRadius: 0, borderWidth: 2, order: 2 },
      ] },
      options: { scales: { x: xAxis(s.days), y: axis('left', true, 'Ad spend'), y2: axis('right', false, 'Members') }, plugins: { legend: { display: true, position: 'bottom', labels: { color: C.text, boxWidth: 18 } } } },
    });
  },
};

/* ------------------------------------------------------------- timeline -- */

function adPicker() {
  const tl = S.timeline;
  const ents = E.adEntities(S.ctx, tl.level);
  const label = tl.ids.length ? `${tl.ids.length} selected` : `All ${tl.level === 'ad' ? 'ads' : tl.level === 'adset' ? 'ad sets' : 'campaigns'}`;
  return `<div class="gi-picker">
    <div class="seg" role="group" aria-label="Filter level">
      ${[['ad', 'Ad'], ['adset', 'Ad set'], ['campaign', 'Campaign']].map(([k, l]) => `<button type="button" data-act="tl-level" data-level="${k}" aria-pressed="${tl.level === k}">${l}</button>`).join('')}
    </div>
    <details class="gi-drop">
      <summary>${h(label)}</summary>
      <div class="gi-drop-body">
        ${ents.length ? ents.map((e) => `<label class="gi-check"><input type="checkbox" data-change="tl-ad" value="${h(e.id)}"${tl.ids.includes(e.id) ? ' checked' : ''}> <span>${h(e.name)}</span> <small>${money(e.spend)} · ${e.firstDay ? dayLabel(e.firstDay) + ' – ' + dayLabel(e.lastDay) : 'no delivery'}</small></label>`).join('') : '<p class="gi-empty">No ad history stored.</p>'}
        ${tl.ids.length ? '<button type="button" class="gi-link" data-act="tl-clear">Clear selection</button>' : ''}
      </div>
    </details>
  </div>`;
}

function runStrip(from, to) {
  const sel = S.timeline.ids.length ? { level: S.timeline.level, ids: S.timeline.ids } : null;
  let ents = E.adEntities(S.ctx, 'ad', from, to).filter((e) => e.daysActive > 0);
  if (sel) {
    const ids = new Set(sel.ids);
    ents = ents.filter((e) => {
      const ad = S.ctx.meta.ads[e.id] || {};
      return sel.level === 'ad' ? ids.has(e.id) : ids.has(sel.level === 'adset' ? ad.adsetId : ad.campaignId);
    });
  }
  if (!ents.length) return '<p class="gi-empty">No ad delivered in this window.</p>';
  const total = E.diffDays(from, to) + 1;
  const rows = ents.slice(0, 14).map((e) => {
    const bars = e.runs.map((r) => {
      const left = (E.diffDays(from, r.from) / total) * 100;
      const width = (r.days / total) * 100;
      return `<span class="gi-run" style="left:${left.toFixed(3)}%;width:${Math.max(width, 0.6).toFixed(3)}%" title="${h(e.name)}: ${dayLabel(r.from)} – ${dayLabel(r.to)} · ${r.days} day${r.days === 1 ? '' : 's'} · ${money(r.spend)}"></span>`;
    }).join('');
    return `<div class="gi-runrow"><div class="gi-runmeta"><span class="gi-runname" title="${h(e.name)}">${h(e.name)}</span><span class="gi-runspend">${money(e.spend)} · ${int(e.daysActive)} day${e.daysActive === 1 ? '' : 's'}</span></div><div class="gi-runtrack">${bars}</div></div>`;
  }).join('');
  return `<div class="gi-runs" id="gi-runs">${rows}</div>${ents.length > 14 ? `<p class="gi-fine">${ents.length - 14} more ads delivered in this window; narrow the filter to see them.</p>` : ''}`;
}

const timelinePage = {
  html() {
    const c = S.ctx; const r = S.range; const tl = S.timeline;
    const sel = tl.ids.length ? { level: tl.level, ids: tl.ids } : null;
    const p = E.periodSummary(c, r.from, r.to, sel);
    const a = p.activity; const co = p.cohort;
    const chips = E.SERIES.map((s) => {
      const st = STYLE[s.key];
      const on = tl.on.has(s.key);
      const swatch = st.type === 'bar'
        ? `<svg width="22" height="10" aria-hidden="true"><rect x="2" y="1" width="18" height="8" fill="${st.color}"/></svg>`
        : `<svg width="22" height="10" aria-hidden="true"><line x1="1" y1="5" x2="21" y2="5" stroke="${st.color}" stroke-width="2.5" stroke-dasharray="${(st.dash || []).join(' ')}"/></svg>`;
      return `<button type="button" class="gi-chip" data-act="tl-metric" data-key="${s.key}" aria-pressed="${on}">${swatch}${h(s.label)}</button>`;
    }).join('');
    const trialDays = c.settings.trialDays;
    const softNote = [];
    if (a.soft.conversions) softNote.push(`${int(a.soft.conversions)} conversion date${a.soft.conversions === 1 ? ' is' : 's are'} estimated from the trial end`);
    if (a.soft.churn + a.soft.returns + a.soft.trialCancels) softNote.push(`${int(a.soft.churn + a.soft.returns + a.soft.trialCancels)} departure or return date${a.soft.churn + a.soft.returns + a.soft.trialCancels === 1 ? ' is' : 's are'} placed on the day it was observed`);
    return `
    <div class="gi-pagehead"><h3>Growth Timeline</h3><p class="sub">Advertising activity beside what the community actually did, day by day.</p></div>
    ${rangeBar()}
    ${panel('Advertising against membership', `
      <div class="gi-chips" role="group" aria-label="Metrics on the chart">${chips}</div>
      <div class="gi-chart is-tall"><canvas id="gi-tl-chart" role="img" aria-label="Daily timeline of the selected advertising and membership metrics"></canvas></div>
      <p class="gi-fine">Money on the left axis, people on the right. Hollow points are days where at least one event is dated by estimate or by the day it was observed${softNote.length ? ' — in this window, ' + softNote.join(' and ') : ''}.</p>
      <h4 class="gi-h4">Which ads were delivering</h4>
      ${runStrip(r.from, r.to)}
      <p class="gi-fine">A bar is a stretch of days Meta reported delivery. A gap is a pause or a day with no delivery.</p>
      <details class="alt"><summary>View as table</summary>${table([
        { label: 'Day', cell: (i) => dayLabel(p.series.days[i], true) },
        ...E.SERIES.filter((s) => tl.on.has(s.key)).map((s) => ({ label: s.label, num: true, cell: (i) => (s.unit === 'money' ? money(p.series.metrics[s.key][i], 2) : int(p.series.metrics[s.key][i])) + (p.series.soft[s.key][i] ? ' <abbr title="Includes estimated or observation-dated events">~</abbr>' : '') })),
      ], p.series.days.map((_, i) => i), { caption: 'The same figures the chart draws, one row per day.' })}</details>`,
    { ctl: adPicker(), sub: sel ? 'The ad filter narrows the advertising figures only. Membership is always the whole community — nothing here knows which ad a member came from.' : 'Whole ad account against the whole community.' })}

    <div class="gi-two">
      ${panel('What happened in these days', tiles([
        { label: 'Ad spend', value: money(a.spend), note: `${money(a.spend / p.days, 2)} a day` },
        { label: 'Ads delivering', value: int(p.adsRunning.length) },
        { label: 'People who joined', value: int(a.joins) },
        { label: 'Free trials started', value: int(a.trialStarts) },
        { label: 'Left the community', value: int(a.trialCancels + a.churn), note: `${int(a.trialCancels)} trial cancellations · ${int(a.churn)} paid churn — verified only` },
        { label: 'Asked to cancel', value: int(a.cancelRequests), note: 'Paying members who requested cancellation in these days. Still members until their period ends.' },
        { label: 'Returned', value: int(a.returns) },
        { label: 'Went missing', value: int(a.missing), basis: 'unverified', basisKind: 'is-win', note: 'Absent from an export observed in this window. Reason unknown.' },
        { label: 'Revenue collected', value: money(a.revenue), basis: a.soft.revenue ? 'dates estimated' : '' },
      ]), { sub: 'Activity dated inside the window.' })}
      ${panel('What became of the people who joined then', tiles([
        { label: 'Joined in the window', value: int(co.joined), note: `${int(co.trials)} started a free trial · ${int(co.joined - co.trials - co.free)} on a paid plan with no trial · ${int(co.free)} free` },
        { label: 'Eventually paid', value: int(co.newPaying), note: `${int(co.converted)} converted from a trial${co.known ? ` (${pct(co.rate)} of the ${int(co.known)} with a known outcome)` : ''} · ${int(co.directPaid)} paid with no trial`, basis: 'verified', basisKind: 'is-ok' },
        { label: 'Canceled or declined', value: int(co.nonConverted), basis: 'verified', basisKind: 'is-ok' },
        { label: 'Outcome unknown', value: int(co.unresolved), note: 'Trial ended, no payment or cancellation evidence.' },
        { label: 'Still on trial', value: int(co.active), note: co.active ? 'This cohort is not final yet.' : 'Every trial in this cohort has ended.' },
        { label: 'Later churned', value: int(co.churned), note: `${int(co.returned)} returned · ${int(co.stillPaying)} still paying${co.canceling ? `, of whom ${int(co.canceling)} canceling` : ''}` },
        { label: 'Verified revenue from this cohort', value: money(co.revenue), note: 'Everything these members have paid, to date.' },
        { label: 'Spend ÷ verified paying', value: money(co.blendedCac, 2), basis: 'blended', note: 'Not ad-level CAC: all spend in the window over every verified new paying member from it, trial or not.' },
      ]), { sub: `Followed forward however long it took. The trial is ${trialDays} days, so someone who joined on day one cannot pay before day ${trialDays + 1} — revenue on a given day belongs to an earlier cohort.` })}
    </div>

    ${panel('Ads delivering in this window', table([
      { label: 'Ad', cell: (x) => `<button type="button" class="gi-link" data-act="ad-open" data-id="${h(x.id)}">${h(x.name)}</button>` },
      { label: 'First day in window', cell: (x) => dayLabel(x.first, true) },
      { label: 'Last day in window', cell: (x) => dayLabel(x.last, true) },
      { label: 'Days delivering', num: true, cell: (x) => int(x.days) },
      { label: 'Spend', num: true, cell: (x) => money(x.spend, 2) },
      { label: 'Share of spend', num: true, cell: (x) => pct(a.spend ? x.spend / a.spend : null) },
    ], p.adsRunning, { empty: 'No ad delivered in this window.' }))}

    ${panel('Patterns', insightList(E.insights(c)), { sub: 'Computed across recent history, not only the window above.' })}`;
  },
  after() {
    const tl = S.timeline; const r = S.range;
    const sel = tl.ids.length ? { level: tl.level, ids: tl.ids } : null;
    const s = E.dailySeries(S.ctx, r.from, r.to, sel);
    const few = s.days.length <= 45;
    const datasets = E.SERIES.filter((x) => tl.on.has(x.key)).map((x) => {
      const st = STYLE[x.key];
      const moneyAxis = x.unit === 'money';
      if (st.type === 'bar') return { type: 'bar', label: x.label, data: s.metrics[x.key], backgroundColor: st.color, yAxisID: 'y', order: 10, unit: x.unit };
      return {
        type: 'line', label: x.label, data: s.metrics[x.key], borderColor: st.color, borderDash: st.dash, borderWidth: 2, tension: 0.2,
        yAxisID: moneyAxis ? 'y' : 'y2', order: 1, unit: x.unit, softCounts: s.soft[x.key],
        pointRadius: (ctx) => (s.soft[x.key][ctx.dataIndex] ? 3.5 : few ? 2 : 0),
        pointBackgroundColor: (ctx) => (s.soft[x.key][ctx.dataIndex] ? '#ffffff' : st.color),
        pointBorderColor: st.color, pointBorderWidth: 1.5,
      };
    });
    const chart = draw('gi-tl-chart', {
      type: 'bar',
      data: { labels: s.days, datasets },
      options: {
        scales: { x: xAxis(s.days), y: axis('left', true, 'Dollars'), y2: axis('right', false, 'People') },
        plugins: { tooltip: { callbacks: {
          title: (items) => dayLabel(s.days[items[0].dataIndex], true),
          label: (it) => {
            const d = it.dataset; const v = it.parsed.y;
            const soft = d.softCounts && d.softCounts[it.dataIndex];
            return ` ${d.label}: ${d.unit === 'money' ? money(v, 2) : int(v)}${soft ? ` (${soft} estimated)` : ''}`;
          },
        } } },
      },
    });
    // Line the delivery strip up with the plot area, so a bar sits under its days.
    const runs = S.root.querySelector('#gi-runs');
    if (chart && runs && chart.chartArea) {
      runs.style.setProperty('--gi-plot-left', chart.chartArea.left + 'px');
      runs.style.setProperty('--gi-plot-right', (chart.width - chart.chartArea.right) + 'px');
    }
  },
};

/* ------------------------------------------------------------- meta ads -- */

const STATUS_WORD = { ACTIVE: 'Active', PAUSED: 'Paused', ARCHIVED: 'Archived', DELETED: 'Deleted', CAMPAIGN_PAUSED: 'Campaign paused', ADSET_PAUSED: 'Ad set paused', WITH_ISSUES: 'With issues', IN_PROCESS: 'In review', DISAPPROVED: 'Disapproved' };

function adDetail(ent) {
  const c = S.ctx; const cm = ent.community;
  const changes = (c.meta.statusChanges || []).filter((x) => x.objectId === ent.id).slice(-12);
  return panel(ent.name, `
    ${tiles([
      { label: 'Began delivering', value: dayFull(ent.firstDay), note: ent.createdDay ? `Created ${dayFull(ent.createdDay)}` : '' },
      { label: ent.stillDelivering ? 'Latest delivery' : 'Stopped delivering', value: dayFull(ent.lastDay), note: ent.stillDelivering ? 'Still delivering as of the last sync.' : '' },
      { label: 'Total days active', value: int(ent.daysActive), note: ent.pauses ? `${int(ent.pauses)} pause${ent.pauses === 1 ? '' : 's'} or gap${ent.pauses === 1 ? '' : 's'} in delivery` : 'One unbroken run' },
      { label: 'Total spend', value: money(ent.spend, 2), note: `${money(ent.avgDailySpend, 2)} per active day` },
      { label: 'Clicks', value: int(ent.clicks), note: `CPC ${money(ent.cpc, 2)} · CTR ${dec(ent.ctr, 2)}%` },
      { label: 'Landing-page views', value: int(ent.lpv), note: `${money(ent.costPerLpv, 2)} each` },
      { label: 'Meta-reported conversions', value: int(ent.conv), note: ent.conv ? `${money(ent.costPerConv, 2)} each, by Meta's attribution` : 'None reported by Meta' },
      { label: 'Impressions', value: int(ent.impressions), note: `CPM ${money(ent.cpm, 2)}` },
    ])}
    <div class="gi-chart"><canvas id="gi-ad-chart" role="img" aria-label="Daily spend for this ad against community signups"></canvas></div>
    <h4 class="gi-h4">The community while this was delivering</h4>
    <div class="notice notice-info"><span><strong>Comparison, not attribution.</strong> These are whole-community figures for the ${int(ent.daysActive)} day${ent.daysActive === 1 ? '' : 's'} this ${ent.level === 'ad' ? 'ad' : ent.level} delivered. ${cm.concurrentAds ? `Up to ${int(cm.concurrentAds)} other ad${cm.concurrentAds === 1 ? ' was' : 's were'} delivering on the same days, and members also arrive from direct traffic and the Skool network.` : 'No other ad was delivering on those days, but members also arrive from direct traffic and the Skool network.'} No member is assigned to this ad.</span></div>
    ${tiles([
      { label: 'Community signups on active days', value: int(cm.joins) },
      { label: 'Of those, trials started', value: int(cm.trials) },
      { label: 'Trial conversions observed afterward', value: int(cm.converted), note: 'Trials started on those days that later paid.', basis: 'verified', basisKind: 'is-ok' },
      { label: 'Paid with no trial', value: int(cm.directPaid), note: 'Joined on those days as paying members, before the trial offer.', basis: 'verified', basisKind: 'is-ok' },
      { label: 'Canceled or declined', value: int(cm.nonConverted) },
      { label: 'Outcome unknown', value: int(cm.unresolved), note: cm.activeTrials ? `${int(cm.activeTrials)} still on trial` : '' },
      { label: 'Revenue from those joiners', value: money(cm.revenue), note: 'Recorded LTV to date.' },
    ])}
    <h4 class="gi-h4">Runs</h4>
    ${table([
      { label: 'Started', cell: (x) => dayFull(x.from) }, { label: 'Stopped', cell: (x) => dayFull(x.to) },
      { label: 'Days', num: true, cell: (x) => int(x.days) }, { label: 'Spend', num: true, cell: (x) => money(x.spend, 2) },
      { label: 'Per day', num: true, cell: (x) => money(x.spend / x.days, 2) },
    ], ent.runs, { caption: 'Stretches of consecutive days with delivery, as reported by Meta.' })}
    ${changes.length ? `<h4 class="gi-h4">Status changes</h4>${table([
      { label: 'When', cell: (x) => h(String(x.at).replace('T', ' ').slice(0, 16)) }, { label: 'From', cell: (x) => h(x.from || '—') }, { label: 'To', cell: (x) => h(x.to || '—') },
    ], changes, { caption: 'From the ad account activity log.' })}` : ''}
    <details class="alt"><summary>Daily history as a table</summary>${table([
      { label: 'Day', cell: (x) => dayLabel(x.day, true) }, { label: 'Spend', num: true, cell: (x) => money(x.spend, 2) },
      { label: 'Impressions', num: true, cell: (x) => int(x.impressions) }, { label: 'Clicks', num: true, cell: (x) => int(x.clicks) },
      { label: 'LP views', num: true, cell: (x) => int(x.lpv) }, { label: 'Meta conversions', num: true, cell: (x) => int(x.conv) },
    ], ent.daily)}</details>`,
  { id: 'gi-ad-detail', sub: [ent.campaign, ent.adset].filter(Boolean).map(h).join(' › ') + (ent.status ? ` · ${h(STATUS_WORD[ent.status] || ent.status)}` : ''), ctl: '<button type="button" class="btn btn-ghost gi-btn-sm" data-act="ad-close">Close</button>' });
}

const adsPage = {
  current() {
    const ents = E.adEntities(S.ctx, S.ads.level);
    return { ents, sel: ents.find((e) => e.id === S.ads.sel) || null };
  },
  html() {
    const c = S.ctx; const m = c.meta;
    const { ents, sel } = this.current();
    const conn = S.metaConn || {};
    const lastLog = S.meta && S.meta.log && S.meta.log[S.meta.log.length - 1];
    const sync = `<div class="gi-sync">
      <dl class="gi-facts">
        <div><dt>Ad account</dt><dd>${h((m.account && (m.account.name || m.account.id)) || '—')}</dd></div>
        <div><dt>Currency</dt><dd>${h((m.account && m.account.currency) || '—')}</dd></div>
        <div><dt>Reporting timezone</dt><dd>${h((m.account && m.account.timezone) || '—')}</dd></div>
        <div><dt>History stored</dt><dd>${m.available ? `${dayFull(m.first)} – ${dayFull(m.last)}` : 'None yet'}</dd></div>
        <div><dt>Last synced</dt><dd>${m.syncedAt ? h(new Date(m.syncedAt).toLocaleString()) : 'Never'}${lastLog ? ` <small>(${h(lastLog.trigger)}, ${h(lastLog.mode)})</small>` : ''}</dd></div>
        <div><dt>Counted under</dt><dd>${h(m.attribution || '—')}</dd></div>
      </dl>
      <p class="gi-actions">
        <button type="button" class="btn btn-primary gi-btn-sm" data-act="meta-sync">Sync now</button>
        <button type="button" class="btn btn-ghost gi-btn-sm" data-act="meta-sync-full">Re-read full history</button>
      </p>
      ${!S.demo && conn.configured === false ? `<div class="notice notice-warn"><span>Meta is not connected on this deployment. Set <code>${h(conn.tokenSource || 'META_ADS_TOKEN')}</code> and <code>${h(conn.accountSource || 'META_AD_ACCOUNT_ID')}</code>.</span></div>` : ''}
      ${lastLog && lastLog.warnings && lastLog.warnings.length ? `<ul class="gi-fine">${lastLog.warnings.map((w) => `<li>${h(w)}</li>`).join('')}</ul>` : ''}
      <p class="gi-fine">Read-only. This reads delivery and spend; it cannot pause an ad, change a budget or edit a campaign. It refreshes itself once a day and re-reads the last 35 days each time, because Meta keeps revising recent days as attribution settles.</p>
    </div>`;
    return `
    <div class="gi-pagehead"><h3>Meta Ads</h3><p class="sub">The stored daily history of every ad: when it ran, what it cost, and what the community did meanwhile.</p></div>
    ${panel('Connection and sync', sync)}
    ${panel('Advertising history', table([
      { label: S.ads.level === 'ad' ? 'Ad' : S.ads.level === 'adset' ? 'Ad set' : S.ads.level === 'campaign' ? 'Campaign' : 'Account', cell: (x) => `<button type="button" class="gi-link" data-act="ad-select" data-id="${h(x.id)}">${h(x.name)}</button>${x.level === 'ad' && x.adset ? `<br><small>${h(x.adset)}</small>` : ''}` },
      { label: 'Status', cell: (x) => (x.status ? h(STATUS_WORD[x.status] || x.status) : x.level === 'ad' ? '—' : `${int(x.adCount)} ad${x.adCount === 1 ? '' : 's'}`) },
      { label: 'Began', cell: (x) => dayLabel(x.firstDay, true) },
      { label: 'Last delivered', cell: (x) => dayLabel(x.lastDay, true) + (x.stillDelivering ? ' <small>(running)</small>' : '') },
      { label: 'Days active', num: true, cell: (x) => int(x.daysActive) },
      { label: 'Pauses', num: true, cell: (x) => int(x.pauses) },
      { label: 'Spend', num: true, cell: (x) => money(x.spend, 2) },
      { label: 'Impressions', num: true, cell: (x) => int(x.impressions) },
      { label: 'Clicks', num: true, cell: (x) => int(x.clicks) },
      { label: 'LP views', num: true, cell: (x) => int(x.lpv) },
      { label: 'CTR', num: true, cell: (x) => (x.ctr == null ? '—' : dec(x.ctr, 2) + '%') },
      { label: 'CPC', num: true, cell: (x) => money(x.cpc, 2) },
      { label: 'CPM', num: true, cell: (x) => money(x.cpm, 2) },
      { label: 'Meta conv.', num: true, title: 'Conversions as reported and attributed by Meta', cell: (x) => int(x.conv) },
      { label: 'Community signups while active', num: true, title: 'Whole-community signups on days this delivered. Not attribution.', cell: (x) => int(x.community.joins) },
    ], ents, { empty: 'No ad history stored yet. Press Sync now.', caption: 'All stored history. Select a row for its day-by-day record.', rowAttr: (x) => (x.id === S.ads.sel ? 'class="is-sel"' : '') }),
    { ctl: `<div class="seg" role="group" aria-label="Level">${[['ad', 'Ad'], ['adset', 'Ad set'], ['campaign', 'Campaign'], ['account', 'Account']].map(([k, l]) => `<button type="button" data-act="ads-level" data-level="${k}" aria-pressed="${S.ads.level === k}">${l}</button>`).join('')}</div>` })}
    ${sel ? adDetail(sel) : ''}`;
  },
  after() {
    const { sel } = this.current();
    if (!sel) return;
    const from = sel.firstDay; const to = sel.lastDay;
    if (!from) return;
    const base = E.dailySeries(S.ctx, from, to);
    const spend = new Map(sel.daily.map((r) => [r.day, r.spend]));
    draw('gi-ad-chart', {
      type: 'bar',
      data: { labels: base.days, datasets: [
        { type: 'bar', label: 'This ' + (sel.level === 'ad' ? 'ad' : sel.level) + ' — spend', data: base.days.map((d) => spend.get(d) || 0), backgroundColor: C.sage, yAxisID: 'y', order: 3 },
        { type: 'line', label: 'Community signups (all sources)', data: base.metrics.joins, borderColor: C.forest, borderWidth: 2, pointRadius: 0, tension: 0.25, yAxisID: 'y2', order: 1 },
      ] },
      options: { scales: { x: xAxis(base.days), y: axis('left', true, 'Spend'), y2: axis('right', false, 'Signups') }, plugins: { legend: { display: true, position: 'bottom', labels: { color: C.text, boxWidth: 18 } } } },
    });
  },
};

/* --------------------------------------------------------------- trials -- */

const trialsPage = {
  html() {
    const c = S.ctx;
    const t = E.trialStats(c.members);
    const by = S.trials.by;
    const rows = E.conversionBy(c, by);
    const label = { week: 'Join week', month: 'Join month', trialWeek: 'Trial-start week', plan: 'Membership plan', source: 'Acquisition source' };
    const active = c.members.filter((m) => m.d.trialOutcome === 'active').sort((a, b) => String(a.d.trialEnd).localeCompare(String(b.d.trialEnd)));
    const noTrial = c.members.filter((m) => !m.d.hasTrial && m.price > 0);
    const unresolved = c.members.filter((m) => m.d.trialOutcome === 'unresolved').sort((a, b) => String(b.d.trialEnd).localeCompare(String(a.d.trialEnd)));
    const fmtKey = (k) => (by === 'week' || by === 'trialWeek' ? (E.isDay(k) ? 'Week of ' + dayLabel(k, true) : k) : by === 'month' && /^\d{4}-\d{2}$/.test(k) ? new Date(k + '-15T12:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : k);
    const who = (m) => `<button type="button" class="gi-link" data-act="member-open" data-id="${h(m.id)}">${h(m.name)}</button>`;
    return `
    <div class="gi-pagehead"><h3>Free Trial Tracking</h3><p class="sub">Every ${c.settings.trialDays}-day trial, from start to a verified outcome. A trial ending is never taken as a payment.</p></div>
    <div class="notice notice-info"><span><strong>The free trial began ${dayFull(c.settings.trialAppliesFrom)}.</strong> Only members who joined a paid plan on or after that day are trial members. ${int(noTrial.length)} member${noTrial.length === 1 ? '' : 's'} joined a paid plan before it: they paid to join, are counted as paying members (${int(noTrial.filter((m) => m.d.isPaying).length)} still paying), and are in none of the trial counts or the conversion rate below.</span></div>
    ${panel('Where every trial stands', tiles([
      { label: 'Trials started', value: int(t.trials), note: 'All time' },
      { label: 'Trial active', value: int(t.active) },
      { label: 'Verified converted to paid', value: int(t.converted), basis: 'verified', basisKind: 'is-ok' },
      { label: 'Trial canceled', value: int(t.canceled), basis: 'verified', basisKind: 'is-ok' },
      { label: 'Trial declined', value: int(t.declined), basis: 'verified', basisKind: 'is-ok', note: 'Payment failed at the end of the trial.' },
      { label: 'Verified non-converted', value: int(t.nonConverted), note: 'Canceled + declined' },
      { label: 'Trial ended, outcome unknown', value: int(t.unresolved), basis: 'unresolved', basisKind: 'is-win' },
    ]))}
    ${panel('Trial-to-paid conversion rate', `
      <div class="gi-rate">
        <p class="gi-rate-n">${pct(t.rate, 1)}</p>
        <div>
          <p><strong>${int(t.converted)} verified converted</strong> ÷ <strong>${int(t.known)} trials with a known final outcome</strong>.</p>
          <p class="sub">Coverage ${pct(t.coverage)}: ${int(t.known)} of ${int(t.matured)} matured trials have a verified outcome. ${t.unresolved ? `The ${int(t.unresolved)} unresolved are in neither half. If every one of them failed the rate would be ${pct(t.rateFloor, 1)}; if every one converted, ${pct(t.rateCeiling, 1)}.` : 'Nothing is unresolved.'}</p>
        </div>
      </div>
      ${table([
        { label: label[by], cell: (x) => h(fmtKey(x.key)) },
        { label: 'Trials', num: true, cell: (x) => int(x.trials) },
        { label: 'Active', num: true, cell: (x) => int(x.active) },
        { label: 'Converted', num: true, cell: (x) => int(x.converted) },
        { label: 'Canceled', num: true, cell: (x) => int(x.canceled) },
        { label: 'Declined', num: true, cell: (x) => int(x.declined) },
        { label: 'Unknown', num: true, cell: (x) => int(x.unresolved) },
        { label: 'Conversion rate', num: true, cell: (x) => pct(x.rate) + (x.known < 10 && x.known > 0 ? ' <abbr title="Fewer than 10 known outcomes">*</abbr>' : '') },
        { label: 'Coverage', num: true, cell: (x) => pct(x.coverage) },
      ], rows.slice().reverse(), { caption: 'Rate = converted ÷ known outcomes. * marks a rate resting on fewer than ten outcomes.' })}`,
    { ctl: `<div class="seg" role="group" aria-label="Break down by">${Object.entries(label).map(([k, l]) => `<button type="button" data-act="trials-by" data-by="${k}" aria-pressed="${by === k}">${h(l)}</button>`).join('')}</div>` })}
    <div class="gi-two">
      ${panel(`Active trials (${active.length})`, table([
        { label: 'Member', cell: who }, { label: 'Started', cell: (m) => dayLabel(m.d.trialStart) + (m.d.trialStartInferred ? ' <abbr title="Inferred from the join date">~</abbr>' : '') },
        { label: 'Ends', cell: (m) => dayLabel(m.d.trialEnd, true) }, { label: 'Days left', num: true, cell: (m) => int(Math.max(0, E.diffDays(c.today, m.d.trialEnd))) },
        { label: 'Plan', cell: (m) => h(E.planLabel(c.settings, m)) },
      ], active.slice(0, 80), { empty: 'Nobody is on trial right now.' }))}
      ${panel(`Ended with no verified outcome (${unresolved.length})`, `${unresolved.length ? '<p class="sub" style="margin-bottom:.6rem">Paste the ended-trial and churned lists from Skool under Data Reconciliation to settle these.</p>' : ''}` + table([
        { label: 'Member', cell: who }, { label: 'Trial ended', cell: (m) => dayLabel(m.d.trialEnd, true) },
        { label: 'In latest export', cell: (m) => (m.present === true ? 'Yes' : m.present === false ? 'No' : 'Never exported') },
        { label: 'Recorded LTV', num: true, cell: (m) => money(m.ltv, 2) },
      ], unresolved.slice(0, 80), { empty: 'Every matured trial has a verified outcome.' }))}
    </div>`;
  },
};

/* -------------------------------------------------------------- revenue -- */

const revenuePage = {
  series() {
    const c = S.ctx; const r = S.range;
    const step = Math.max(1, Math.ceil((E.diffDays(r.from, r.to) + 1) / 60));
    const days = [];
    for (let d = r.from; d <= r.to; d = E.addDays(d, step)) days.push(d);
    if (days[days.length - 1] !== r.to) days.push(r.to);
    return { days, points: days.map((d) => E.mrrAt(c, d)) };
  },
  html() {
    const c = S.ctx; const r = S.range;
    const o = E.overview(c, r.from, r.to);
    const a = o.cur.activity;
    const flagged = c.members.filter((m) => m.d.flags.some((f) => ['ltv_ahead', 'ltv_behind', 'payment_overdue'].includes(f.code)));
    const f = c.settings.fees;
    const manual = c.members.flatMap((m) => m.events.filter((e) => ['payment', 'refund', 'failed_payment'].includes(e.type)).map((e) => ({ m, e })));
    return `
    <div class="gi-pagehead"><h3>Revenue &amp; MRR</h3><p class="sub">Recurring revenue from verified paying members, and cash actually collected. The two are never the same number.</p></div>
    ${rangeBar()}
    ${panel('Recurring revenue', tiles([
      { label: 'Gross MRR', value: money(o.mrr.gross), note: `${int(o.mrr.payers)} verified paying members, as of ${dayLabel(E.minDay(r.to, c.today))}` },
      { label: 'Net MRR', value: money(o.mrr.net), note: `After ${dec(f.platformPct + f.processingPct, 1)}% + ${money(f.perTransaction, 2)} per charge` },
      { label: 'New MRR', value: money(o.mrr.newMrr), note: 'Added by everyone who started paying in the period' },
      { label: 'Churned MRR', value: money(o.mrr.churnedMrr), note: 'Lost to verified churn in the period' },
      { label: 'MRR scheduled to end', value: money(o.mrr.canceling.gross), note: `${int(o.mrr.canceling.members)} canceling member${o.mrr.canceling.members === 1 ? '' : 's'}. Still included in gross MRR today.` },
    ]), { sub: 'An annual plan counts at one twelfth of its price. A trial counts at nothing until a payment is verified.' })}
    ${panel('Cash', tiles([
      { label: 'Cash collected', value: money(a.revenue), basis: a.soft.revenue ? 'dates estimated' : '', note: 'Annual payments land whole, on the day they were charged.' },
      { label: 'Fees', value: money(a.fees), note: 'Platform, processing and per-charge fees' },
      { label: 'Advertising spend', value: money(a.spend) },
      { label: 'Other expenses', value: money(a.otherExpenses), note: 'From Settings, pro-rated to the period' },
      { label: 'Net cash contribution', value: money(a.netCash) },
    ]), { sub: 'Skool reports a running lifetime total per member, not a ledger. The totals here are that recorded figure; the day each payment landed is placed on the member\'s billing date and marked as estimated unless a payment was recorded by hand.' })}
    ${panel('MRR over the period', `<div class="gi-chart"><canvas id="gi-mrr-chart" role="img" aria-label="Gross and net MRR over the selected period"></canvas></div>`)}
    ${panel('By plan', table([
      { label: 'Plan', cell: (x) => h(x.plan) }, { label: 'Paying members', num: true, cell: (x) => int(x.members) },
      { label: 'Gross MRR', num: true, cell: (x) => money(x.gross, 2) }, { label: 'Net MRR', num: true, cell: (x) => money(x.net, 2) },
    ], o.mrr.byPlan, { empty: 'No verified paying members yet.' }))}
    ${panel(`Reconciliation flags (${flagged.length})`, table([
      { label: 'Member', cell: (m) => `<button type="button" class="gi-link" data-act="member-open" data-id="${h(m.id)}">${h(m.name)}</button>` },
      { label: 'Plan', cell: (m) => h(E.planLabel(c.settings, m)) },
      { label: 'Recorded LTV', num: true, cell: (m) => money(m.ltv, 2) },
      { label: 'What does not add up', cell: (m) => m.d.flags.filter((x) => ['ltv_ahead', 'ltv_behind', 'payment_overdue'].includes(x.code)).map((x) => h(x.message)).join('<br>') },
    ], flagged.slice(0, 100), { empty: 'Every recorded LTV is explained by the member\'s price and billing dates.' }), { sub: 'Where Skool\'s recorded lifetime value and the expected billing disagree. Nothing is corrected automatically.' })}
    ${panel(`Payments recorded by hand (${manual.length})`, table([
      { label: 'Day', cell: (x) => dayLabel(x.e.day, true) }, { label: 'Member', cell: (x) => h(x.m.name) },
      { label: 'Type', cell: (x) => h(E.EVENT_LABEL[x.e.type]) }, { label: 'Amount', num: true, cell: (x) => money(x.e.data.amount, 2) },
      { label: 'Note', cell: (x) => h(x.e.data.note || '') },
    ], manual, { empty: 'None. Record a payment, refund or failed payment from a member\'s record under Member Analytics.' }))}`;
  },
  after() {
    const { days, points } = this.series();
    draw('gi-mrr-chart', {
      type: 'line',
      data: { labels: days, datasets: [
        { label: 'Gross MRR', data: points.map((p) => p.gross), borderColor: C.forest, backgroundColor: 'rgba(143,184,162,.25)', fill: true, borderWidth: 2, pointRadius: 0, tension: 0.2 },
        { label: 'Net MRR', data: points.map((p) => p.net), borderColor: C.amber, borderDash: [5, 3], borderWidth: 2, pointRadius: 0, tension: 0.2 },
      ] },
      options: { scales: { x: xAxis(days), y: axis('left', true, 'MRR') }, plugins: { legend: { display: true, position: 'bottom', labels: { color: C.text, boxWidth: 18 } } } },
    });
  },
};

/* ------------------------------------------------------------ retention -- */

const retentionPage = {
  html() {
    const c = S.ctx;
    const ret = E.retention(c);
    const cs = E.cohorts(c, 'month').filter((x) => x.newPaying > 0);
    const rate = (x) => (x.eligible - x.unknown > 0 ? `${pct(x.rate)} <small>(${int(x.retained)}/${int(x.eligible - x.unknown)})</small>` : '<small>too recent</small>');
    // Do cohorts acquired on heavier spend keep their members better or worse?
    const measurable = cs.filter((x) => x.r30.eligible - x.r30.unknown >= 5 && x.spend > 0);
    let spendNote = 'There are not yet two join-month cohorts with enough paying members past 30 days to compare retention against advertising spend.';
    if (measurable.length >= 2) {
      const sorted = measurable.slice().sort((x, y) => x.spendPerDay - y.spendPerDay);
      const half = Math.floor(sorted.length / 2);
      const pool = (list) => { const n = list.reduce((s, x) => s + x.r30.eligible - x.r30.unknown, 0); const k = list.reduce((s, x) => s + x.r30.retained, 0); return { n, rate: n ? k / n : null, spend: list.reduce((s, x) => s + x.spendPerDay, 0) / list.length }; };
      const lo = pool(sorted.slice(0, half)); const hi = pool(sorted.slice(sorted.length - half));
      spendNote = `Members who joined in the heavier-spend months (about ${money(hi.spend, 2)} a day) show ${pct(hi.rate)} 30-day retention across ${int(hi.n)} paying members; those from lighter-spend months (about ${money(lo.spend, 2)} a day) show ${pct(lo.rate)} across ${int(lo.n)}. This is a correlation across ${measurable.length} cohorts — offers, creative and seasonality changed between them too.`;
    }
    return `
    <div class="gi-pagehead"><h3>Retention &amp; Churn</h3><p class="sub">Who stays once they are paying. Churned members (gone) are kept apart from canceling members (asked to stop, still here), from trial cancellations, and from members whose status is simply unknown.</p></div>
    ${panel('Now', tiles([
      { label: 'Active paying members', value: int(ret.activePaying), basis: 'verified', basisKind: 'is-ok', note: `${int(paySplit(c).viaTrial)} came through a free trial · ${int(paySplit(c).noTrial)} never had one` },
      { label: 'Ever paid', value: int(ret.everPaid) },
      { label: 'Canceling — still members', value: int(ret.canceling), basis: 'verified', basisKind: 'is-ok', note: 'Asked to cancel, still paying until their period ends. Not churn yet.' },
      { label: 'Churned', value: int(ret.paidChurned), basis: 'verified', basisKind: 'is-ok', note: 'Paying members who have actually left' },
      { label: 'Trial cancellations', value: int(ret.trialCanceled), note: 'Never paid. Not churn.' },
      { label: 'Unknown outcome', value: int(ret.unknownOutcome), basis: 'unverified', basisKind: 'is-win', note: 'Missing from an export, or a trial with no verified end.' },
      { label: 'Returning members', value: int(ret.returning) },
    ]))}
    ${panel('Retention of paying members', tiles([
      { label: '30-day retention', value: pct(ret.r30.rate), note: `${int(ret.r30.retained)} of ${int(ret.r30.eligible - ret.r30.unknown)} still paying 30 days after their first payment` + (ret.r30.unknown ? ` · ${int(ret.r30.unknown)} unknown, excluded` : '') },
      { label: '60-day retention', value: pct(ret.r60.rate), note: `${int(ret.r60.retained)} of ${int(ret.r60.eligible - ret.r60.unknown)}` + (ret.r60.unknown ? ` · ${int(ret.r60.unknown)} unknown, excluded` : '') },
      { label: '90-day retention', value: pct(ret.r90.rate), note: `${int(ret.r90.retained)} of ${int(ret.r90.eligible - ret.r90.unknown)}` + (ret.r90.unknown ? ` · ${int(ret.r90.unknown)} unknown, excluded` : '') },
      { label: 'Monthly churn rate', value: pct(ret.blendedMonthlyChurn, 1), note: ret.churnBasisMonths ? `Last ${ret.churnBasisMonths} complete month${ret.churnBasisMonths === 1 ? '' : 's'}` : 'Needs a complete month' },
      { label: 'Median tenure', value: ret.tenure.median == null ? '—' : int(ret.tenure.median) + ' days', note: `Of ${int(ret.tenure.n)} currently paying · mean ${ret.tenure.mean == null ? '—' : int(ret.tenure.mean) + ' days'}` },
    ]), { sub: 'A member only counts toward a window once they are old enough to have reached it. Members who went missing inside the window are excluded rather than guessed at.' })}
    ${panel('Month by month', table([
      { label: 'Month', cell: (x) => h(x.key) + (x.partial ? ' <small>(in progress)</small>' : '') },
      { label: 'Paying at start', num: true, cell: (x) => int(x.startPayers) },
      { label: 'New paying', num: true, cell: (x) => int(x.newPaying) },
      { label: 'Paid churn', num: true, cell: (x) => int(x.churned) + (x.soft ? ` <abbr title="${x.soft} dated by observation, not an exact date">~</abbr>` : '') },
      { label: 'Churn rate', num: true, cell: (x) => pct(x.churnRate, 1) },
      { label: 'MRR at start', num: true, cell: (x) => money(x.startMrr) },
      { label: 'Churned MRR', num: true, cell: (x) => money(x.churnedMrr) },
      { label: 'Revenue churn', num: true, cell: (x) => pct(x.revenueChurn, 1) },
    ], ret.months.slice().reverse(), { empty: 'No paying members yet.', caption: 'Churn rate = verified paid churn in the month ÷ paying members at its start.' }))}
    <div class="gi-two">
      ${panel('Retention by join-date cohort', table([
        { label: 'Joined in', cell: (x) => h(x.key.slice(0, 7)) }, { label: 'New paying', num: true, cell: (x) => int(x.newPaying) },
        { label: 'Ad spend / day', num: true, cell: (x) => money(x.spendPerDay, 2) },
        { label: '30 days', num: true, cell: (x) => rate(x.r30) }, { label: '60 days', num: true, cell: (x) => rate(x.r60) }, { label: '90 days', num: true, cell: (x) => rate(x.r90) },
      ], cs.slice().reverse(), { empty: 'No cohort has a verified paying member yet.' }), { sub: `<span class="gi-kind">Correlation</span> ${h(spendNote)}` })}
      ${panel('Tenure of current paying members', table([
        { label: 'Paying for', cell: (x) => h(x.label) }, { label: 'Members', num: true, cell: (x) => int(x.count) },
        { label: 'Share', num: true, cell: (x) => pct(ret.tenure.n ? x.count / ret.tenure.n : null) },
      ], ret.tenure.buckets))}
    </div>`;
  },
};

/* -------------------------------------------------------------- cohorts -- */

const cohortsPage = {
  html() {
    const c = S.ctx; const g = S.cohorts.grain;
    const cs = E.cohorts(c, g);
    const name = (x) => (g === 'month' ? new Date(x.key.slice(0, 7) + '-15T12:00:00Z').toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : 'Wk of ' + dayLabel(x.key, true));
    return `
    <div class="gi-pagehead"><h3>Cohort Analysis</h3><p class="sub">Members grouped by when they joined, followed forward — so advertising in a period is judged by what its joiners went on to do, not by revenue that happened to land in the same days.</p></div>
    ${panel('Conversion by cohort against spend', `<div class="gi-chart"><canvas id="gi-co-chart" role="img" aria-label="Ad spend per cohort against trials started and verified conversions"></canvas></div>`, { sub: 'Ad spend during each cohort\'s join period, beside the trials it started and how many are verified paying.' })}
    ${panel('Acquisition cohorts', table([
      { label: 'Cohort', cell: (x) => h(name(x)) },
      { label: 'Ad spend', num: true, cell: (x) => money(x.spend) },
      { label: 'Joined', num: true, cell: (x) => int(x.joined) },
      { label: 'Trials', num: true, cell: (x) => int(x.trials) },
      { label: 'Trial → paid', num: true, title: 'Trials verified converted to paid', cell: (x) => int(x.converted) },
      { label: 'Paid, no trial', num: true, title: 'Joined as paying members without a trial', cell: (x) => int(x.directPaid) },
      { label: 'Canceled / declined', num: true, cell: (x) => int(x.nonConverted) },
      { label: 'Unknown', num: true, cell: (x) => int(x.unresolved) },
      { label: 'On trial', num: true, cell: (x) => (x.active ? `<strong>${int(x.active)}</strong>` : '0') },
      { label: 'Conv. rate', num: true, title: 'Verified converted ÷ known outcomes', cell: (x) => pct(x.rate) },
      { label: 'Later churned', num: true, cell: (x) => int(x.churned) },
      { label: 'Returned', num: true, cell: (x) => int(x.returned) },
      { label: 'Still paying', num: true, cell: (x) => int(x.stillPaying) },
      { label: 'Revenue to date', num: true, cell: (x) => money(x.revenue) },
      { label: 'Spend ÷ trial', num: true, title: 'Blended. Not attributed.', cell: (x) => money(x.blendedCostPerTrial, 2) },
      { label: 'Spend ÷ paid', num: true, title: 'Blended. Not attributed.', cell: (x) => (x.active ? '<small>not final</small>' : money(x.blendedCac, 2)) },
      { label: 'Revenue ÷ spend', num: true, title: 'Blended. Not attributed.', cell: (x) => (x.blendedRoas == null ? '—' : dec(x.blendedRoas, 2) + '×') },
    ], cs.slice().reverse(), { empty: 'No members with a join date yet.', caption: 'Spend-based columns are blended: all ad spend in the cohort period over every member who joined in it, from any source.' }),
    { ctl: `<div class="seg" role="group" aria-label="Group by">${[['week', 'By week'], ['month', 'By month']].map(([k, l]) => `<button type="button" data-act="cohort-grain" data-grain="${k}" aria-pressed="${g === k}">${l}</button>`).join('')}</div>` })}`;
  },
  after() {
    const g = S.cohorts.grain;
    const cs = E.cohorts(S.ctx, g).slice(g === 'week' ? -20 : -12);
    const labels = cs.map((x) => x.key);
    draw('gi-co-chart', {
      type: 'bar',
      data: { labels, datasets: [
        { type: 'bar', label: 'Ad spend in the period', data: cs.map((x) => x.spend), backgroundColor: C.sage, yAxisID: 'y', order: 3 },
        { type: 'line', label: 'Trials started', data: cs.map((x) => x.trials), borderColor: C.green, borderDash: [6, 3], borderWidth: 2, pointRadius: 2, yAxisID: 'y2', order: 2 },
        { type: 'line', label: 'Verified new paying (trial or not)', data: cs.map((x) => x.newPaying), borderColor: C.slate, borderWidth: 2, pointRadius: 2, yAxisID: 'y2', order: 1 },
      ] },
      options: {
        scales: { x: { grid: { display: false }, ticks: { color: C.text, maxRotation: 0, autoSkip: true, maxTicksLimit: 10, callback(v) { return g === 'month' ? labels[v].slice(0, 7) : dayLabel(labels[v]); } } }, y: axis('left', true, 'Ad spend'), y2: axis('right', false, 'Members') },
        plugins: { legend: { display: true, position: 'bottom', labels: { color: C.text, boxWidth: 18 } } },
      },
    });
  },
};

/* --------------------------------------------------------- profitability -- */

function beDefaults() {
  const c = S.ctx;
  const all = E.profitability(c, firstDay(), c.today);
  const settled = E.cohorts(c, 'week').filter((x) => x.trials > 0 && x.active === 0).slice(-8);
  const spend = settled.reduce((s, x) => s + x.spend, 0); const trials = settled.reduce((s, x) => s + x.trials, 0);
  const t = E.trialStats(c.members);
  const last30 = E.periodSummary(c, E.addDays(c.today, -29), c.today).activity.spend / 30;
  return {
    dailyBudget: Math.round(last30) || 50,
    costPerTrial: trials && spend ? Math.round((spend / trials) * 100) / 100 : 15,
    convRate: t.rate != null ? Math.round(t.rate * 1000) / 10 : 35,
    price: 19,
    retentionMonths: all.expectedLifetimeMonths ? Math.round(all.expectedLifetimeMonths * 10) / 10 : 6,
    platformPct: c.settings.fees.platformPct + c.settings.fees.processingPct,
    perTransaction: c.settings.fees.perTransaction,
  };
}

const profitPage = {
  html() {
    const c = S.ctx; const r = S.range;
    const p = E.profitability(c, r.from, r.to);
    if (!S.be) S.be = beDefaults();
    const be = S.be;
    const out = E.breakEven({ ...be, convRate: be.convRate / 100 });
    const fc = E.forecast(c);
    const field = (key, label, step, suffix) => `<label class="gi-field"><span>${h(label)}</span><span class="gi-input"><input type="number" inputmode="decimal" step="${step}" min="0" value="${h(be[key])}" data-change="be" data-key="${key}">${suffix ? `<em>${h(suffix)}</em>` : ''}</span></label>`;
    const scen = (label, s, cls) => `<div class="gi-scen ${cls}"><h4>${label}</h4>${s ? `<p class="gi-scen-n">${dec(s.members, 1)} <small>new paying</small></p><dl><div><dt>Conversion assumed</dt><dd>${pct(s.rate, 1)}</dd></div><div><dt>New gross MRR</dt><dd>${money(s.grossMrr, 2)}</dd></div><div><dt>First charges</dt><dd>${money(s.firstCharge, 2)}</dd></div></dl>` : '<p class="sub">No verified history to forecast from.</p>'}</div>`;
    return `
    <div class="gi-pagehead"><h3>Profitability</h3><p class="sub">What advertising cost against what its members have verifiably paid. Actual results first; forecasts are fenced off below and labelled.</p></div>
    ${rangeBar()}
    ${panel('Actual results', `
      <div class="notice notice-info"><span><strong>Aggregate efficiency, not ad-level attribution.</strong> ${p.attributed ? 'Some members carry attribution; figures below are still account-wide.' : 'No member is linked to a specific ad, so nothing here is a verified per-ad CAC or ROAS.'} Each figure divides all ad spend in the period by everyone who joined in it — including people who came from direct traffic and the Skool network.</span></div>
      ${tiles([
        { label: 'Advertising spend', value: money(p.spend) },
        { label: 'Free trials started', value: int(p.trials), note: 'By people who joined in the period' },
        { label: 'Cost per trial', value: money(p.blendedCostPerTrial, 2), basis: 'blended' },
        { label: 'Verified new paying customers', value: int(p.newPaying), basis: 'verified', basisKind: 'is-ok', note: `${int(p.converted)} from a free trial · ${int(p.directPaid)} with no trial. ` + (p.fullyMatured ? (p.unresolved ? `${int(p.unresolved)} more have no verified outcome` : '') : `${int(p.activeTrials)} still on trial — not final`) },
        { label: 'CAC', value: money(p.blendedCac, 2), basis: 'blended', note: p.fullyMatured ? '' : 'Overstated until this period\'s trials finish.' },
        { label: 'Collected from this cohort', value: money(p.cohortRevenue), note: 'Recorded LTV of the period\'s joiners, to date' },
        { label: 'Observed ROAS', value: p.blendedRoas == null ? '—' : dec(p.blendedRoas, 2) + '×', basis: 'blended', note: 'Cohort revenue to date ÷ ad spend. Keeps rising while members keep paying.' },
        { label: 'Avg monthly margin per customer', value: money(p.avgMonthlyMargin, 2), note: 'Net of fees, across current paying members' },
        { label: 'CAC payback', value: p.cacPaybackMonths == null ? '—' : dec(p.cacPaybackMonths) + ' months', basis: 'estimate' },
        { label: 'Estimated LTV', value: money(p.estimatedLtv, 2), basis: 'estimate', note: p.expectedLifetimeMonths ? `Margin × ${dec(p.expectedLifetimeMonths)} months expected lifetime (1 ÷ ${pct(p.monthlyChurn, 1)} monthly churn over ${p.churnBasisMonths} month${p.churnBasisMonths === 1 ? '' : 's'})` : 'Needs verified churn history.' },
      ])}`)}
    ${panel('Break-even tool', `
      <div class="gi-forecast-flag">Forecast — nothing in this panel is a result</div>
      <div class="gi-be">
        <div class="gi-be-in">
          ${field('dailyBudget', 'Daily advertising budget', '1', '$ / day')}
          ${field('costPerTrial', 'Cost per trial', '0.5', '$')}
          ${field('convRate', 'Trial conversion rate', '0.5', '%')}
          ${field('price', 'Membership price', '1', '$ / month')}
          ${field('retentionMonths', 'Retention period', '0.5', 'months')}
          ${field('platformPct', 'Platform + processing fees', '0.1', '%')}
          ${field('perTransaction', 'Fee per charge', '0.05', '$')}
          <button type="button" class="gi-link" data-act="be-reset">Reset to current actuals</button>
        </div>
        <div class="gi-be-out">
          <p class="gi-verdict ${out.profitable ? 'is-good' : 'is-bad'}">${out.cac == null ? 'Enter a conversion rate above zero.' : out.profitable ? `Profitable on these assumptions: each customer returns ${money(out.profitPerCustomer, 2)} after acquisition cost.` : `Unprofitable on these assumptions: each customer costs ${money(Math.abs(out.profitPerCustomer), 2)} more to acquire than they return.`}</p>
          ${tiles([
            { label: 'Monthly ad spend', value: money(out.monthlySpend) },
            { label: 'Trials per month', value: dec(out.trialsPerMonth, 0) },
            { label: 'New paying per month', value: dec(out.newPayingPerMonth, 1) },
            { label: 'CAC', value: money(out.cac, 2) },
            { label: 'Lifetime margin per customer', value: money(out.ltv, 2), note: `${money(out.marginPerMonth, 2)} a month after fees` },
            { label: 'CAC payback', value: out.paybackMonths == null ? '—' : dec(out.paybackMonths) + ' months' },
            { label: 'Profit per monthly cohort', value: money(out.monthlyCohortProfit), note: 'Over the whole retention period' },
            { label: 'MRR at steady state', value: money(out.steadyStateMrr) },
            { label: 'Break-even conversion rate', value: pct(out.breakEvenConvRate, 1), note: 'At this cost per trial' },
            { label: 'Break-even cost per trial', value: money(out.breakEvenCostPerTrial, 2), note: 'At this conversion rate' },
          ])}
        </div>
      </div>`, { sub: 'Starts from your current actuals. Change any input to see what it does to the outcome.' })}
    ${panel('Revenue forecast from active trials', `
      <div class="gi-forecast-flag">Forecast — not money collected</div>
      <p>${int(fc.activeTrials)} trial${fc.activeTrials === 1 ? ' is' : 's are'} running now${fc.byPlan.length ? ': ' + fc.byPlan.map((x) => `${int(x.trials)} on ${h(x.plan)}`).join(', ') : ''}. The historical verified conversion rate is <strong>${pct(fc.historicalRate, 1)}</strong>, from ${int(fc.sample)} trials with a known outcome.</p>
      <div class="gi-scens">${scen('Conservative', fc.conservative, 'is-lo')}${scen('Expected', fc.expected, 'is-mid')}${scen('Optimistic', fc.optimistic, 'is-hi')}</div>
      ${fc.notes.length ? `<ul class="gi-fine">${fc.notes.map((n) => `<li>${h(n)}</li>`).join('')}</ul>` : ''}
      <p class="gi-fine">The range is an 80% interval on the historical rate, so it narrows as more trials reach a verified outcome. ${fc.monthlyChurn != null ? `New MRR then erodes at about ${pct(fc.monthlyChurn, 1)} a month on current churn.` : 'There is not enough churn history yet to say how long that MRR lasts.'} Each plan is forecast at its own price.</p>`)}`;
  },
};

/* ---------------------------------------------------------------- wiring -- */

const kit = { S, E, h, money, int, dec, pct, dayLabel, dayFull, tag, precisionTag, panel, table, tiles, insightList, rangeBar, api, saveDb, saveImport, rebuild, render, setDemo, syncMeta };
const admin = adminPages(kit);

const ALL_PAGES = {
  overview: overviewPage, timeline: timelinePage, ads: adsPage, trials: trialsPage, revenue: revenuePage,
  retention: retentionPage, cohorts: cohortsPage, profit: profitPage,
  members: admin.members, ai: admin.ai, report: admin.report, recon: admin.recon, settings: admin.settings,
};

function go(page) {
  if (!ALL_PAGES[page]) return;
  S.page = page;
  render();
  const main = S.root.querySelector('#gi-main');
  if (main) { const top = S.root.getBoundingClientRect().top + window.scrollY - 70; if (window.scrollY > top) window.scrollTo({ top }); }
  try { localStorage.setItem('gi-page', page); } catch { /* private mode */ }
}

const ACTIONS = {
  page: (el) => go(el.dataset.page),
  range: (el) => { S.range.preset = el.dataset.preset; resolveRange(); render(); },
  'dismiss-error': () => { S.error = ''; render(); },
  'dismiss-notice': () => { S.notice = ''; render(); },
  'demo-on': () => setDemo(true),
  'demo-off': () => setDemo(false),
  'tl-metric': (el) => { const k = el.dataset.key; if (S.timeline.on.has(k)) S.timeline.on.delete(k); else S.timeline.on.add(k); render(); },
  'tl-level': (el) => { S.timeline.level = el.dataset.level; S.timeline.ids = []; render(); },
  'tl-clear': () => { S.timeline.ids = []; render(); },
  'ads-level': (el) => { S.ads.level = el.dataset.level; S.ads.sel = null; render(); },
  'ad-select': (el) => { S.ads.sel = el.dataset.id; render(); const d = S.root.querySelector('#gi-ad-detail'); if (d) d.scrollIntoView({ block: 'start', behavior: 'smooth' }); },
  'ad-open': (el) => { S.ads.level = 'ad'; S.ads.sel = el.dataset.id; go('ads'); const d = S.root.querySelector('#gi-ad-detail'); if (d) d.scrollIntoView({ block: 'start' }); },
  'ad-close': () => { S.ads.sel = null; render(); },
  'meta-sync': () => syncMeta(false),
  'meta-sync-full': () => syncMeta(true),
  'trials-by': (el) => { S.trials.by = el.dataset.by; render(); },
  'cohort-grain': (el) => { S.cohorts.grain = el.dataset.grain; render(); },
  'be-reset': () => { S.be = null; render(); },
  'member-open': (el) => { S.members.sel = el.dataset.id; go('members'); const d = S.root.querySelector('#gi-member-detail'); if (d) d.scrollIntoView({ block: 'start' }); },
  ...admin.actions,
};

const CHANGES = {
  page: (el) => go(el.value),
  'range-custom': (el) => {
    const form = el.closest('form');
    const from = form.elements.from.value; const to = form.elements.to.value;
    if (E.isDay(from) && E.isDay(to) && from <= to) { S.range = { preset: 'custom', from, to }; render(); }
  },
  'tl-ad': (el) => {
    const ids = new Set(S.timeline.ids);
    if (el.checked) ids.add(el.value); else ids.delete(el.value);
    S.timeline.ids = [...ids];
    // Repaint, but leave the picker open: closing it on every tick makes
    // choosing three ads a nine-click job.
    render();
    const drop = S.root.querySelector('.gi-drop'); if (drop) drop.open = true;
  },
  be: (el) => { const v = Number(el.value); if (Number.isFinite(v) && v >= 0) { S.be[el.dataset.key] = v; render(); const again = S.root.querySelector(`[data-change="be"][data-key="${el.dataset.key}"]`); if (again) again.focus(); } },
  ...admin.changes,
};

export function mount(root, opts = {}) {
  S.root = root;
  S.Chart = opts.Chart || window.Chart || null;
  if (!document.querySelector('link[data-gi-font]')) {
    // The brand's typefaces. Requested here so only this tab pays for them.
    const font = document.createElement('link');
    font.rel = 'stylesheet'; font.dataset.giFont = '1';
    font.href = 'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400..800;1,9..144,400..800&family=Manrope:wght@400..800&display=swap';
    document.head.appendChild(font);
  }
  if (!document.querySelector('link[data-gi]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = '/assets/growth/growth.css'; link.dataset.gi = '1';
    document.head.appendChild(link);
  }
  try { const p = localStorage.getItem('gi-page'); if (p && ALL_PAGES[p]) S.page = p; } catch { /* private mode */ }
  root.innerHTML = shell();

  root.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el || !root.contains(el)) return;
    const fn = ACTIONS[el.dataset.act];
    if (fn) { ev.preventDefault(); fn(el, ev); }
  });
  root.addEventListener('change', (ev) => {
    const el = ev.target.closest('[data-change]');
    if (!el) return;
    const fn = CHANGES[el.dataset.change];
    if (fn) fn(el, ev);
  });
  // Dropping a file on a drop zone. Without preventDefault on dragover the
  // browser never fires drop, and on drop it would navigate to the file.
  root.addEventListener('dragover', (ev) => {
    const zone = ev.target.closest('[data-dropzone]');
    if (!zone) return;
    ev.preventDefault(); zone.classList.add('is-over');
  });
  root.addEventListener('dragleave', (ev) => { const zone = ev.target.closest('[data-dropzone]'); if (zone) zone.classList.remove('is-over'); });
  root.addEventListener('drop', (ev) => {
    const zone = ev.target.closest('[data-dropzone]');
    if (!zone) return;
    ev.preventDefault(); zone.classList.remove('is-over');
    const file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (file) admin.dropFile(file);
  });
  root.addEventListener('submit', (ev) => {
    const form = ev.target.closest('form');
    if (!form) return;
    ev.preventDefault();
    const fn = admin.submits[form.dataset.form];
    if (fn) fn(form, ev);
  });

  rebuild();
  render();
  return loadAll();
}

/** Called when the tab is shown again: charts measure a hidden canvas as zero wide. */
export function shown() {
  if (S.root && S.ctx) render();
}
