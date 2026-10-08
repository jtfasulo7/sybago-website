// Peps by Dave Growth Intelligence — the engine.
//
// Pure functions, no DOM, no network, no clock except the `today` a caller
// passes in. The browser imports this file as a module, the weekly-report cron
// imports the same file on the server, and test/growth.test.mjs runs it
// directly — one copy, and the tests exercise the bytes that ship.
//
// THE MODEL IS A REPLAY, NOT A TABLE THAT GETS OVERWRITTEN.
// The database is an ordered list of imports (each Skool CSV, each pasted
// block) plus a list of manual corrections. Member history is rebuilt from
// those every time by buildState(). That is what makes three requirements
// structurally true rather than promises:
//   - a new CSV can never overwrite history: it is one more entry in the list;
//   - reversing a bad import is exact: mark it reverted and replay without it;
//   - "when did we learn this" is never confused with "when did it happen":
//     every event carries the import that produced it and a precision.
//
// THREE PRECISIONS, AND THEY ARE NEVER BLURRED.
//   exact      a date somebody or something actually stated
//   estimated  a date derived from a rule (trial end = start + trial length)
//   window     only bounded by two observations; `day` is then the day it was
//              OBSERVED and `window` carries the bounds. Nothing invents a
//              date inside the window.

/* ------------------------------------------------------------------ dates */

const DAY_MS = 86400000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isDay = (d) => typeof d === 'string' && DAY_RE.test(d);
export const dayToUtc = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
export const utcToDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d, n) => utcToDay(dayToUtc(d) + n * DAY_MS);
export const diffDays = (a, b) => Math.round((dayToUtc(b) - dayToUtc(a)) / DAY_MS);
export const minDay = (a, b) => (!a ? b : !b ? a : a < b ? a : b);
export const maxDay = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

/** Calendar-month arithmetic that clamps (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(d, n) {
  const y = +d.slice(0, 4);
  const m = +d.slice(5, 7) - 1 + n;
  const day = +d.slice(8, 10);
  const first = new Date(Date.UTC(y, m, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return utcToDay(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, last)));
}

/** Monday of the week containing d. */
export function weekStart(d) {
  const dow = new Date(dayToUtc(d)).getUTCDay(); // 0 = Sunday
  return addDays(d, -((dow + 6) % 7));
}
export const monthStart = (d) => d.slice(0, 7) + '-01';

export function daysBetween(from, to) {
  const out = [];
  if (!isDay(from) || !isDay(to) || from > to) return out;
  for (let t = dayToUtc(from), end = dayToUtc(to); t <= end; t += DAY_MS) out.push(utcToDay(t));
  return out;
}

const fmtCache = new Map();
/** The calendar day an instant falls on in a named timezone. */
export function dayIn(iso, tz) {
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  let f = fmtCache.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch {
      f = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
    }
    fmtCache.set(tz, f);
  }
  const p = {};
  for (const part of f.formatToParts(date)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad2 = (n) => String(n).padStart(2, '0');
const validYmd = (y, m, d) => {
  if (!(y > 1990 && y < 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const s = `${y}-${pad2(m)}-${pad2(d)}`;
  return utcToDay(dayToUtc(s)) === s ? s : null;
};

/**
 * Read a timestamp out of a CSV cell.
 *
 * Returns { day, iso } — `iso` only when the cell carried a time of day, in
 * which case `day` is that instant's calendar day IN THE BUSINESS TIMEZONE. A
 * member who joined at 02:10 UTC on Oct 2 joined on Oct 1 in New York, and the
 * ad spend they are compared against is reported in a local day too.
 *
 * A timestamp with no zone is read as UTC unless opts.assume === 'local'.
 */
export function parseWhen(value, opts = {}) {
  const tz = opts.tz || 'UTC';
  const s = String(value == null ? '' : value).trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const day = validYmd(+m[1], +m[2], +m[3]);
    return day ? { day, iso: null } : null;
  }

  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|UTC|[+-]\d{2}:?\d{2})?$/i);
  if (m) {
    const literal = validYmd(+m[1], +m[2], +m[3]);
    if (!literal) return null;
    const zone = m[7] ? (/^(z|utc)$/i.test(m[7]) ? 'Z' : m[7].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')) : null;
    if (!zone && opts.assume === 'local') return { day: literal, iso: null };
    const date = new Date(`${literal}T${pad2(+m[4])}:${m[5]}:${m[6] || '00'}${zone || 'Z'}`);
    if (Number.isNaN(date.getTime())) return null;
    return { day: dayIn(date, tz), iso: date.toISOString() };
  }

  // US style, which is what Skool's own UI and most spreadsheet re-saves use.
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const day = validYmd(y, +m[1], +m[2]);
    return day ? { day, iso: null } : null;
  }

  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
  if (m && MONTHS[m[1].slice(0, 4).toLowerCase()] || (m && MONTHS[m[1].slice(0, 3).toLowerCase()])) {
    const mon = MONTHS[m[1].slice(0, 4).toLowerCase()] || MONTHS[m[1].slice(0, 3).toLowerCase()];
    const day = validYmd(+m[3], mon, +m[2]);
    return day ? { day, iso: null } : null;
  }

  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 4).toLowerCase()] || MONTHS[m[2].slice(0, 3).toLowerCase()];
    const day = mon ? validYmd(+m[3], mon, +m[1]) : null;
    return day ? { day, iso: null } : null;
  }
  return null;
}

/* ------------------------------------------------------------- settings -- */

export const SOURCES = ['facebook', 'instagram', 'skool', 'direct', 'referral', 'unknown'];
export const SOURCE_LABELS = {
  facebook: 'Facebook', instagram: 'Instagram', skool: 'Skool network',
  direct: 'Direct traffic', referral: 'Referral', unknown: 'Unknown',
};

export const DEFAULT_SETTINGS = {
  timezone: 'America/New_York',
  csvTimestamps: 'utc',          // how to read a CSV timestamp that names no zone
  trialDays: 7,
  // The first full day the free trial was offered. Anyone on a paid plan who
  // joined before it PAID TO JOIN — they are paying members, never trial
  // members, and are in no trial count, conversion rate or trial forecast.
  trialAppliesFrom: '2026-09-27',
  plans: [
    { id: 'm19', label: '$19 / month', price: 19, interval: 'month' },
    { id: 'm9', label: '$9 / month (legacy)', price: 9, interval: 'month' },
    { id: 'y147', label: '$147 / year', price: 147, interval: 'year' },
    { id: 'free', label: 'Free', price: 0, interval: 'none' },
  ],
  fees: {
    platformPct: 2.9,            // Skool's transaction fee on the Pro plan; Hobby is 10
    processingPct: 0,            // only if card processing is charged separately
    perTransaction: 0.3,
    networkSharePct: 0,          // extra share on members acquired through the Skool network
  },
  expenses: [],                  // [{ id, label, amount, cadence: 'monthly'|'annual'|'once', day }]
  graceDays: 5,                  // slack before an unpaid period is flagged
  reportEmail: '',
};

export function withDefaults(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    fees: { ...DEFAULT_SETTINGS.fees, ...(s.fees || {}) },
    // An empty value means "not set", which is the default date — never "the
    // trial always existed". That reading is what made every pre-trial paying
    // member count as a trial conversion.
    trialAppliesFrom: isDay(s.trialAppliesFrom) ? s.trialAppliesFrom : DEFAULT_SETTINGS.trialAppliesFrom,
    plans: Array.isArray(s.plans) && s.plans.length ? s.plans : DEFAULT_SETTINGS.plans,
    expenses: Array.isArray(s.expenses) ? s.expenses : [],
  };
}

export function emptyDb() {
  return { version: 0, updatedAt: null, settings: withDefaults(null), imports: [], manual: [], audit: [] };
}

/* ------------------------------------------------------------------ CSV -- */

/** RFC 4180: quoted fields, doubled quotes, newlines inside quotes, CRLF, BOM. */
export function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const clean = rows.filter((r) => r.some((v) => String(v).trim() !== ''));
  const headers = (clean.shift() || []).map((h) => String(h).trim());
  return { headers, rows: clean };
}

export const CSV_FIELDS = [
  ['firstName', 'First name'], ['lastName', 'Last name'], ['name', 'Full name'], ['email', 'Email'],
  ['handle', 'Skool username'], ['profileId', 'Profile ID'], ['joinedAt', 'Join date'],
  ['price', 'Membership price'], ['interval', 'Billing interval'], ['ltv', 'Recorded lifetime value'],
  ['source', 'Acquisition source'], ['invitedBy', 'Invited by'], ['tier', 'Tier / plan name'],
];

const SYNONYMS = {
  firstName: ['firstname', 'first', 'givenname'],
  lastName: ['lastname', 'last', 'surname', 'familyname'],
  name: ['name', 'fullname', 'member', 'membername', 'displayname'],
  email: ['email', 'emailaddress', 'mail'],
  handle: ['username', 'handle', 'skoolusername', 'slug', 'profile', 'profileurl'],
  profileId: ['id', 'userid', 'memberid', 'profileid', 'skoolid'],
  joinedAt: ['joineddate', 'joined', 'joindate', 'datejoined', 'joinedat', 'membersince', 'created', 'createdat', 'approvedat'],
  price: ['price', 'membershipprice', 'subscriptionprice', 'planprice', 'amount'],
  interval: ['recurringinterval', 'interval', 'billinginterval', 'billingperiod', 'billing', 'recurring'],
  ltv: ['ltv', 'lifetimevalue', 'recordedltv', 'totalpaid', 'totalspent', 'recordedlifetimevalue'],
  source: ['source', 'acquisitionsource', 'attribution', 'utmsource', 'referrer', 'trafficsource'],
  invitedBy: ['invitedby', 'invited', 'referredby', 'affiliate', 'invitedbyname'],
  tier: ['tier', 'plan', 'membership', 'membershiptier', 'planname'],
};

const normHeader = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Guess which column is which. Returns { field: columnIndex }. */
export function detectColumns(headers) {
  const norm = headers.map(normHeader);
  const mapping = {};
  const taken = new Set();
  for (const pass of ['exact', 'contains']) {
    for (const [field, names] of Object.entries(SYNONYMS)) {
      if (mapping[field] !== undefined) continue;
      const i = norm.findIndex((h, idx) => !taken.has(idx) && h &&
        (pass === 'exact' ? names.includes(h) : names.some((n) => n.length > 3 && h.includes(n))));
      if (i >= 0) { mapping[field] = i; taken.add(i); }
    }
  }
  return mapping;
}

export function parseMoney(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  if (/^free$/i.test(s)) return 0;
  const m = s.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export function normaliseInterval(text, price, settings) {
  const s = String(text || '').toLowerCase();
  if (/year|annual|yr/.test(s)) return 'year';
  if (/month|\bmo\b/.test(s)) return 'month';
  if (/one|once|life/.test(s)) return 'once';
  if (price === 0) return 'none';
  if (price == null) return null;
  const plan = withDefaults(settings).plans.find((p) => Math.abs(p.price - price) < 0.005);
  return plan ? plan.interval : 'month';
}

export function normaliseSource(text) {
  const s = String(text || '').toLowerCase();
  if (!s.trim()) return null;
  if (/insta|\big\b/.test(s)) return 'instagram';
  if (/facebook|\bfb\b|meta/.test(s)) return 'facebook';
  if (/skool|discover/.test(s)) return 'skool';
  if (/refer|affiliat|invit/.test(s)) return 'referral';
  if (/direct|typed|none/.test(s)) return 'direct';
  return 'unknown';
}

export const normName = (s) =>
  String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const normHandle = (s) => String(s || '').trim().replace(/^.*skool\.com\/@?/i, '').replace(/^@/, '').replace(/[?#/].*$/, '').toLowerCase();
const normEmail = (s) => String(s || '').trim().toLowerCase();

/** Turn parsed CSV rows into the stored shape. Unparseable cells become issues, never guesses. */
export function normaliseCsvRows(parsed, mapping, settings) {
  const st = withDefaults(settings);
  const get = (r, f) => (mapping[f] === undefined || mapping[f] === null || mapping[f] === '' ? '' : String(r[mapping[f]] ?? '').trim());
  const rows = [];
  const issues = [];
  parsed.rows.forEach((r, i) => {
    const first = get(r, 'firstName');
    const last = get(r, 'lastName');
    const name = (get(r, 'name') || `${first} ${last}`).replace(/\s+/g, ' ').trim();
    const email = normEmail(get(r, 'email'));
    const handle = normHandle(get(r, 'handle'));
    if (!name && !email && !handle) { issues.push({ row: i + 2, message: 'No name, email or username — row skipped.' }); return; }

    const joinedRaw = get(r, 'joinedAt');
    const when = joinedRaw ? parseWhen(joinedRaw, { tz: st.timezone, assume: st.csvTimestamps }) : null;
    if (joinedRaw && !when) issues.push({ row: i + 2, message: `Could not read the join date "${joinedRaw}".` });

    // A mapped price column with an empty cell is a member who pays nothing.
    // With no price column at all the plan is simply unknown.
    const priceCell = get(r, 'price');
    const priceMapped = !(mapping.price === undefined || mapping.price === null || mapping.price === '');
    const price = priceCell === '' && priceMapped ? 0 : parseMoney(priceCell);
    const invitedBy = get(r, 'invitedBy');
    const sourceText = get(r, 'source');
    rows.push({
      k: String(i),
      name,
      email: email || null,
      handle: handle || null,
      profileId: get(r, 'profileId') || null,
      joinDay: when ? when.day : null,
      joinAt: when ? when.iso : null,
      price,
      interval: normaliseInterval(get(r, 'interval'), price, st),
      ltv: parseMoney(get(r, 'ltv')),
      source: normaliseSource(sourceText) || (invitedBy ? 'referral' : null),
      sourceRaw: sourceText || null,
      invitedBy: invitedBy || null,
      tier: get(r, 'tier') || null,
    });
  });
  return { rows, issues };
}

/** FNV-1a. Not security — only to recognise the same file uploaded twice. */
export function contentHash(text) {
  let h = 0x811c9dc5;
  const s = String(text || '').replace(/\r\n/g, '\n').trim();
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0') + '-' + s.length.toString(36);
}

/* ---------------------------------------------------------------- paste -- */

export const STATUSES = [
  ['active_trial', 'Active trial'],
  ['trial_canceled', 'Trial canceled'],
  ['trial_declined', 'Trial declined'],
  ['trial_ended', 'Trial ended'],
  ['paid_verified', 'Paid subscription verified'],
  ['canceling', 'Canceling — still a member'],
  ['churned', 'Churned member'],
  ['returning', 'Returning member'],
  ['unknown', 'Unknown or unverified'],
];
export const STATUS_LABEL = Object.fromEntries(STATUSES);

const DATE_TOKEN =
  '(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?|[A-Za-z]{3,9}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}\\s+[A-Za-z]{3,9}\\.?(?:,?\\s+\\d{4})?' +
  '|today|yesterday|tomorrow|in\\s+\\d+\\s*(?:d|day|days|h|hour|hours|w|week|weeks)|\\d+\\s*(?:d|day|days|h|hr|hrs|hour|hours|w|wk|week|weeks|mo|month|months)\\s*(?:ago|left)?)';

/**
 * Read one date phrase relative to when the text was pasted.
 * Returns { day, approx } — approx is true whenever a year was inferred or the
 * phrase was relative ("in 3 days", "2d ago"), so the review screen can say so.
 */
export function readDatePhrase(phrase, pastedDay) {
  const s = String(phrase || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'today') return { day: pastedDay, approx: true };
  if (s === 'yesterday') return { day: addDays(pastedDay, -1), approx: true };
  if (s === 'tomorrow') return { day: addDays(pastedDay, 1), approx: true };

  let m = s.match(/^in\s+(\d+)\s*(d|day|days|h|hour|hours|w|week|weeks)$/);
  if (m) {
    const n = +m[1];
    const days = /^h/.test(m[2]) ? Math.round(n / 24) : /^w/.test(m[2]) ? n * 7 : n;
    return { day: addDays(pastedDay, days), approx: true };
  }
  m = s.match(/^(\d+)\s*(d|day|days|h|hr|hrs|hour|hours|w|wk|week|weeks|mo|month|months)\s*(ago|left)?$/);
  if (m) {
    const n = +m[1];
    const unit = m[2];
    const days = /^h/.test(unit) ? Math.round(n / 24) : /^w/.test(unit) ? n * 7 : /^mo/.test(unit) ? n * 30 : n;
    return { day: addDays(pastedDay, m[3] === 'left' ? days : -days), approx: true };
  }

  const full = parseWhen(phrase);
  if (full) return { day: full.day, approx: false };

  // No year given: take the most recent occurrence that is not far in the future.
  const tryYearless = (mon, d) => {
    const y = +pastedDay.slice(0, 4);
    for (const yy of [y, y - 1, y + 1]) {
      const day = validYmd(yy, mon, d);
      if (day && diffDays(pastedDay, day) <= 45) return { day, approx: true };
    }
    return null;
  };
  m = s.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?$/);
  if (m) {
    const mon = MONTHS[m[1].slice(0, 4)] || MONTHS[m[1].slice(0, 3)];
    return mon ? tryYearless(mon, +m[2]) : null;
  }
  m = s.match(/^(\d{1,2})\s+([a-z]{3,9})\.?$/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 4)] || MONTHS[m[2].slice(0, 3)];
    return mon ? tryYearless(mon, +m[1]) : null;
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) return tryYearless(+m[1], +m[2]);
  return null;
}

const LABELLED = [
  ['joinDay', '(?:joined|member since|approved)(?:\\s+on)?'],
  ['trialStart', '(?:trial\\s+(?:started|began|start)|started\\s+trial)(?:\\s+on)?'],
  ['trialEnd', '(?:(?:free\\s+)?trial\\s+(?:ends|ending|expires|expiring|ended|expired|end)|trial\\s+until|expires|ends)(?:\\s+on)?'],
  ['canceledAt', '(?:cancel+ed|cancels|cancel+ation|declined)(?:\\s+on)?'],
  ['endsAt', '(?:access\\s+(?:ends|until)|membership\\s+ends|churns|will\\s+churn|leaving)(?:\\s+on)?'],
  ['churnedAt', '(?:churned|removed|left|expired\\s+membership)(?:\\s+on)?'],
  ['paidAt', '(?:paid|first\\s+payment|converted|subscribed)(?:\\s+on)?'],
  ['returnedAt', '(?:returned|rejoined|re-joined|reactivated)(?:\\s+on)?'],
];

function detectStatus(text) {
  const s = text.toLowerCase();
  if (/trial/.test(s) && /cancel/.test(s)) return 'trial_canceled';
  if (/declin|payment failed|card failed/.test(s)) return 'trial_declined';
  if (/churn/.test(s)) return 'churned';
  if (/re-?joined|returned|returning|reactivat/.test(s)) return 'returning';
  if (/trial (?:has )?(?:ended|expired|over)/.test(s)) return 'trial_ended';
  if (/trial/.test(s)) return 'active_trial';
  // "Canceled" with no mention of a trial is somebody who has asked to stop
  // and is STILL A MEMBER until their period runs out. Calling that churn is
  // the confusion the separate canceling and churned uploads exist to end.
  if (/cancel/.test(s)) return 'canceling';
  if (/\bpaid\b|paying|active subscri|subscribed/.test(s)) return 'paid_verified';
  return null;
}

const looksLikeName = (line) => {
  const s = line.trim();
  if (!s || s.length > 60 || /[@$:/]|\d{2,}/.test(s)) return false;
  if (/^(joined|active|online|trial|churned|cancel|free|paid|member|admin|expires|ends|level|bio)\b/i.test(s)) return false;
  return /^[\p{L}][\p{L}\p{M}'’.\- ]+$/u.test(s) && s.split(/\s+/).length <= 5;
};

/**
 * Pull member records out of text copied from Skool.
 *
 * Skool's member lists have no export for trial or churn state, so this reads
 * whatever a select-all-and-copy produces: one card per member (name, @handle,
 * a few status lines) or one tab-separated row per member. It is deliberately
 * tolerant, and deliberately not trusted — every row goes through a review
 * screen before it is saved, with the original block kept beside it.
 */
export function parsePaste(text, opts = {}) {
  const pastedDay = opts.pastedDay || utcToDay(Date.now());
  const src = String(text || '').replace(/\r\n?/g, '\n').replace(/ /g, ' ');
  const lines = src.split('\n');
  const nonEmpty = lines.filter((l) => l.trim());
  if (!nonEmpty.length) return [];

  // Decide how the text is laid out.
  const tabbed = nonEmpty.filter((l) => /\t/.test(l)).length;
  const blocks = [];
  if (tabbed >= Math.max(2, nonEmpty.length * 0.6) || (nonEmpty.length === 1 && tabbed === 1)) {
    for (const l of nonEmpty) blocks.push([l]);
  } else {
    const handleAt = [];
    lines.forEach((l, i) => { if (/^\s*@[a-z0-9][\w.-]*\s*$/i.test(l) || /skool\.com\/@[\w.-]+/i.test(l)) handleAt.push(i); });
    if (handleAt.length) {
      // A card starts at the name line directly above each handle.
      const starts = handleAt.map((i) => {
        let j = i - 1;
        while (j >= 0 && !lines[j].trim()) j--;
        return j >= 0 && looksLikeName(lines[j]) ? j : i;
      });
      starts.forEach((s, n) => {
        const end = n + 1 < starts.length ? starts[n + 1] : lines.length;
        blocks.push(lines.slice(s, end).filter((l) => l.trim()));
      });
    } else if (/\n\s*\n/.test(src.trim())) {
      for (const chunk of src.trim().split(/\n\s*\n+/)) blocks.push(chunk.split('\n').filter((l) => l.trim()));
    } else {
      // No structure to lean on: a name-looking line opens a record.
      let cur = null;
      for (const l of nonEmpty) {
        if (looksLikeName(l) || !cur) { cur = [l]; blocks.push(cur); } else cur.push(l);
      }
    }
  }

  const rows = [];
  blocks.forEach((blockLines, idx) => {
    if (!blockLines.length) return;
    const raw = blockLines.join('\n');
    const flat = blockLines.join(' • ').replace(/\t/g, ' • ');
    const row = {
      k: String(idx), name: '', handle: null, email: null, status: null,
      joinDay: null, trialStart: null, trialEnd: null, canceledAt: null, endsAt: null, churnedAt: null, paidAt: null, returnedAt: null,
      price: null, interval: null, source: null, approx: {}, issues: [], raw,
    };

    const h = flat.match(/skool\.com\/@([\w.-]+)/i) || flat.match(/(?:^|[\s•(])@([a-z0-9][\w.-]*)/i);
    if (h) row.handle = normHandle(h[1]);
    const e = flat.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    if (e && !/skool\.com/i.test(e[0])) row.email = normEmail(e[0]);

    const firstCell = blockLines[0].split('\t')[0].replace(/@[\w.-]+/g, '').trim();
    row.name = looksLikeName(firstCell) ? firstCell.replace(/\s+/g, ' ') : '';
    if (!row.name) {
      const cand = blockLines.join('\t').split(/\t|•/).map((c) => c.trim()).find(looksLikeName);
      row.name = cand || '';
    }

    const p = flat.match(/\$\s?(\d+(?:\.\d{1,2})?)\s*(?:\/|per\s+|a\s+)?\s*(mo(?:nth)?|yr|year|annual(?:ly)?)?/i);
    if (p) {
      row.price = Number(p[1]);
      row.interval = p[2] ? (/^(yr|year|annual)/i.test(p[2]) ? 'year' : 'month') : null;
    } else if (/\bfree\b(?!\s+trial)/i.test(flat)) { row.price = 0; row.interval = 'none'; }

    for (const [field, label] of LABELLED) {
      const m = flat.match(new RegExp(`${label}\\s*:?\\s*(${DATE_TOKEN})`, 'i'));
      if (!m) continue;
      const d = readDatePhrase(m[1], pastedDay);
      if (d) { row[field] = d.day; if (d.approx) row.approx[field] = true; }
    }
    // "Trial ends in 5 days" / "5 days left" with no explicit label match above.
    if (!row.trialEnd) {
      const m = flat.match(/(\d+)\s*(?:d|day|days)\s+left/i);
      if (m && /trial/i.test(flat)) { row.trialEnd = addDays(pastedDay, +m[1]); row.approx.trialEnd = true; }
    }

    const detected = detectStatus(flat);
    row.status = detected || opts.defaultStatus || 'unknown';
    // Which list it was pasted into says more than any keyword in it. The
    // canceling and churned lists use much the same words ("canceled"), so
    // inside them the LIST decides — except that wording explicitly about a
    // trial is kept, because a trial that was canceled never became a
    // subscription and must not be filed as one ending.
    if (opts.defaultStatus === 'canceling' || opts.defaultStatus === 'churned') {
      row.status = ['trial_canceled', 'trial_declined'].includes(detected) ? detected : opts.defaultStatus;
      if (opts.defaultStatus === 'churned' && row.status === 'churned' && !row.churnedAt && row.canceledAt) { row.churnedAt = row.canceledAt; if (row.approx.canceledAt) row.approx.churnedAt = true; }
    }
    if (row.status === 'canceling' && !row.endsAt && row.trialEnd) {
      // "Ends Oct 20" on a canceling member is when their access ends, not a trial.
      row.endsAt = row.trialEnd; if (row.approx.trialEnd) row.approx.endsAt = true;
      row.trialEnd = null; delete row.approx.trialEnd;
    }
    row.source = normaliseSource((flat.match(/(?:source|via|from|joined via)\s*:?\s*([a-z ]{3,24})/i) || [])[1]);
    if (/invited by/i.test(flat) && !row.source) row.source = 'referral';

    if (!row.name && !row.handle && !row.email) return;       // nothing to identify anybody by
    if (!row.handle && !row.email) row.issues.push('No username or email — can only be matched by name.');
    if (Object.keys(row.approx).length) row.issues.push('Some dates were relative or had no year; check them.');
    rows.push(row);
  });
  return rows;
}

/* --------------------------------------------------------------- replay -- */

export const EVENT_LABEL = {
  joined: 'Joined',
  trial_started: 'Trial started',
  trial_canceled: 'Trial canceled',
  cancel_scheduled: 'Cancellation requested — still a member',
  trial_declined: 'Trial declined',
  trial_ended: 'Trial ended — outcome unknown',
  paid_verified: 'Paid subscription verified',
  ltv_observed: 'Recorded LTV first observed',
  payment_observed: 'Payment observed (LTV increased)',
  refund_observed: 'LTV decreased (refund or adjustment)',
  price_changed: 'Membership price changed',
  missing_from_export: 'Missing from export — status unverified',
  returned: 'Returned',
  rejoined: 'Rejoined (new join date)',
  churned: 'Churned',
  payment: 'Payment recorded',
  refund: 'Refund recorded',
  failed_payment: 'Failed payment recorded',
  reactivated: 'Subscription reactivated',
  note: 'Note',
};

function newState(settings) {
  return {
    settings,
    members: [],
    byId: new Map(),
    byEmail: new Map(),
    byHandle: new Map(),
    byProfile: new Map(),
    byName: new Map(),
    lastCsv: null,
    csvImports: [],
    matchLog: {},
    warnings: [],
    seq: 0,
  };
}

function indexMember(state, m) {
  if (m.email) state.byEmail.set(m.email, m);
  if (m.handle) state.byHandle.set(m.handle, m);
  if (m.profileId) state.byProfile.set(m.profileId, m);
  const n = normName(m.name);
  if (n) {
    const list = state.byName.get(n) || [];
    if (!list.includes(m)) list.push(m);
    state.byName.set(n, list);
  }
}

function createMember(state, row, imp) {
  const id = row.profileId ? `p:${row.profileId}` : row.handle ? `h:${row.handle}` : row.email ? `e:${row.email}` : `n:${imp.id}:${row.k}`;
  let unique = id;
  for (let n = 2; state.byId.has(unique); n++) unique = `${id}#${n}`;
  const m = {
    id: unique, name: row.name || row.handle || row.email || 'Unnamed member',
    email: row.email || null, handle: row.handle || null, profileId: row.profileId || null,
    joinDay: null, joinAt: null,
    price: null, interval: null, ltv: null, ltvDay: null,
    source: null, sourceRaw: null, invitedBy: null, tier: null, attribution: null,
    present: null,            // true / false once a CSV has spoken; null = never seen in an export
    lastSeenDay: null, missingFrom: null,
    firstImport: imp.id, obs: [], events: [], payments: [], possibleDuplicateOf: null,
    trialStartX: null, trialEndX: null,
  };
  state.members.push(m);
  state.byId.set(m.id, m);
  indexMember(state, m);
  return m;
}

function addEvent(state, m, imp, type, fields) {
  const ev = {
    key: `${imp ? imp.id : 'manual'}|${m.id}|${type}|${m.events.filter((e) => e.type === type && e.importId === (imp ? imp.id : null)).length}`,
    type,
    day: fields.day || null,
    precision: fields.precision || 'exact',
    window: fields.window || null,
    observedAt: imp ? imp.observedAt : fields.observedAt || null,
    importId: imp ? imp.id : null,
    source: imp ? imp.kind : 'manual',
    data: fields.data || null,
    seq: state.seq++,
  };
  m.events.push(ev);
  return ev;
}

/**
 * Who is this row?
 *
 * Strong identifiers first — profile id, username, email — and those are
 * trusted. A name alone is NOT an identifier: two people can share one, so a
 * name match is only taken automatically when exactly one member has that
 * name, nothing contradicts it, AND the join date agrees. Everything else is
 * reported as uncertain and waits for a decision recorded on the import.
 */
export function matchRow(state, row, imp, claimed) {
  const free = (m) => m && !claimed.has(m.id);
  if (row.profileId && free(state.byProfile.get(row.profileId))) return { member: state.byProfile.get(row.profileId), how: 'profile id' };
  if (row.handle && free(state.byHandle.get(row.handle))) return { member: state.byHandle.get(row.handle), how: 'username' };
  if (row.email && free(state.byEmail.get(row.email))) return { member: state.byEmail.get(row.email), how: 'email' };

  const decision = imp.decisions ? imp.decisions[row.k] : undefined;
  if (decision === 'new') return { member: null, how: 'confirmed new' };
  if (decision && free(state.byId.get(decision))) return { member: state.byId.get(decision), how: 'confirmed by administrator' };

  const sameName = (state.byName.get(normName(row.name)) || []).filter(free);
  // A different strong identifier on both sides is proof of two people.
  const compatible = sameName.filter((m) =>
    !(row.email && m.email && row.email !== m.email) &&
    !(row.handle && m.handle && row.handle !== m.handle) &&
    !(row.profileId && m.profileId && row.profileId !== m.profileId));
  if (!compatible.length) return { member: null, how: 'new', candidates: [] };

  const corroborated = compatible.filter((m) => row.joinDay && m.joinDay && row.joinDay === m.joinDay);
  if (compatible.length === 1 && corroborated.length === 1) {
    return { member: compatible[0], how: 'name + join date', candidates: compatible.map((m) => m.id) };
  }
  return { member: null, how: 'uncertain', uncertain: true, candidates: compatible.map((m) => m.id) };
}

function lastLifecycle(m) {
  for (let i = m.events.length - 1; i >= 0; i--) {
    const t = m.events[i].type;
    if (['churned', 'trial_canceled', 'trial_declined', 'returned', 'rejoined', 'paid_verified', 'joined'].includes(t)) return m.events[i];
  }
  return null;
}

function applyCsv(state, imp) {
  const tz = state.settings.timezone;
  const tDay = dayIn(imp.observedAt, tz);
  const prev = state.lastCsv;
  const claimed = new Set();
  const log = [];

  for (const row of imp.rows || []) {
    const res = matchRow(state, row, imp, claimed);
    let m = res.member;
    let created = false;
    if (!m) {
      m = createMember(state, row, imp);
      created = true;
      if (res.uncertain) m.possibleDuplicateOf = res.candidates;
    }
    claimed.add(m.id);
    log.push({ k: row.k, name: row.name, memberId: m.id, how: res.how, created, uncertain: !!res.uncertain, candidates: res.candidates || [] });

    // Identifiers only ever accumulate.
    if (row.email && !m.email) m.email = row.email;
    if (row.handle && !m.handle) m.handle = row.handle;
    if (row.profileId && !m.profileId) m.profileId = row.profileId;
    indexMember(state, m);

    const firstSighting = m.present === null;
    if (created || (firstSighting && !m.joinDay)) {
      if (row.joinDay) {
        m.joinDay = row.joinDay; m.joinAt = row.joinAt;
        addEvent(state, m, imp, 'joined', { day: row.joinDay, precision: 'exact' });
      } else if (created) {
        addEvent(state, m, imp, 'joined', { day: tDay, precision: 'window', window: { from: null, to: tDay } });
      }
    } else if (row.joinDay && m.joinDay && row.joinDay > m.joinDay) {
      // Skool restarts the join date when somebody comes back. That is the one
      // case where a return has an exact date.
      addEvent(state, m, imp, 'rejoined', { day: row.joinDay, precision: 'exact', data: { previousJoin: m.joinDay } });
      m.rejoinDay = row.joinDay;
    } else if (m.present === false) {
      addEvent(state, m, imp, 'returned', {
        day: tDay, precision: 'window', window: { from: m.missingFrom || m.lastSeenDay, to: tDay },
      });
    } else {
      const last = lastLifecycle(m);
      if (last && last.type === 'churned' && last.day && last.day < tDay) {
        addEvent(state, m, imp, 'returned', { day: tDay, precision: 'window', window: { from: last.day, to: tDay } });
      }
    }

    if (row.price != null) {
      if (m.price != null && Math.abs(row.price - m.price) > 0.004) {
        addEvent(state, m, imp, 'price_changed', {
          day: tDay, precision: 'window', window: { from: m.lastSeenDay, to: tDay }, data: { from: m.price, to: row.price },
        });
      }
      m.price = row.price;
      m.interval = row.interval || m.interval;
    }
    if (row.ltv != null) {
      if (m.ltv == null) {
        if (row.ltv > 0) {
          addEvent(state, m, imp, 'ltv_observed', {
            day: tDay, precision: 'window', window: { from: m.joinDay, to: tDay }, data: { amount: row.ltv },
          });
        }
      } else if (row.ltv - m.ltv > 0.004) {
        addEvent(state, m, imp, 'payment_observed', {
          day: tDay, precision: 'window', window: { from: m.ltvDay, to: tDay }, data: { amount: Math.round((row.ltv - m.ltv) * 100) / 100, ltv: row.ltv },
        });
      } else if (m.ltv - row.ltv > 0.004) {
        addEvent(state, m, imp, 'refund_observed', {
          day: tDay, precision: 'window', window: { from: m.ltvDay, to: tDay }, data: { amount: Math.round((m.ltv - row.ltv) * 100) / 100, ltv: row.ltv },
        });
      }
      m.ltv = row.ltv;
      m.ltvDay = tDay;
    }
    if (row.source && (!m.source || m.source === 'unknown')) { m.source = row.source; m.sourceRaw = row.sourceRaw; }
    if (row.invitedBy) m.invitedBy = row.invitedBy;
    if (row.tier) m.tier = row.tier;
    if (row.name && row.name !== m.name && !created) m.name = row.name;

    m.present = true;
    m.missingFrom = null;
    m.lastSeenDay = tDay;
    m.obs.push({ importId: imp.id, day: tDay, present: true, price: row.price, ltv: row.ltv });
  }

  // Anybody a previous export listed and this one does not. NOT a cancellation
  // — only an absence, recorded as exactly that.
  if (prev) {
    for (const m of state.members) {
      if (m.present === true && !claimed.has(m.id)) {
        addEvent(state, m, imp, 'missing_from_export', {
          day: tDay, precision: 'window', window: { from: m.lastSeenDay, to: tDay },
        });
        m.present = false;
        m.missingFrom = m.lastSeenDay;
        m.missingDay = tDay;
        m.obs.push({ importId: imp.id, day: tDay, present: false });
      }
    }
  }

  state.lastCsv = { id: imp.id, at: imp.observedAt, day: tDay, rows: (imp.rows || []).length };
  state.csvImports.push(state.lastCsv);
  state.matchLog[imp.id] = log;
}

function applyPaste(state, imp) {
  const st = state.settings;
  const tDay = dayIn(imp.observedAt, st.timezone);
  const claimed = new Set();
  const log = [];

  for (const row of imp.rows || []) {
    const res = matchRow(state, row, imp, claimed);
    let m = res.member;
    let created = false;
    if (!m) {
      m = createMember(state, row, imp);
      created = true;
      if (res.uncertain) m.possibleDuplicateOf = res.candidates;
    }
    claimed.add(m.id);
    log.push({ k: row.k, name: row.name, memberId: m.id, how: res.how, created, uncertain: !!res.uncertain, candidates: res.candidates || [] });

    if (row.email && !m.email) m.email = row.email;
    if (row.handle && !m.handle) m.handle = row.handle;
    indexMember(state, m);

    const px = (f) => (row.approx && row.approx[f] ? 'estimated' : 'exact');
    if (row.joinDay && !m.joinDay) {
      m.joinDay = row.joinDay;
      addEvent(state, m, imp, 'joined', { day: row.joinDay, precision: px('joinDay') });
    }
    if (row.price != null && m.price == null) { m.price = row.price; m.interval = row.interval || normaliseInterval('', row.price, st); }
    if (row.source && (!m.source || m.source === 'unknown')) m.source = row.source;

    const trialStart = row.trialStart || (row.trialEnd ? addDays(row.trialEnd, -st.trialDays) : m.joinDay);
    const trialEnd = row.trialEnd || (trialStart ? addDays(trialStart, st.trialDays) : null);
    const sinceJoin = { from: m.joinDay || null, to: tDay };

    switch (row.status) {
      case 'active_trial':
        if (row.trialStart) m.trialStartX = row.trialStart;
        if (row.trialEnd) m.trialEndX = row.trialEnd;
        addEvent(state, m, imp, 'trial_started', {
          day: trialStart || tDay,
          precision: row.trialStart ? px('trialStart') : trialStart ? 'estimated' : 'window',
          window: trialStart ? null : sinceJoin,
          data: { trialEnd },
        });
        break;
      case 'trial_canceled':
        if (row.trialEnd) m.trialEndX = row.trialEnd;
        addEvent(state, m, imp, 'trial_canceled', row.canceledAt
          ? { day: row.canceledAt, precision: px('canceledAt') }
          : { day: tDay, precision: 'window', window: { from: trialStart || null, to: minDay(tDay, trialEnd) || tDay } });
        break;
      case 'trial_declined':
        if (row.trialEnd) m.trialEndX = row.trialEnd;
        addEvent(state, m, imp, 'trial_declined', row.canceledAt
          ? { day: row.canceledAt, precision: px('canceledAt') }
          : trialEnd && trialEnd <= tDay ? { day: trialEnd, precision: 'estimated' }
            : { day: tDay, precision: 'window', window: sinceJoin });
        break;
      case 'trial_ended':
        if (row.trialEnd) m.trialEndX = row.trialEnd;
        addEvent(state, m, imp, 'trial_ended', trialEnd
          ? { day: trialEnd, precision: row.trialEnd ? px('trialEnd') : 'estimated' }
          : { day: tDay, precision: 'window', window: sinceJoin });
        break;
      case 'paid_verified':
        addEvent(state, m, imp, 'paid_verified', row.paidAt
          ? { day: row.paidAt, precision: px('paidAt') }
          : trialEnd && trialEnd <= tDay ? { day: trialEnd, precision: 'estimated' }
            : { day: tDay, precision: 'window', window: sinceJoin });
        break;
      case 'canceling': {
        // Asked to cancel, still in the community. Recorded as its own event:
        // it is NOT a departure and must not close a paying interval.
        const endsOn = row.endsAt || null;
        addEvent(state, m, imp, 'cancel_scheduled', row.canceledAt
          ? { day: row.canceledAt, precision: px('canceledAt'), data: { endsOn, endsApprox: !!(row.approx && row.approx.endsAt) } }
          : { day: tDay, precision: 'window', window: { from: m.lastSeenDay || m.joinDay || null, to: tDay }, data: { endsOn, endsApprox: !!(row.approx && row.approx.endsAt) } });
        break;
      }
      case 'churned': {
        // No date given, but they were canceling with a known end date that
        // has passed: that end date is when they left.
        const sched = m.events.filter((e) => e.type === 'cancel_scheduled').pop();
        const endsOn = sched && sched.data && sched.data.endsOn && sched.data.endsOn <= tDay ? sched.data.endsOn : null;
        addEvent(state, m, imp, 'churned', row.churnedAt
          ? { day: row.churnedAt, precision: px('churnedAt') }
          : endsOn ? { day: endsOn, precision: 'estimated' }
            : { day: tDay, precision: 'window', window: { from: (sched && sched.precision !== 'window' && sched.day) || m.lastSeenDay || m.joinDay || null, to: tDay } });
        break;
      }
      case 'returning':
        addEvent(state, m, imp, 'returned', row.returnedAt
          ? { day: row.returnedAt, precision: px('returnedAt') }
          : { day: tDay, precision: 'window', window: { from: m.missingFrom || m.lastSeenDay || null, to: tDay } });
        break;
      default:
        addEvent(state, m, imp, 'note', { day: tDay, precision: 'exact', data: { text: 'Listed in a pasted import with no recognisable status.' } });
    }
  }
  state.matchLog[imp.id] = log;
}

function applyManual(state, db) {
  const voided = new Set();
  for (const rec of db.manual || []) {
    if (!rec || rec.removed) continue;
    if (rec.type === 'void') { voided.add(rec.key); continue; }
    const m = state.byId.get(rec.memberId);
    if (!m) { state.warnings.push({ level: 'warn', code: 'orphan_manual', message: `A manual ${rec.type} points at a member that no longer exists (${rec.memberId}).` }); continue; }
    if (rec.type === 'event') {
      const ev = addEvent(state, m, null, rec.eventType, { day: rec.day, precision: 'exact', data: { note: rec.note || '' }, observedAt: rec.at });
      ev.manualId = rec.id;
    } else if (rec.type === 'payment' || rec.type === 'refund' || rec.type === 'failed_payment') {
      const ev = addEvent(state, m, null, rec.type, { day: rec.day, precision: 'exact', data: { amount: Number(rec.amount) || 0, note: rec.note || '' }, observedAt: rec.at });
      ev.manualId = rec.id;
    } else if (rec.type === 'override') {
      if (['source', 'price', 'interval', 'attribution', 'name'].includes(rec.field)) m[rec.field] = rec.value;
    }
  }
  if (voided.size) for (const m of state.members) m.events = m.events.filter((e) => !voided.has(e.key));
}

/**
 * Rebuild everything from the imports.
 *
 * @param db       the stored document (settings, import index, manual records)
 * @param imports  full import records, any order; reverted ones are skipped
 * @param opts     { today } — the business-timezone day to derive "now" from
 */
export function buildState(db, imports, opts = {}) {
  const settings = withDefaults(db && db.settings);
  const state = newState(settings);
  const reverted = new Set(((db && db.imports) || []).filter((i) => i.reverted).map((i) => i.id));
  const live = (imports || []).filter((i) => i && !reverted.has(i.id))
    .slice().sort((a, b) => String(a.observedAt).localeCompare(String(b.observedAt)));

  for (const imp of live) {
    if (imp.kind === 'csv') applyCsv(state, imp);
    else if (imp.kind === 'paste') applyPaste(state, imp);
  }
  applyManual(state, db || {});

  state.today = opts.today || dayIn(new Date(), settings.timezone);
  for (const m of state.members) {
    m.events.sort((a, b) => String(a.day || '').localeCompare(String(b.day || '')) || a.seq - b.seq);
    derive(m, state);
  }
  return state;
}

/* --------------------------------------------------------------- derive -- */

export const MEMBER_STATUS_LABEL = {
  paying: 'Paying — verified',
  canceling: 'Canceling — still a member',
  trial_active: 'Active trial',
  trial_canceled: 'Trial canceled',
  cancel_scheduled: 'Cancellation requested — still a member',
  trial_declined: 'Trial declined',
  trial_unresolved: 'Trial ended — payment outcome unknown',
  churned: 'Churned',
  returned_unverified: 'Returned — payment status unverified',
  missing_unverified: 'Missing From Latest Export — Status Unverified',
  free: 'Free member',
  unknown: 'Unknown or unverified',
};

export const monthlyValue = (price, interval) =>
  !price ? 0 : interval === 'year' ? price / 12 : interval === 'month' ? price : 0;

/** What a gross charge is worth after the configured fees. */
export function netOf(gross, settings, source) {
  const f = withDefaults(settings).fees;
  const pct = (Number(f.platformPct) || 0) + (Number(f.processingPct) || 0) + (source === 'skool' ? Number(f.networkSharePct) || 0 : 0);
  return gross <= 0 ? gross : Math.max(0, gross * (1 - pct / 100) - (Number(f.perTransaction) || 0));
}

function derive(m, state) {
  const st = state.settings;
  const today = state.today;
  const ev = (type) => m.events.filter((e) => e.type === type);
  const first = (type) => ev(type)[0] || null;
  const flags = [];
  const d = { flags };

  d.isFree = m.price === 0;
  d.planKnown = m.price != null;
  const pasteTrial = first('trial_started') || first('trial_canceled') || first('trial_declined') || first('trial_ended');
  d.hasTrial = !!(
    (m.price > 0 && st.trialDays > 0 && m.joinDay && (!st.trialAppliesFrom || m.joinDay >= st.trialAppliesFrom)) || pasteTrial
  );
  const started = first('trial_started');
  d.trialStart = d.hasTrial ? (m.trialStartX || (started && started.precision !== 'window' ? started.day : null) || m.joinDay) : null;
  d.trialStartInferred = d.hasTrial && !m.trialStartX && !(started && started.precision === 'exact');
  d.trialEnd = d.hasTrial ? (m.trialEndX || (d.trialStart ? addDays(d.trialStart, st.trialDays) : null)) : null;

  /* ---- evidence that money actually changed hands ---- */
  const paidEv = first('paid_verified');
  const manualPay = ev('payment').filter((e) => e.data && e.data.amount > 0);
  const ltvObs = m.obs.filter((o) => o.present && o.ltv > 0);
  d.paidEvidence = manualPay.length ? 'payment record' : paidEv ? 'pasted from Skool' : ltvObs.length ? 'recorded LTV' : null;

  d.firstPaidDay = null;
  d.firstPaidPrecision = null;
  d.firstPaidWindow = null;
  if (d.paidEvidence) {
    const expected = d.trialEnd || m.joinDay || null;
    if (manualPay.length) {
      d.firstPaidDay = manualPay.map((e) => e.day).sort()[0];
      d.firstPaidPrecision = 'exact';
    } else if (paidEv && paidEv.precision !== 'window') {
      d.firstPaidDay = paidEv.day;
      d.firstPaidPrecision = paidEv.precision;
    } else if (ltvObs.length) {
      // Bounded by the last export that still showed $0 and the first that did not.
      const firstPos = ltvObs[0];
      const idx = m.obs.indexOf(firstPos);
      const before = idx > 0 ? m.obs[idx - 1] : null;
      const lo = before && before.present ? before.day : m.joinDay;
      const hi = firstPos.day;
      d.firstPaidWindow = { from: lo || null, to: hi };
      let est = expected && expected <= hi ? expected : hi;
      if (lo && est < lo) est = lo;
      d.firstPaidDay = est;
      d.firstPaidPrecision = 'estimated';
    } else {
      d.firstPaidDay = paidEv.day;
      d.firstPaidPrecision = 'window';
      d.firstPaidWindow = paidEv.window;
    }
  }

  /* ---- trial outcome. Ending is NOT converting. ---- */
  // Somebody on a trial who asked to cancel, or who left without ever paying,
  // canceled their TRIAL. Neither is a paying member churning.
  const canceled = first('trial_canceled') || (!d.paidEvidence ? first('cancel_scheduled') || first('churned') : null) || null;
  const declined = first('trial_declined');
  d.trialOutcome = 'none';
  d.trialOutcomeDay = null;
  d.trialOutcomePrecision = null;
  if (d.hasTrial) {
    if (d.paidEvidence) {
      d.trialOutcome = 'converted'; d.trialOutcomeDay = d.firstPaidDay; d.trialOutcomePrecision = d.firstPaidPrecision;
    } else if (canceled) {
      d.trialOutcome = 'canceled'; d.trialOutcomeDay = canceled.day; d.trialOutcomePrecision = canceled.precision;
    } else if (declined) {
      d.trialOutcome = 'declined'; d.trialOutcomeDay = declined.day; d.trialOutcomePrecision = declined.precision;
    } else if (d.trialEnd && today < d.trialEnd) {
      d.trialOutcome = 'active';
    } else {
      d.trialOutcome = 'unresolved';
    }
  }
  d.trialMatured = d.hasTrial && d.trialOutcome !== 'active';
  d.trialKnown = ['converted', 'canceled', 'declined'].includes(d.trialOutcome);

  /* ---- paying intervals, for anything that asks "as of day X" ---- */
  const intervals = [];
  let open = d.firstPaidDay ? { start: d.firstPaidDay, end: null } : null;
  d.returnDays = [];
  d.churns = [];
  let returnUnverified = false;
  for (const e of m.events) {
    if (e.type === 'churned') {
      d.churns.push(e);
      if (open && (!e.day || e.day >= open.start)) { open.end = e.day; open.endPrecision = e.precision; intervals.push(open); open = null; }
    } else if (e.type === 'returned' || e.type === 'rejoined' || e.type === 'reactivated') {
      d.returnDays.push({ day: e.day, precision: e.precision, window: e.window });
      if (!open && d.firstPaidDay && intervals.length) {
        const paidAgain = m.events.some((p) =>
          ((p.type === 'payment_observed' && p.day >= e.day) || (p.type === 'payment' && p.day >= e.day) || p.type === 'reactivated' && p === e));
        if (paidAgain) open = { start: e.day, end: null, afterReturn: true };
        else returnUnverified = true;
      } else if (open) returnUnverified = false;
    }
  }
  if (open) intervals.push(open);
  d.intervals = intervals;
  d.returned = d.returnDays.length > 0;
  const lastChurn = d.churns.length ? d.churns[d.churns.length - 1] : null;
  // "Churn" everywhere downstream means a PAYING member leaving. A trial
  // member who left is already counted as a trial cancellation.
  if (!d.paidEvidence) d.churns = [];
  d.churnDay = lastChurn ? lastChurn.day : null;
  d.churnPrecision = lastChurn ? lastChurn.precision : null;
  d.churnWindow = lastChurn ? lastChurn.window : null;
  const payingNow = intervals.some((i) => !i.end);

  /* ---- canceling: asked to stop, still here ---- */
  const scheds = ev('cancel_scheduled');
  const sched = scheds[scheds.length - 1] || null;
  // A payment that can only have happened after the request means they changed their mind.
  const resumed = !!sched && m.events.some((p) =>
    (p.type === 'payment_observed' && p.window && p.window.from && p.window.from >= sched.day) ||
    (p.type === 'payment' && p.day > sched.day) ||
    ((p.type === 'reactivated' || p.type === 'returned' || p.type === 'rejoined') && p.day >= sched.day && p.seq > sched.seq));
  d.canceling = !!(sched && d.paidEvidence && payingNow && !resumed);
  d.cancelRequestedDay = d.canceling ? sched.day : null;
  d.cancelRequestedPrecision = d.canceling ? sched.precision : null;
  d.cancelRequestedWindow = d.canceling ? sched.window : null;
  d.accessEnds = d.canceling && sched.data ? sched.data.endsOn || null : null;
  d.accessEndsApprox = !!(d.canceling && sched.data && sched.data.endsApprox);

  /* ---- one status, with the evidence ranked ---- */
  const lastLife = lastLifecycle(m);
  if (lastChurn && lastLife === lastChurn && d.paidEvidence) d.status = 'churned';
  else if (!d.paidEvidence && d.hasTrial && canceled) d.status = 'trial_canceled';
  else if (lastChurn && lastLife === lastChurn) d.status = 'churned';
  else if (!d.paidEvidence && declined) d.status = 'trial_declined';
  else if (m.present === false) d.status = 'missing_unverified';
  else if (d.canceling) d.status = 'canceling';
  else if (payingNow) d.status = 'paying';
  else if (returnUnverified || (lastChurn && d.returned)) d.status = 'returned_unverified';
  else if (d.isFree) d.status = 'free';
  else if (d.trialOutcome === 'active') d.status = 'trial_active';
  else if (d.trialOutcome === 'unresolved') d.status = 'trial_unresolved';
  else d.status = 'unknown';
  d.statusLabel = MEMBER_STATUS_LABEL[d.status];
  d.verified = ['paying', 'canceling', 'trial_canceled', 'trial_declined', 'churned', 'free'].includes(d.status);

  d.monthly = monthlyValue(m.price, m.interval);
  d.monthlyNet = !m.price ? 0 : m.interval === 'year' ? netOf(m.price, st, m.source) / 12 : m.interval === 'month' ? netOf(m.price, st, m.source) : 0;
  // A canceling member is still paying until their period ends.
  d.countsToMrr = d.status === 'paying' || d.status === 'canceling';
  d.isPaying = d.countsToMrr;

  /* ---- payments: verified TOTAL, dates as good as the evidence allows ---- */
  const payments = [];
  let manualTotal = 0;
  for (const e of m.events) {
    if (e.type === 'payment') { payments.push({ day: e.day, amount: e.data.amount, precision: 'exact', kind: 'payment' }); manualTotal += e.data.amount; }
    if (e.type === 'refund') { payments.push({ day: e.day, amount: -Math.abs(e.data.amount), precision: 'exact', kind: 'refund' }); manualTotal -= Math.abs(e.data.amount); }
  }
  d.failedPayments = ev('failed_payment').length;
  const ltv = m.ltv || 0;
  let remaining = Math.round((ltv - manualTotal) * 100) / 100;
  if (remaining > 0.004 && d.firstPaidDay) {
    // Skool reports a running total, not a ledger. The total is real; the dates
    // are placed on the billing anchor and marked as estimated.
    const cap = m.ltvDay || today;
    const step = m.interval === 'year' ? 12 : m.interval === 'month' ? 1 : 0;
    const unit = m.price > 0 ? m.price : remaining;
    let day = d.firstPaidDay;
    let n = 0;
    let lastPlaced = null;
    while (remaining > 0.004 && day <= cap && n < 600) {
      const amt = Math.min(unit, remaining);
      payments.push({ day, amount: Math.round(amt * 100) / 100, precision: 'estimated', kind: 'payment' });
      remaining = Math.round((remaining - amt) * 100) / 100;
      lastPlaced = payments[payments.length - 1];
      n++;
      if (!step) break;
      day = addMonths(d.firstPaidDay, step * n);
    }
    if (remaining > 0.004) {
      if (lastPlaced) lastPlaced.amount = Math.round((lastPlaced.amount + remaining) * 100) / 100;
      else payments.push({ day: minDay(d.firstPaidDay, cap), amount: remaining, precision: 'estimated', kind: 'payment' });
      flags.push({ code: 'ltv_ahead', message: `Recorded LTV ($${ltv.toFixed(2)}) is more than the current price explains — a price change, an annual payment or an earlier membership.` });
    } else if (step && m.price > 0 && d.status === 'paying') {   // not while canceling: no further charge is expected
      const due = addDays(day, st.graceDays);
      if (due <= cap) flags.push({ code: 'payment_overdue', message: `A payment was expected around ${day} but recorded LTV has not moved. Possible failed payment or cancellation — unverified.` });
    }
  } else if (remaining < -0.004) {
    flags.push({ code: 'ltv_behind', message: 'Manual payment records add up to more than Skool\'s recorded LTV.' });
  }
  for (const e of ev('refund_observed')) payments.push({ day: e.day, amount: 0, precision: 'window', kind: 'refund_observed', note: e.data.amount });
  payments.sort((a, b) => String(a.day).localeCompare(String(b.day)));
  d.payments = payments;
  d.revenue = Math.round(payments.reduce((s, p) => s + p.amount, 0) * 100) / 100;

  if (d.hasTrial && d.trialStartInferred) flags.push({ code: 'trial_inferred', message: 'Trial start is inferred from the join date.' });
  if (d.trialOutcome === 'unresolved') {
    const after = m.obs.filter((o) => o.present && d.trialEnd && o.day >= d.trialEnd && (o.ltv === 0 || o.ltv == null));
    flags.push({
      code: 'trial_unresolved',
      message: after.length
        ? `Trial ended ${d.trialEnd}; an export on ${after[after.length - 1].day} still showed $0 recorded LTV. Not counted as paid or as canceled until verified.`
        : `Trial ended ${d.trialEnd}; no payment or cancellation evidence yet.`,
    });
  }
  if (!d.hasTrial && m.price > 0 && !d.paidEvidence) flags.push({ code: 'no_trial_unpaid', message: `Joined on a paid plan ${st.trialAppliesFrom && m.joinDay && m.joinDay < st.trialAppliesFrom ? `before the free trial began (${st.trialAppliesFrom})` : 'with no trial'}, but there is no payment evidence yet.` });
  if (!d.planKnown) flags.push({ code: 'plan_unknown', message: 'Membership price is not known for this member.' });
  if (m.possibleDuplicateOf && m.possibleDuplicateOf.length) flags.push({ code: 'possible_duplicate', message: 'Shares a name with another member and could not be matched with confidence.' });
  if (d.canceling) flags.push({ code: 'canceling', message: `Asked to cancel${sched.precision === 'window' ? '' : ` on ${sched.day}`}; still a member${d.accessEnds ? ` until ${d.accessEnds}` : ''}. Counted as paying, not as churned, until the churned list confirms they have left.` });
  if (d.canceling && d.accessEnds && d.accessEnds < today) flags.push({ code: 'cancel_overdue', message: `Access was due to end ${d.accessEnds}. Upload the churned list to confirm they have left.` });
  if (d.status === 'missing_unverified' && sched && !resumed) flags.push({ code: 'missing_after_cancel', message: 'Had asked to cancel before disappearing from the export — very likely churned. Upload the churned list to confirm.' });
  if (d.status === 'missing_unverified') flags.push({ code: 'missing', message: `Last listed in the export of ${m.missingFrom}; absent since the export of ${m.missingDay}. Left, removed or churned — unverified.` });

  m.d = d;
}

/* -------------------------------------------------------------- context -- */

/** Index the stored Meta history for fast per-day lookups. */
export function indexMeta(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const ads = m.ads || {};
  const byDay = new Map();
  const byAd = new Map();
  let first = null;
  let last = null;
  for (const r of m.daily || []) {
    const row = Array.isArray(r)
      ? { day: r[0], adId: r[1], spend: r[2] || 0, impressions: r[3] || 0, reach: r[4] || 0, clicks: r[5] || 0, linkClicks: r[6] || 0, lpv: r[7] || 0, conv: r[8] || 0 }
      : r;
    if (!isDay(row.day)) continue;
    if (!byDay.has(row.day)) byDay.set(row.day, []);
    byDay.get(row.day).push(row);
    if (!byAd.has(row.adId)) byAd.set(row.adId, []);
    byAd.get(row.adId).push(row);
    first = minDay(first, row.day);
    last = maxDay(last, row.day);
  }
  for (const list of byAd.values()) list.sort((a, b) => a.day.localeCompare(b.day));
  return {
    account: m.account || null, ads, byDay, byAd, first, last,
    syncedAt: m.syncedAt || null, statusChanges: m.statusChanges || [], available: byDay.size > 0,
    attribution: m.attribution || null,
  };
}

export function buildContext(db, imports, meta, opts = {}) {
  const state = buildState(db, imports, opts);
  return {
    db, settings: state.settings, today: state.today, state,
    members: state.members, byId: state.byId,
    meta: indexMeta(meta),
    lastCsv: state.lastCsv, csvImports: state.csvImports,
    demo: !!opts.demo,
  };
}

const delivered = (r) => r.impressions > 0 || r.spend > 0;

function adFilter(ctx, sel) {
  if (!sel || !sel.ids || !sel.ids.length) return null;
  const level = sel.level || 'ad';
  const ids = new Set(sel.ids);
  return (row) => {
    if (level === 'ad') return ids.has(row.adId);
    const ad = ctx.meta.ads[row.adId] || {};
    return ids.has(level === 'adset' ? ad.adsetId : ad.campaignId);
  };
}

/* ---------------------------------------------------------- daily series -- */

export const SERIES = [
  { key: 'spend', label: 'Ad spend', unit: 'money', group: 'ads' },
  { key: 'joins', label: 'New member signups', unit: 'count', group: 'members' },
  { key: 'trialStarts', label: 'Free trial starts', unit: 'count', group: 'members' },
  { key: 'trialCancels', label: 'Trial cancellations', unit: 'count', group: 'members' },
  { key: 'conversions', label: 'Trial-to-paid conversions', unit: 'count', group: 'members' },
  { key: 'directPaid', label: 'New paying, no trial', unit: 'count', group: 'members' },
  { key: 'cancelRequests', label: 'Cancellations requested (still members)', unit: 'count', group: 'members' },
  { key: 'churn', label: 'Paid member churn (left)', unit: 'count', group: 'members' },
  { key: 'returns', label: 'Returning members', unit: 'count', group: 'members' },
  { key: 'net', label: 'Net member growth', unit: 'count', group: 'members' },
  { key: 'revenue', label: 'Revenue collected', unit: 'money', group: 'money' },
  { key: 'newMrr', label: 'New MRR', unit: 'money', group: 'money' },
  { key: 'missing', label: 'Went missing (unverified)', unit: 'count', group: 'members' },
  { key: 'impressions', label: 'Impressions', unit: 'count', group: 'ads' },
  { key: 'clicks', label: 'Clicks', unit: 'count', group: 'ads' },
  { key: 'lpv', label: 'Landing-page views', unit: 'count', group: 'ads' },
  { key: 'metaConv', label: 'Meta-reported conversions', unit: 'count', group: 'ads' },
];

/**
 * One row per day for [from, to], ad metrics beside membership metrics.
 *
 * `soft[key][i]` counts how many of that day's events are NOT exact — dated by
 * a rule or by the day they were observed. The chart draws those differently.
 * An ad selection narrows the AD metrics only; membership is the whole
 * community, because nothing here knows which ad a member came from.
 */
export function dailySeries(ctx, from, to, sel) {
  const days = daysBetween(from, to);
  const idx = new Map(days.map((d, i) => [d, i]));
  const m = {};
  const soft = {};
  for (const s of SERIES) { m[s.key] = days.map(() => 0); soft[s.key] = days.map(() => 0); }
  const bump = (key, day, amount, precision) => {
    const i = idx.get(day);
    if (i === undefined) return;
    m[key][i] += amount;
    if (precision && precision !== 'exact') soft[key][i] += 1;
  };

  const keep = adFilter(ctx, sel);
  days.forEach((d, i) => {
    for (const r of ctx.meta.byDay.get(d) || []) {
      if (keep && !keep(r)) continue;
      m.spend[i] += r.spend; m.impressions[i] += r.impressions; m.clicks[i] += r.clicks;
      m.lpv[i] += r.lpv; m.metaConv[i] += r.conv;
    }
  });

  for (const mem of ctx.members) {
    const d = mem.d;
    const j = mem.events.find((e) => e.type === 'joined');
    if (j) bump('joins', j.day, 1, j.precision);
    if (d.hasTrial && d.trialStart) bump('trialStarts', d.trialStart, 1, d.trialStartInferred ? 'estimated' : 'exact');
    if (d.trialOutcome === 'canceled' || d.trialOutcome === 'declined') bump('trialCancels', d.trialOutcomeDay, 1, d.trialOutcomePrecision);
    if (d.firstPaidDay) {
      // A trial that converted and a member who simply paid to join are two
      // different things, and only the first belongs in a conversion count.
      bump(d.hasTrial ? 'conversions' : 'directPaid', d.firstPaidDay, 1, d.firstPaidPrecision);
      bump('newMrr', d.firstPaidDay, d.monthly, d.firstPaidPrecision);
    }
    for (const c of d.churns) bump('churn', c.day, 1, c.precision);
    if (d.paidEvidence) for (const e of mem.events) if (e.type === 'cancel_scheduled') bump('cancelRequests', e.day, 1, e.precision);
    for (const r of d.returnDays) bump('returns', r.day, 1, r.precision);
    for (const e of mem.events) if (e.type === 'missing_from_export') bump('missing', e.day, 1, 'window');
    for (const p of d.payments) if (p.amount) bump('revenue', p.day, p.amount, p.precision);
  }
  days.forEach((_, i) => {
    m.net[i] = m.joins[i] + m.returns[i] - m.churn[i] - m.trialCancels[i];
    m.spend[i] = Math.round(m.spend[i] * 100) / 100;
    m.revenue[i] = Math.round(m.revenue[i] * 100) / 100;
    m.newMrr[i] = Math.round(m.newMrr[i] * 100) / 100;
    soft.net[i] = soft.joins[i] + soft.returns[i] + soft.churn[i] + soft.trialCancels[i];
  });
  return { days, metrics: m, soft };
}

const sum = (a) => a.reduce((s, v) => s + v, 0);
/** Paid to join with no trial — the offer did not exist yet, or does not apply. */
export const paidWithoutTrial = (m) => !m.d.hasTrial && !!m.d.firstPaidDay;
const r2 = (n) => Math.round(n * 100) / 100;
const ratio = (a, b) => (b > 0 ? a / b : null);
/** A cost per something. No spend on record is "unknown", not "free". */
const costPer = (spend, n) => (spend > 0 ? ratio(spend, n) : null);

/* ----------------------------------------------------------- trial stats -- */

/**
 * Trial-to-paid conversion = verified converted / trials with a KNOWN outcome.
 * Unresolved trials are in neither half; `coverage` says how much of the
 * matured population the rate actually rests on.
 */
export function trialStats(members) {
  const t = { trials: 0, active: 0, converted: 0, canceled: 0, declined: 0, unresolved: 0 };
  for (const m of members) {
    if (!m.d.hasTrial) continue;
    t.trials++;
    if (m.d.trialOutcome === 'active') t.active++;
    else if (m.d.trialOutcome === 'converted') t.converted++;
    else if (m.d.trialOutcome === 'canceled') t.canceled++;
    else if (m.d.trialOutcome === 'declined') t.declined++;
    else t.unresolved++;
  }
  t.nonConverted = t.canceled + t.declined;
  t.known = t.converted + t.nonConverted;
  t.matured = t.known + t.unresolved;
  t.rate = ratio(t.converted, t.known);
  t.coverage = ratio(t.known, t.matured);
  // The honest bounds: every unresolved trial failing, and every one converting.
  t.rateFloor = ratio(t.converted, t.matured);
  t.rateCeiling = ratio(t.converted + t.unresolved, t.matured);
  return t;
}

export function conversionBy(ctx, dim) {
  const keyOf = {
    week: (m) => (m.joinDay ? weekStart(m.joinDay) : null),
    month: (m) => (m.joinDay ? m.joinDay.slice(0, 7) : null),
    trialWeek: (m) => (m.d.trialStart ? weekStart(m.d.trialStart) : null),
    plan: (m) => planLabel(ctx.settings, m),
    source: (m) => SOURCE_LABELS[m.source || 'unknown'],
  }[dim];
  const groups = new Map();
  for (const m of ctx.members) {
    if (!m.d.hasTrial) continue;
    const k = keyOf(m) || 'Unknown';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  return [...groups.entries()].map(([key, list]) => ({ key, ...trialStats(list) }))
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

export function planLabel(settings, m) {
  if (m.price == null) return 'Unknown plan';
  const p = settings.plans.find((x) => Math.abs(x.price - m.price) < 0.005 && (x.interval === m.interval || !m.interval));
  if (p) return p.label;
  if (m.price === 0) return 'Free';
  return `$${m.price}${m.interval === 'year' ? ' / year' : m.interval === 'month' ? ' / month' : ''}`;
}

/* ---------------------------------------------------------------- money -- */

const payingOn = (m, day) =>
  m.d.intervals.some((i) => i.start <= day && (!i.end || i.end > day)) &&
  !(m.present === false && m.missingDay && m.missingDay <= day && !m.d.intervals.every((i) => i.end));

/** MRR as of one day. Annual plans count at a twelfth; trials count at nothing. */
export function mrrAt(ctx, day) {
  let gross = 0; let net = 0; let payers = 0;
  const byPlan = new Map();
  for (const m of ctx.members) {
    if (!payingOn(m, day)) continue;
    payers++;
    gross += m.d.monthly; net += m.d.monthlyNet;
    const k = planLabel(ctx.settings, m);
    const p = byPlan.get(k) || { plan: k, members: 0, gross: 0, net: 0 };
    p.members++; p.gross += m.d.monthly; p.net += m.d.monthlyNet;
    byPlan.set(k, p);
  }
  return { day, payers, gross: r2(gross), net: r2(net), byPlan: [...byPlan.values()].map((p) => ({ ...p, gross: r2(p.gross), net: r2(p.net) })) };
}

/** MRR that is still coming in but is scheduled to stop: members who have asked to cancel. */
export function mrrCanceling(ctx) {
  const list = ctx.members.filter((m) => m.d.status === 'canceling');
  return { members: list.length, gross: r2(sum(list.map((m) => m.d.monthly))), net: r2(sum(list.map((m) => m.d.monthlyNet))) };
}

/** Unverified MRR: members who were paying when they vanished from an export. */
export function mrrAtRisk(ctx) {
  let gross = 0; let n = 0;
  for (const m of ctx.members) {
    if (m.d.status === 'missing_unverified' && m.d.intervals.some((i) => !i.end)) { gross += m.d.monthly; n++; }
  }
  return { members: n, gross: r2(gross) };
}

export function expensesIn(ctx, from, to) {
  let total = 0;
  const days = diffDays(from, to) + 1;
  for (const e of ctx.settings.expenses || []) {
    const amt = Number(e.amount) || 0;
    if (e.cadence === 'once') { if (isDay(e.day) && e.day >= from && e.day <= to) total += amt; }
    else if (e.cadence === 'annual') total += (amt / 365) * days;
    else total += (amt / 30.4375) * days;
  }
  return r2(total);
}

/* --------------------------------------------------------- period summary -- */

/**
 * Everything the Growth Timeline says about one date range.
 *
 * Two different questions are answered and kept apart:
 *   activity  what HAPPENED in these days (spend, churn, cash collected)
 *   cohort    what became of the people who JOINED in these days — however
 *             much later it happened. A trial started on the 1st pays on the
 *             8th; counting that payment against the 8th's ad spend would
 *             credit the wrong week.
 */
export function periodSummary(ctx, from, to, sel) {
  const s = dailySeries(ctx, from, to, sel);
  const M = s.metrics;
  const keep = adFilter(ctx, sel);
  const adsRunning = new Map();
  for (const d of s.days) {
    for (const r of ctx.meta.byDay.get(d) || []) {
      if (keep && !keep(r)) continue;
      if (!delivered(r)) continue;
      const a = adsRunning.get(r.adId) || { id: r.adId, name: (ctx.meta.ads[r.adId] || {}).name || r.adId, spend: 0, days: 0, first: d, last: d };
      a.spend += r.spend; a.days++; a.last = d;
      adsRunning.set(r.adId, a);
    }
  }

  const cohort = ctx.members.filter((m) => m.joinDay && m.joinDay >= from && m.joinDay <= to);
  const t = trialStats(cohort);
  const cohortRevenue = r2(sum(cohort.map((m) => m.d.revenue)));
  const directPaid = cohort.filter(paidWithoutTrial).length;
  const spend = r2(sum(M.spend));
  const revenue = r2(sum(M.revenue));
  const fees = r2(sum(ctx.members.map((m) => sum(m.d.payments.filter((p) => p.amount > 0 && p.day >= from && p.day <= to).map((p) => p.amount - netOf(p.amount, ctx.settings, m.source))))));
  const other = expensesIn(ctx, from, to);
  const softCount = (k) => sum(s.soft[k]);

  return {
    from, to, days: s.days.length,
    activity: {
      spend, impressions: sum(M.impressions), clicks: sum(M.clicks), lpv: sum(M.lpv), metaConv: sum(M.metaConv),
      cpc: ratio(spend, sum(M.clicks)), cpm: ratio(spend * 1000, sum(M.impressions)), ctr: ratio(sum(M.clicks) * 100, sum(M.impressions)),
      costPerLpv: ratio(spend, sum(M.lpv)),
      joins: sum(M.joins), trialStarts: sum(M.trialStarts), trialCancels: sum(M.trialCancels), conversions: sum(M.conversions),
      directPaid: sum(M.directPaid), newPaying: sum(M.conversions) + sum(M.directPaid),
      churn: sum(M.churn), cancelRequests: sum(M.cancelRequests), returns: sum(M.returns), missing: sum(M.missing), net: sum(M.net),
      revenue, newMrr: r2(sum(M.newMrr)), fees, otherExpenses: other,
      netCash: r2(revenue - fees - spend - other),
      soft: { conversions: softCount('conversions'), churn: softCount('churn'), returns: softCount('returns'), revenue: softCount('revenue'), trialCancels: softCount('trialCancels') },
    },
    adsRunning: [...adsRunning.values()].map((a) => ({ ...a, spend: r2(a.spend) })).sort((a, b) => b.spend - a.spend),
    cohort: {
      joined: cohort.length,
      free: cohort.filter((m) => m.d.isFree).length,
      ...t,
      churned: cohort.filter((m) => m.d.churns.length).length,
      returned: cohort.filter((m) => m.d.returned).length,
      missing: cohort.filter((m) => m.d.status === 'missing_unverified').length,
      stillPaying: cohort.filter((m) => m.d.isPaying).length,
      canceling: cohort.filter((m) => m.d.status === 'canceling').length,
      revenue: cohortRevenue,
      // Blended, never "attributed": every join in the window over every dollar in it.
      blendedCostPerTrial: costPer(spend, t.trials),
      // Paying members who never had a trial: joined before the offer began.
      directPaid, newPaying: t.converted + directPaid,
      // Acquisition cost is over EVERY new paying member, trial or not —
      // dividing by trial conversions alone would price a pre-trial cohort at infinity.
      blendedCac: costPer(spend, t.converted + directPaid),
      blendedRoas: ratio(cohortRevenue, spend),
      fullyMatured: t.active === 0,
    },
    series: s,
  };
}

export function previousRange(from, to) {
  const n = diffDays(from, to) + 1;
  return { from: addDays(from, -n), to: addDays(from, -1) };
}
export const pctChange = (now, before) => (before > 0 ? ((now - before) / before) * 100 : null);

/* --------------------------------------------------------------- cohorts -- */

export function retentionOf(members, today, n) {
  let eligible = 0; let retained = 0; let unknown = 0;
  for (const m of members) {
    const start = m.d.firstPaidDay;
    if (!start) continue;
    const mark = addDays(start, n);
    if (mark > today) continue;                 // not old enough to say
    eligible++;
    const firstEnd = m.d.intervals[0] && m.d.intervals[0].end;
    if (firstEnd && firstEnd <= mark) continue; // verified churn inside the window
    if (m.present === false && m.missingDay && m.missingDay <= mark && !firstEnd) { unknown++; continue; }
    retained++;
  }
  return { n, eligible, retained, unknown, rate: ratio(retained, eligible - unknown) };
}

export function cohorts(ctx, grain = 'week') {
  const keyOf = grain === 'month' ? (d) => monthStart(d) : weekStart;
  const endOf = grain === 'month' ? (k) => addDays(addMonths(k, 1), -1) : (k) => addDays(k, 6);
  const groups = new Map();
  for (const m of ctx.members) {
    if (!m.joinDay) continue;
    const k = keyOf(m.joinDay);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  return [...groups.keys()].sort().map((k) => {
    const list = groups.get(k);
    const end = endOf(k);
    const t = trialStats(list);
    let spend = 0;
    for (const d of daysBetween(k, minDay(end, ctx.today))) for (const r of ctx.meta.byDay.get(d) || []) spend += r.spend;
    const revenue = r2(sum(list.map((m) => m.d.revenue)));
    const paid = list.filter((m) => m.d.firstPaidDay);
    const directPaid = list.filter(paidWithoutTrial).length;
    return {
      key: k, from: k, to: end, joined: list.length, free: list.filter((m) => m.d.isFree).length, ...t,
      churned: list.filter((m) => m.d.churns.length).length,
      returned: list.filter((m) => m.d.returned).length,
      missing: list.filter((m) => m.d.status === 'missing_unverified').length,
      stillPaying: list.filter((m) => m.d.isPaying).length,
      canceling: list.filter((m) => m.d.status === 'canceling').length,
      revenue, spend: r2(spend),
      spendPerDay: r2(spend / (diffDays(k, minDay(end, ctx.today)) + 1)),
      directPaid, newPaying: t.converted + directPaid,
      blendedCostPerTrial: costPer(spend, t.trials), blendedCac: costPer(spend, t.converted + directPaid), blendedRoas: ratio(revenue, spend),
      r30: retentionOf(paid, ctx.today, 30), r60: retentionOf(paid, ctx.today, 60), r90: retentionOf(paid, ctx.today, 90),
    };
  });
}

/* ------------------------------------------------------------- retention -- */

export function retention(ctx) {
  const paid = ctx.members.filter((m) => m.d.firstPaidDay);
  const paying = ctx.members.filter((m) => m.d.isPaying);
  const tenures = paying.map((m) => diffDays(m.d.firstPaidDay, ctx.today)).sort((a, b) => a - b);
  const months = [];
  const first = paid.map((m) => m.d.firstPaidDay).sort()[0];
  if (first) {
    for (let k = monthStart(first); k <= ctx.today; k = addMonths(k, 1)) {
      const end = minDay(addDays(addMonths(k, 1), -1), ctx.today);
      const startMrr = mrrAt(ctx, k);
      let churned = 0; let churnedMrr = 0; let newPaying = 0; let soft = 0;
      for (const m of paid) {
        if (m.d.firstPaidDay >= k && m.d.firstPaidDay <= end) newPaying++;
        for (const i of m.d.intervals) {
          if (i.end && i.end >= k && i.end <= end) { churned++; churnedMrr += m.d.monthly; if (i.endPrecision !== 'exact') soft++; }
        }
      }
      months.push({
        key: k.slice(0, 7), startPayers: startMrr.payers, startMrr: startMrr.gross, newPaying, churned, churnedMrr: r2(churnedMrr), soft,
        churnRate: ratio(churned, startMrr.payers), revenueChurn: ratio(churnedMrr, startMrr.gross),
        partial: end === ctx.today && end !== addDays(addMonths(k, 1), -1),
      });
    }
  }
  // A blended monthly churn over the last three COMPLETE months that had payers.
  const complete = months.filter((x) => !x.partial && x.startPayers > 0).slice(-3);
  const blended = complete.length ? ratio(sum(complete.map((x) => x.churned)), sum(complete.map((x) => x.startPayers))) : null;
  return {
    activePaying: paying.length,
    everPaid: paid.length,
    paidChurned: ctx.members.filter((m) => m.d.status === 'churned' && m.d.firstPaidDay).length,
    canceling: ctx.members.filter((m) => m.d.status === 'canceling').length,
    trialCanceled: ctx.members.filter((m) => ['trial_canceled', 'trial_declined'].includes(m.d.status)).length,
    unknownOutcome: ctx.members.filter((m) => ['missing_unverified', 'trial_unresolved', 'returned_unverified', 'unknown'].includes(m.d.status)).length,
    returning: ctx.members.filter((m) => m.d.returned).length,
    r30: retentionOf(paid, ctx.today, 30), r60: retentionOf(paid, ctx.today, 60), r90: retentionOf(paid, ctx.today, 90),
    tenure: {
      n: tenures.length,
      median: tenures.length ? tenures[Math.floor((tenures.length - 1) / 2)] : null,
      mean: tenures.length ? Math.round(sum(tenures) / tenures.length) : null,
      buckets: [['0–30 days', 0, 30], ['31–60 days', 31, 60], ['61–90 days', 61, 90], ['91–180 days', 91, 180], ['181+ days', 181, 1e9]]
        .map(([label, lo, hi]) => ({ label, count: tenures.filter((t) => t >= lo && t <= hi).length })),
    },
    months, blendedMonthlyChurn: blended, churnBasisMonths: complete.length,
  };
}

/* ------------------------------------------------------------------ ads -- */

/** Contiguous stretches of delivery. A gap of a day or more is a pause. */
export function adRuns(rows) {
  const runs = [];
  let cur = null;
  for (const r of rows) {
    if (!delivered(r)) continue;
    if (cur && diffDays(cur.to, r.day) === 1) { cur.to = r.day; cur.days++; cur.spend += r.spend; }
    else { cur = { from: r.day, to: r.day, days: 1, spend: r.spend }; runs.push(cur); }
  }
  return runs.map((x) => ({ ...x, spend: r2(x.spend) }));
}

/**
 * Per-entity history at ad, ad set, campaign or account level.
 *
 * `community` is what the WHOLE community did on the days this entity was
 * delivering — it is a comparison, not an attribution, and `concurrentAds`
 * says how many other ads were delivering on those same days.
 */
export function adEntities(ctx, level = 'ad', from = null, to = null) {
  const groups = new Map();
  for (const [day, rows] of ctx.meta.byDay) {
    if ((from && day < from) || (to && day > to)) continue;
    for (const r of rows) {
      const ad = ctx.meta.ads[r.adId] || {};
      const id = level === 'ad' ? r.adId : level === 'adset' ? ad.adsetId || 'unknown' : level === 'campaign' ? ad.campaignId || 'unknown' : 'account';
      const name = level === 'ad' ? ad.name || r.adId : level === 'adset' ? ad.adsetName || 'Unknown ad set' : level === 'campaign' ? ad.campaignName || 'Unknown campaign' : (ctx.meta.account && ctx.meta.account.name) || 'Ad account';
      if (!groups.has(id)) groups.set(id, { id, name, level, perDay: new Map(), adIds: new Set(), status: null, campaign: ad.campaignName || null, adset: ad.adsetName || null });
      const g = groups.get(id);
      g.adIds.add(r.adId);
      if (level === 'ad') { g.status = ad.effectiveStatus || ad.status || null; g.createdDay = ad.createdDay || null; }
      const p = g.perDay.get(day) || { day, adId: id, spend: 0, impressions: 0, reach: 0, clicks: 0, linkClicks: 0, lpv: 0, conv: 0 };
      p.spend += r.spend; p.impressions += r.impressions; p.reach += r.reach; p.clicks += r.clicks; p.linkClicks += r.linkClicks; p.lpv += r.lpv; p.conv += r.conv;
      g.perDay.set(day, p);
    }
  }

  const joinsByDay = new Map();
  const cohortByDay = new Map();
  for (const m of ctx.members) {
    if (!m.joinDay) continue;
    joinsByDay.set(m.joinDay, (joinsByDay.get(m.joinDay) || 0) + 1);
    if (!cohortByDay.has(m.joinDay)) cohortByDay.set(m.joinDay, []);
    cohortByDay.get(m.joinDay).push(m);
  }

  return [...groups.values()].map((g) => {
    const rows = [...g.perDay.values()].sort((a, b) => a.day.localeCompare(b.day));
    const runs = adRuns(rows);
    const active = rows.filter(delivered);
    const tot = (k) => sum(rows.map((r) => r[k]));
    const spend = r2(tot('spend'));
    let joins = 0; let concurrent = 0;
    const cohort = [];
    for (const r of active) {
      joins += joinsByDay.get(r.day) || 0;
      for (const m of cohortByDay.get(r.day) || []) cohort.push(m);
      const others = new Set((ctx.meta.byDay.get(r.day) || []).filter((x) => delivered(x) && !g.adIds.has(x.adId)).map((x) => x.adId));
      concurrent = Math.max(concurrent, others.size);
    }
    const t = trialStats(cohort);
    return {
      id: g.id, name: g.name, level, status: g.status, campaign: g.campaign, adset: g.adset, adCount: g.adIds.size,
      firstDay: active.length ? active[0].day : null,
      lastDay: active.length ? active[active.length - 1].day : null,
      stillDelivering: active.length ? diffDays(active[active.length - 1].day, ctx.meta.last || ctx.today) <= 1 : false,
      daysActive: active.length, runs, pauses: Math.max(0, runs.length - 1),
      spend, impressions: tot('impressions'), reach: tot('reach'), clicks: tot('clicks'), linkClicks: tot('linkClicks'), lpv: tot('lpv'), conv: tot('conv'),
      ctr: ratio(tot('clicks') * 100, tot('impressions')), cpc: ratio(spend, tot('clicks')), cpm: ratio(spend * 1000, tot('impressions')),
      costPerLpv: ratio(spend, tot('lpv')), costPerConv: ratio(spend, tot('conv')),
      avgDailySpend: ratio(spend, active.length),
      daily: rows,
      community: {
        joins, trials: t.trials, converted: t.converted, nonConverted: t.nonConverted, unresolved: t.unresolved, activeTrials: t.active,
        directPaid: cohort.filter(paidWithoutTrial).length,
        revenue: r2(sum(cohort.map((m) => m.d.revenue))), concurrentAds: concurrent,
      },
    };
  }).sort((a, b) => b.spend - a.spend);
}

/* ---------------------------------------------------------- profitability -- */

export function wilson(successes, n, z = 1.2816) {       // ~80% two-sided
  if (!n) return null;
  const p = successes / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { low: Math.max(0, centre - half), mid: p, high: Math.min(1, centre + half) };
}

export function profitability(ctx, from, to) {
  const p = periodSummary(ctx, from, to);
  const ret = retention(ctx);
  const paying = ctx.members.filter((m) => m.d.isPaying);
  const avgMargin = paying.length ? sum(paying.map((m) => m.d.monthlyNet)) / paying.length : null;
  const churn = ret.blendedMonthlyChurn;
  const lifetimeMonths = churn && churn > 0 ? 1 / churn : null;
  const cac = p.cohort.blendedCac;
  return {
    from, to,
    spend: p.activity.spend,
    trials: p.cohort.trials, converted: p.cohort.converted, unresolved: p.cohort.unresolved, activeTrials: p.cohort.active,
    directPaid: p.cohort.directPaid, newPaying: p.cohort.newPaying,
    blendedCostPerTrial: p.cohort.blendedCostPerTrial,
    blendedCac: cac,
    cohortRevenue: p.cohort.revenue,
    blendedRoas: p.cohort.blendedRoas,
    cashCollected: p.activity.revenue, netCash: p.activity.netCash, fees: p.activity.fees, otherExpenses: p.activity.otherExpenses,
    avgMonthlyMargin: avgMargin == null ? null : r2(avgMargin),
    cacPaybackMonths: cac != null && avgMargin ? cac / avgMargin : null,
    monthlyChurn: churn, churnBasisMonths: ret.churnBasisMonths,
    expectedLifetimeMonths: lifetimeMonths,
    estimatedLtv: lifetimeMonths && avgMargin ? r2(lifetimeMonths * avgMargin) : null,
    // No member carries ad-level attribution, so nothing here may be called
    // "verified CAC" or "ROAS" without the word blended in front of it.
    attributed: ctx.members.some((m) => m.attribution),
    fullyMatured: p.cohort.fullyMatured,
  };
}

/** The break-even calculator. Every output here is a forecast. */
export function breakEven(i) {
  const price = Number(i.price) || 0;
  const conv = Math.max(0, Math.min(1, Number(i.convRate) || 0));
  const cpt = Number(i.costPerTrial) || 0;
  const months = Number(i.retentionMonths) || 0;
  const margin = Math.max(0, price * (1 - (Number(i.platformPct) || 0) / 100) - (Number(i.perTransaction) || 0));
  const trials = cpt > 0 ? ((Number(i.dailyBudget) || 0) * 30.4375) / cpt : 0;
  const newPaying = trials * conv;
  const cac = conv > 0 ? cpt / conv : null;
  const ltv = margin * months;
  return {
    monthlySpend: r2((Number(i.dailyBudget) || 0) * 30.4375),
    trialsPerMonth: trials,
    newPayingPerMonth: newPaying,
    marginPerMonth: r2(margin),
    cac, ltv: r2(ltv),
    paybackMonths: cac != null && margin > 0 ? cac / margin : null,
    profitPerCustomer: cac != null ? r2(ltv - cac) : null,
    monthlyCohortProfit: cac != null ? r2(newPaying * (ltv - cac)) : null,
    breakEvenConvRate: ltv > 0 ? cpt / ltv : null,
    breakEvenCostPerTrial: r2(conv * ltv),
    steadyStateMrr: r2(newPaying * months * price),
    profitable: cac != null && ltv > cac,
  };
}

/** What the trials running right now might turn into. A forecast, labelled as one. */
export function forecast(ctx) {
  const all = trialStats(ctx.members);
  const active = ctx.members.filter((m) => m.d.trialOutcome === 'active');
  const band = wilson(all.converted, all.known);
  const ret = retention(ctx);
  const byPlan = new Map();
  for (const m of active) {
    const k = planLabel(ctx.settings, m);
    const p = byPlan.get(k) || { plan: k, trials: 0, monthly: m.d.monthly, price: m.price, interval: m.interval };
    p.trials++;
    byPlan.set(k, p);
  }
  const scen = (rate) => {
    if (rate == null) return null;
    let members = 0; let mrr = 0; let cash = 0;
    for (const p of byPlan.values()) { members += p.trials * rate; mrr += p.trials * rate * p.monthly; cash += p.trials * rate * (p.price || 0); }
    return { rate, members, grossMrr: r2(mrr), firstCharge: r2(cash) };
  };
  const notes = [];
  if (all.known < 30) notes.push(`Only ${all.known} trial${all.known === 1 ? '' : 's'} have a verified outcome. The range is wide because the sample is small.`);
  if (all.unresolved) notes.push(`${all.unresolved} matured trial${all.unresolved === 1 ? ' has' : 's have'} no verified outcome and ${all.unresolved === 1 ? 'is' : 'are'} excluded from the historical rate.`);
  if (!all.known) notes.push('No verified trial outcomes yet, so there is no historical rate to forecast from.');
  return {
    activeTrials: active.length, byPlan: [...byPlan.values()],
    sample: all.known, historicalRate: all.rate, coverage: all.coverage,
    conservative: band ? scen(band.low) : null,
    expected: band ? scen(band.mid) : null,
    optimistic: band ? scen(band.high) : null,
    monthlyChurn: ret.blendedMonthlyChurn,
    endingBy: active.map((m) => m.d.trialEnd).sort(),
    notes,
  };
}

/* -------------------------------------------------------------- insights -- */

const money = (n) => (n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 }));
const pct = (n, dp = 0) => (n == null ? '—' : `${(n * 100).toFixed(dp)}%`);
const signed = (n) => (n == null ? 'n/a' : Math.abs(n) < 0.5 ? 'flat' : `${n >= 0 ? 'up' : 'down'} ${Math.abs(n).toFixed(0)}%`);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * Rule-based observations. Each is labelled with what KIND of statement it is:
 *   fact         counted directly from verified records
 *   estimate     depends on a rule or an estimated date
 *   correlation  two things moved together; nothing here shows one caused the other
 *   missing      something that could not be answered, and why
 */
export function insights(ctx) {
  const out = [];
  const add = (kind, text) => out.push({ kind, text });
  const today = ctx.today;

  if (!ctx.members.length) add('missing', 'No membership data yet. Upload a Skool CSV in Data Reconciliation to begin.');
  if (!ctx.meta.available) add('missing', 'No Meta advertising history is stored yet, so spend cannot be compared with membership. Run a sync from the Meta Ads page.');
  if (!ctx.members.length || !ctx.meta.available) return out;

  // Week over week, on complete days only — today's spend is still arriving.
  const end = addDays(today, -1);
  const cur = periodSummary(ctx, addDays(end, -6), end);
  const prev = periodSummary(ctx, addDays(end, -13), addDays(end, -7));
  const dSpend = pctChange(cur.activity.spend, prev.activity.spend);
  const dTrials = pctChange(cur.activity.trialStarts, prev.activity.trialStarts);
  if (dSpend != null) {
    add('correlation', `Advertising spend is ${signed(dSpend)} on the previous week (${money(cur.activity.spend)} vs ${money(prev.activity.spend)}), while new trial signups are ${dTrials == null ? `${cur.activity.trialStarts} against none the week before` : signed(dTrials) + ` (${cur.activity.trialStarts} vs ${prev.activity.trialStarts})`}.`);
    if (dSpend >= 15 && dTrials != null && dTrials <= 0) add('correlation', 'Spend rose and trial signups did not. Signups are counted for the whole community, so this does not say which ad stopped working — only that the extra money did not coincide with extra joins.');
    if (dSpend <= -15 && dTrials != null && dTrials < 0) add('correlation', `Signups declined after overall advertising spending decreased (${signed(dSpend)} spend, ${signed(dTrials)} trial signups).`);
  }

  // The most recent weekly cohort old enough for every trial to have ended.
  const cs = cohorts(ctx, 'week').filter((c) => (c.trials > 0 || c.directPaid > 0) && c.active === 0 && diffDays(c.to, today) >= ctx.settings.trialDays);
  const last = cs[cs.length - 1];
  if (last) {
    add('fact', last.trials
      ? `The week of ${last.from} acquisition cohort generated ${plural(last.trials, 'trial')}, of which ${plural(last.converted, 'verified member')} became paying subscribers` +
        (last.unresolved ? `; ${last.unresolved} more have no verified outcome.` : '.') + (last.directPaid ? ` A further ${last.directPaid} joined as paying members with no trial.` : '')
      : `The week of ${last.from} predates the free trial: ${plural(last.directPaid, 'member')} joined as paying members with no trial.`);
    const before = cs[cs.length - 2];
    if (before && last.spend > before.spend * 1.15 && last.newPaying <= before.newPaying) {
      add('correlation', `Advertising spending increased from ${money(before.spend)} to ${money(last.spend)} between the weeks of ${before.from} and ${last.from}, but paying customer acquisition did not improve (${before.newPaying} then ${last.newPaying} verified new paying members).`);
    }
  }

  // Signups on days an ad was delivering against days it was not.
  const span = 90;
  const lo = maxDay(addDays(today, -span), ctx.meta.first);
  const base = dailySeries(ctx, lo, end);
  const joinsOn = new Map(base.days.map((d, i) => [d, base.metrics.joins[i]]));
  for (const ad of adEntities(ctx, 'ad', lo, end).slice(0, 8)) {
    const on = new Set(ad.daily.filter(delivered).map((r) => r.day));
    const onDays = base.days.filter((d) => on.has(d));
    const offDays = base.days.filter((d) => !on.has(d));
    if (onDays.length < 5 || offDays.length < 5) continue;
    const a = sum(onDays.map((d) => joinsOn.get(d))) / onDays.length;
    const b = sum(offDays.map((d) => joinsOn.get(d))) / offDays.length;
    if (b > 0 && Math.abs(a - b) / b >= 0.25) {
      add('correlation', `Member signups averaged ${a.toFixed(1)} a day while "${ad.name}" was delivering (${onDays.length} days) against ${b.toFixed(1)} a day when it was not (${offDays.length} days). Up to ${ad.community.concurrentAds} other ad${ad.community.concurrentAds === 1 ? ' was' : 's were'} delivering on the same days, so this is not attribution.`);
    }
  }

  // The largest sustained change in daily spend, and what joins did around it.
  let best = null;
  for (let i = 7; i + 7 <= base.days.length; i++) {
    const b4 = sum(base.metrics.spend.slice(i - 7, i)) / 7;
    const af = sum(base.metrics.spend.slice(i, i + 7)) / 7;
    if (b4 < 5) continue;
    const change = (af - b4) / b4;
    if (Math.abs(change) >= 0.3 && (!best || Math.abs(change) > Math.abs(best.change))) {
      best = { i, change, b4, af, jb: sum(base.metrics.joins.slice(i - 7, i)), ja: sum(base.metrics.joins.slice(i, i + 7)) };
    }
  }
  if (best) {
    add('correlation', `Average daily spend went from ${money(r2(best.b4))} to ${money(r2(best.af))} around ${base.days[best.i]}. The community recorded ${plural(best.jb, 'signup')} in the seven days before and ${best.ja} in the seven days after.`);
  }

  const all = periodSummary(ctx, minDay(ctx.meta.first, ctx.members.map((m) => m.joinDay).filter(Boolean).sort()[0] || today), today);
  add(all.activity.soft.revenue ? 'estimate' : 'fact',
    `Across all recorded history, ${money(all.activity.revenue)} has been collected against ${money(all.activity.spend)} of ad spend — ${all.activity.revenue >= all.activity.spend ? 'more in than out' : 'less in than out'} before fees.` +
    (all.activity.soft.revenue ? ' The total is Skool\'s recorded LTV; the dates individual payments landed on are estimated.' : ''));

  const t = trialStats(ctx.members);
  if (t.unresolved) add('missing', `${plural(t.unresolved, 'trial')} ended with no verified outcome. Paste the ended-trial and churned lists from Skool to resolve them; until then the conversion rate rests on ${pct(t.coverage)} of matured trials.`);
  return out;
}

/* ---------------------------------------------------------- data quality -- */

export function dataQuality(ctx) {
  const w = [];
  const add = (level, code, message) => w.push({ level, code, message });
  const count = (fn) => ctx.members.filter(fn).length;

  if (ctx.demo) add('info', 'demo', 'Demonstration data. Nothing on screen is real business data and nothing here is saved.');
  if (!ctx.lastCsv) add('warn', 'no_csv', 'No Skool CSV has been imported. Membership figures are empty or rest on pasted lists alone.');
  else {
    const age = diffDays(ctx.lastCsv.day, ctx.today);
    if (age > 7) add('warn', 'stale_csv', `The latest Skool export is ${age} days old (${ctx.lastCsv.day}). Anything after that date is not known yet.`);
    if (ctx.csvImports.length === 1) add('info', 'one_snapshot', 'Only one export has been imported. Departures, returns and payment dates can only be detected by comparing two or more.');
    // Somebody who joins and leaves between two exports is in neither. With a
    // short trial that is most of the people who did not convert, so sparse
    // exports flatter the conversion rate.
    let widest = 0; let widestAt = null;
    for (let i = 1; i < ctx.csvImports.length; i++) {
      const gap = diffDays(ctx.csvImports[i - 1].day, ctx.csvImports[i].day);
      if (gap > widest) { widest = gap; widestAt = ctx.csvImports[i - 1].day; }
    }
    if (widest > ctx.settings.trialDays) add('warn', 'export_gap', `Exports were up to ${widest} days apart (after ${widestAt}), longer than the ${ctx.settings.trialDays}-day trial. Anyone who joined and left inside a gap was never recorded, which makes conversion look better than it was. Export at least weekly.`);
  }
  if (!ctx.meta.available) add('warn', 'no_meta', 'Meta advertising history has not been synced.');
  else if (ctx.meta.last && diffDays(ctx.meta.last, ctx.today) > 2) add('warn', 'stale_meta', `Meta data ends on ${ctx.meta.last}. Run a sync.`);
  if (ctx.meta.account && ctx.meta.account.timezone && ctx.meta.account.timezone !== ctx.settings.timezone) {
    add('info', 'tz_mismatch', `Ad spend is reported in the ad account's timezone (${ctx.meta.account.timezone}); membership days use ${ctx.settings.timezone}. Days near midnight can land one apart.`);
  }

  const missing = count((m) => m.d.status === 'missing_unverified');
  if (missing) add('warn', 'missing', `${plural(missing, 'member')} missing from the latest export with no verified reason. Not counted as churned.`);
  const unresolved = count((m) => m.d.trialOutcome === 'unresolved');
  if (unresolved) add('warn', 'unresolved', `${plural(unresolved, 'trial')} ended without a verified payment or cancellation.`);
  const overdue = count((m) => m.d.flags.some((f) => f.code === 'payment_overdue'));
  const late = count((m) => m.d.flags.some((f) => f.code === 'cancel_overdue'));
  if (late) add('warn', 'cancel_overdue', `${plural(late, 'canceling member')} ${late === 1 ? 'is' : 'are'} past the date their access was due to end and still counted as paying. Upload the churned list to confirm who has left.`);
  const gone = count((m) => m.d.flags.some((f) => f.code === 'missing_after_cancel'));
  if (gone) add('warn', 'missing_after_cancel', `${plural(gone, 'member')} had asked to cancel and ${gone === 1 ? 'has' : 'have'} since disappeared from the export. Very likely churned — upload the churned list to confirm.`);
  if (overdue) add('warn', 'overdue', `${plural(overdue, 'paying member')} show no LTV movement for a payment that should have happened. Counted as paying until verified otherwise.`);
  const ahead = count((m) => m.d.flags.some((f) => f.code === 'ltv_ahead' || f.code === 'ltv_behind'));
  if (ahead) add('info', 'reconcile', `${plural(ahead, 'member')} have a recorded LTV that the current price and billing dates do not explain. See Revenue & MRR.`);
  const dupes = count((m) => m.possibleDuplicateOf && m.possibleDuplicateOf.length);
  if (dupes) add('warn', 'duplicates', `${plural(dupes, 'possible duplicate account')} need a decision in Data Reconciliation.`);
  const noSource = count((m) => !m.source || m.source === 'unknown');
  if (ctx.members.length && noSource / ctx.members.length > 0.5) add('info', 'sources', `${pct(noSource / ctx.members.length)} of members have no acquisition source on record.`);
  const estPaid = count((m) => m.d.firstPaidDay && m.d.firstPaidPrecision !== 'exact');
  if (estPaid) add('info', 'est_dates', `${plural(estPaid, 'conversion date')} are estimated from the billing date rather than a recorded payment.`);
  for (const x of ctx.state.warnings) w.push(x);
  return w;
}

/* ------------------------------------------------------------- overview -- */

export function overview(ctx, from, to, sel) {
  const cur = periodSummary(ctx, from, to, sel);
  const pr = previousRange(from, to);
  const prev = periodSummary(ctx, pr.from, pr.to, sel);
  const now = mrrAt(ctx, minDay(to, ctx.today));
  const then = mrrAt(ctx, addDays(from, -1));
  const count = (fn) => ctx.members.filter(fn).length;
  const t = trialStats(ctx.members);
  const ret = retention(ctx);
  const prof = profitability(ctx, from, to);
  let churnedMrr = 0;
  for (const m of ctx.members) for (const i of m.d.intervals) if (i.end && i.end >= from && i.end <= to) churnedMrr += m.d.monthly;
  return {
    range: { from, to }, previous: pr, cur, prev,
    members: {
      total: ctx.lastCsv ? count((m) => m.present === true) : ctx.members.length,
      totalBasis: ctx.lastCsv ? `Listed in the export of ${ctx.lastCsv.day}` : 'No export yet',
      activeTrials: t.active, paying: count((m) => m.d.isPaying), canceling: count((m) => m.d.status === 'canceling'),
      free: count((m) => m.d.status === 'free'),
      churned: count((m) => m.d.status === 'churned'),
      missing: count((m) => m.d.status === 'missing_unverified'),
      completedTrials: t.matured, returning: count((m) => m.d.returned),
    },
    trials: t,
    mrr: { gross: now.gross, net: now.net, payers: now.payers, grossBefore: then.gross, newMrr: cur.activity.newMrr, churnedMrr: r2(churnedMrr), atRisk: mrrAtRisk(ctx), canceling: mrrCanceling(ctx), byPlan: now.byPlan },
    retention: ret, profitability: prof,
  };
}

/* -------------------------------------------------------- weekly report -- */

/** The last complete Monday–Sunday week before `today`. */
export function lastCompleteWeek(today) {
  const thisMonday = weekStart(today);
  return { from: addDays(thisMonday, -7), to: addDays(thisMonday, -1) };
}

export function weeklyReport(ctx, range) {
  const wk = range || lastCompleteWeek(ctx.today);
  const o = overview(ctx, wk.from, wk.to);
  const a = o.cur.activity; const b = o.prev.activity;
  const ads = adEntities(ctx, 'ad', wk.from, wk.to).filter((x) => x.spend > 0);
  // Ranked on the best evidence each ad actually has: Meta's own conversion
  // count if it reported any, otherwise cost per landing-page view.
  const basis = ads.some((x) => x.conv > 0) ? 'costPerConv' : 'costPerLpv';
  const ranked = ads.filter((x) => x[basis] != null && x.spend >= 5).sort((x, y) => x[basis] - y[basis]);
  const delta = (k) => pctChange(a[k], b[k]);
  const rec = [];
  const t = o.trials;
  if (t.unresolved) rec.push(`Resolve ${plural(t.unresolved, 'ended trial')} by pasting the ended-trial and churned lists from Skool — the conversion rate currently rests on ${pct(t.coverage)} of matured trials.`);
  if (a.spend > 0 && a.trialStarts === 0) rec.push(`${money(a.spend)} was spent this week with no new trial recorded. Confirm the export is current before changing any budget.`);
  if (ranked.length >= 2) {
    const worst = ranked[ranked.length - 1]; const bestAd = ranked[0];
    if (worst[basis] > bestAd[basis] * 2) rec.push(`"${worst.name}" cost ${money(r2(worst[basis]))} per ${basis === 'costPerConv' ? 'Meta-reported conversion' : 'landing-page view'} against ${money(r2(bestAd[basis]))} for "${bestAd.name}". Consider shifting budget — this is Meta's reporting, not verified member attribution.`);
  }
  // Judged on cohorts whose trials have all ended. This week's own cohort is
  // still mid-trial, and its cost per customer would read far too high.
  const settled = cohorts(ctx, 'week').filter((c) => (c.trials > 0 || c.directPaid > 0) && c.active === 0 && c.to <= wk.to).slice(-4);
  const settledCac = ratio(sum(settled.map((c) => c.spend)), sum(settled.map((c) => c.newPaying)));
  if (settledCac != null && o.profitability.estimatedLtv != null) {
    const span = `the ${settled.length} most recent settled weekly cohort${settled.length === 1 ? '' : 's'}`;
    rec.push(settledCac < o.profitability.estimatedLtv
      ? `Blended CAC across ${span} (${money(r2(settledCac))}) is below estimated lifetime margin per customer (${money(o.profitability.estimatedLtv)}). The evidence supports holding or cautiously raising spend.`
      : `Blended CAC across ${span} (${money(r2(settledCac))}) is above estimated lifetime margin per customer (${money(o.profitability.estimatedLtv)}). Hold budget increases until conversion or retention improves.`);
  } else rec.push('There is not yet enough verified conversion and churn history to compare acquisition cost with lifetime value. Keep importing weekly exports.');
  if (!o.cur.cohort.fullyMatured) rec.push(`${plural(o.cur.cohort.active, 'trial')} from this week ${o.cur.cohort.active === 1 ? 'is' : 'are'} still running, so this cohort's conversion figures are not final.`);

  return {
    title: 'Peps by Dave — weekly performance report',
    range: wk, previous: o.previous, generatedFor: ctx.today, demo: ctx.demo,
    rows: [
      ['Total advertising spend', money(a.spend), money(b.spend), delta('spend')],
      ['New members acquired', a.joins, b.joins, delta('joins')],
      ['Free trials started', a.trialStarts, b.trialStarts, delta('trialStarts')],
      ['Free trial cancellations', a.trialCancels, b.trialCancels, delta('trialCancels')],
      ['Trial-to-paid conversions (verified)', a.conversions, b.conversions, delta('conversions')],
      ['New paying members with no trial', a.directPaid, b.directPaid, delta('directPaid')],
      ['Cancellations requested (still members)', a.cancelRequests, b.cancelRequests, delta('cancelRequests')],
      ['Paid member churn (left the community)', a.churn, b.churn, delta('churn')],
      ['Returning members', a.returns, b.returns, delta('returns')],
      ['Revenue collected', money(a.revenue), money(b.revenue), delta('revenue')],
      ['Net cash contribution', money(a.netCash), money(b.netCash), null],
    ],
    mrr: o.mrr,
    cohort: o.cur.cohort,
    ads: { basis: basis === 'costPerConv' ? 'cost per Meta-reported conversion' : 'cost per landing-page view', best: ranked[0] || null, worst: ranked.length > 1 ? ranked[ranked.length - 1] : null, all: ads },
    insights: insights(ctx),
    recommendations: rec,
    quality: dataQuality(ctx),
  };
}

/** The weekly report as plain text, for email. */
export function reportText(rep) {
  const L = [];
  L.push(rep.title, `${rep.range.from} to ${rep.range.to}  (previous: ${rep.previous.from} to ${rep.previous.to})`, '');
  if (rep.demo) L.push('*** DEMONSTRATION DATA — NOT REAL BUSINESS DATA ***', '');
  for (const [label, cur, prev, d] of rep.rows) L.push(`${label}: ${cur}  (previous ${prev}${d == null ? '' : `, ${d >= 0 ? '+' : ''}${d.toFixed(0)}%`})`);
  L.push('', `Gross MRR: ${money(rep.mrr.gross)}  |  Net MRR: ${money(rep.mrr.net)}  |  New MRR: ${money(rep.mrr.newMrr)}  |  Churned MRR: ${money(rep.mrr.churnedMrr)}`);
  L.push('', `This week's joining cohort: ${rep.cohort.joined} joined, ${rep.cohort.trials} trials, ${rep.cohort.converted} of them verified paying, ${rep.cohort.directPaid} paying with no trial, ${rep.cohort.nonConverted} canceled or declined, ${rep.cohort.unresolved} unresolved, ${rep.cohort.active} still on trial.`);
  if (rep.ads.best) L.push('', `Best ad by ${rep.ads.basis}: ${rep.ads.best.name} (${money(rep.ads.best.spend)} spent).`);
  if (rep.ads.worst) L.push(`Weakest ad by ${rep.ads.basis}: ${rep.ads.worst.name} (${money(rep.ads.worst.spend)} spent).`);
  L.push('', 'ADVERTISING VS MEMBER GROWTH');
  for (const i of rep.insights) L.push(`- [${i.kind}] ${i.text}`);
  L.push('', 'RECOMMENDATIONS');
  for (const r of rep.recommendations) L.push(`- ${r}`);
  if (rep.quality.length) { L.push('', 'DATA QUALITY'); for (const q of rep.quality) L.push(`- ${q.message}`); }
  return L.join('\n');
}

/* --------------------------------------------------------------- digest -- */

/**
 * Everything the AI analyst is allowed to know, as one compact object.
 *
 * It is built here rather than in the endpoint so the model can only ever be
 * handed figures this engine computed — and every figure that is an estimate,
 * a window or a blend arrives already labelled as one.
 */
export function buildDigest(ctx) {
  const today = ctx.today;
  const firstJoin = ctx.members.map((m) => m.joinDay).filter(Boolean).sort()[0] || today;
  const start = minDay(ctx.meta.first, firstJoin) || today;
  const from = maxDay(start, addDays(today, -179));
  const s = dailySeries(ctx, from, today);
  const o = overview(ctx, addDays(today, -29), today);
  const count = {};
  for (const m of ctx.members) count[m.d.status] = (count[m.d.status] || 0) + 1;
  return {
    asOf: today, timezone: ctx.settings.timezone, demoData: ctx.demo,
    business: { trialDays: ctx.settings.trialDays, trialOfferBeganOn: ctx.settings.trialAppliesFrom, trialNote: 'Paid members who joined before trialOfferBeganOn never had a trial. They are paying members, not trial conversions, and are excluded from every trial count and conversion rate.', plans: ctx.settings.plans.map((p) => ({ label: p.label, price: p.price, interval: p.interval })), fees: ctx.settings.fees },
    dataCoverage: {
      latestSkoolExport: ctx.lastCsv ? ctx.lastCsv.day : null, exportsImported: ctx.csvImports.length,
      metaFirstDay: ctx.meta.first, metaLastDay: ctx.meta.last, adAccountTimezone: ctx.meta.account ? ctx.meta.account.timezone : null,
      warnings: dataQuality(ctx).map((w) => w.message),
    },
    membersByStatus: count,
    trials: trialStats(ctx.members),
    mrr: o.mrr,
    retention: { r30: o.retention.r30, r60: o.retention.r60, r90: o.retention.r90, blendedMonthlyChurn: o.retention.blendedMonthlyChurn, months: o.retention.months.slice(-6) },
    last30Days: { activity: o.cur.activity, joiningCohort: o.cur.cohort, previous30Days: o.prev.activity },
    weeklyCohortsByJoinWeek: cohorts(ctx, 'week').slice(-16).map((c) => ({
      week: c.from, joined: c.joined, trials: c.trials, trialsConvertedToPaid: c.converted, paidWithNoTrial: c.directPaid, newPayingTotal: c.newPaying, canceledOrDeclined: c.nonConverted, unresolved: c.unresolved,
      stillOnTrial: c.active, churnedLater: c.churned, returned: c.returned, revenueSoFar: c.revenue, adSpendThatWeek: c.spend,
      blendedCostPerTrial: c.blendedCostPerTrial, blendedCac: c.blendedCac,
    })),
    ads: adEntities(ctx, 'ad').slice(0, 25).map((a) => ({
      name: a.name, campaign: a.campaign, adset: a.adset, status: a.status, firstDeliveryDay: a.firstDay, lastDeliveryDay: a.lastDay, daysActive: a.daysActive,
      pauses: a.pauses, runs: a.runs.map((r) => `${r.from}..${r.to}`), spend: a.spend, clicks: a.clicks, landingPageViews: a.lpv, metaReportedConversions: a.conv,
      cpc: a.cpc, costPerLandingPageView: a.costPerLpv,
      communityDuringActiveDays: { note: 'whole-community figures on days this ad delivered; NOT attribution', ...a.community },
    })),
    daily: {
      columns: ['day', 'adSpend', 'joins', 'trialStarts', 'trialCancels', 'trialToPaidConversions', 'newPayingNoTrial', 'cancellationsRequested', 'paidChurn', 'returns', 'revenueCollected'],
      note: 'trialToPaidConversions and revenueCollected days are often estimated from the trial end date; joins are exact. newPayingNoTrial are members who paid to join without a trial (before the trial offer began).',
      rows: s.days.map((d, i) => [d, s.metrics.spend[i], s.metrics.joins[i], s.metrics.trialStarts[i], s.metrics.trialCancels[i], s.metrics.conversions[i], s.metrics.directPaid[i], s.metrics.cancelRequests[i], s.metrics.churn[i], s.metrics.returns[i], s.metrics.revenue[i]]),
    },
    forecast: forecast(ctx),
    ruleBasedInsights: insights(ctx),
  };
}

/* ------------------------------------------------------- import preview -- */

/**
 * What saving this import would change — computed by actually replaying with
 * it and reading back the events it produced, so the preview cannot disagree
 * with what gets saved.
 */
export function previewImport(db, imports, candidate, opts = {}) {
  const dbWith = { ...db, imports: [...(db.imports || []).filter((i) => i.id !== candidate.id), { id: candidate.id, kind: candidate.kind, observedAt: candidate.observedAt }] };
  const after = buildState(dbWith, [...imports.filter((i) => i.id !== candidate.id), candidate], opts);
  const before = buildState(db, imports.filter((i) => i.id !== candidate.id), opts);
  const mine = (type) => {
    const list = [];
    for (const m of after.members) for (const e of m.events) if (e.importId === candidate.id && e.type === type) list.push({ member: m, event: e });
    return list;
  };
  const log = after.matchLog[candidate.id] || [];
  const dupHash = (db.imports || []).find((i) => i.hash && i.hash === candidate.hash && !i.reverted && i.id !== candidate.id);
  const prevCsv = before.lastCsv;
  const notes = [];
  if (dupHash) notes.push({ level: 'warn', message: `This exact content was already imported on ${String(dupHash.observedAt).slice(0, 10)}${dupHash.filename ? ` (${dupHash.filename})` : ''}. Saving it again adds nothing.` });
  if (candidate.kind === 'csv' && prevCsv && candidate.rows.length < prevCsv.rows * 0.5) {
    notes.push({ level: 'warn', message: `This file has ${candidate.rows.length} rows; the previous export had ${prevCsv.rows}. If it is a partial or filtered export, everyone it leaves out will be marked missing.` });
  }
  if (candidate.kind === 'csv' && prevCsv && candidate.observedAt < prevCsv.at) {
    notes.push({ level: 'info', message: 'This export is dated before the latest one already imported. It will be slotted into history at its own date.' });
  }
  return {
    duplicateOf: dupHash || null, notes,
    matched: log.filter((l) => !l.created).length,
    newMembers: log.filter((l) => l.created && !l.uncertain).map((l) => after.byId.get(l.memberId)),
    uncertain: log.filter((l) => l.uncertain).map((l) => ({ k: l.k, name: l.name, candidates: l.candidates.map((id) => after.byId.get(id) || before.byId.get(id)).filter(Boolean) })),
    nameMatched: log.filter((l) => l.how === 'name + join date').map((l) => ({ k: l.k, name: l.name, member: after.byId.get(l.memberId) })),
    missing: mine('missing_from_export'),
    returning: [...mine('returned'), ...mine('rejoined')],
    priceChanges: mine('price_changed'),
    ltvChanges: [...mine('payment_observed'), ...mine('refund_observed')],
    trialUpdates: [...mine('trial_started'), ...mine('trial_ended'), ...mine('paid_verified')],
    cancellations: [...mine('trial_canceled'), ...mine('trial_declined')],
    canceling: mine('cancel_scheduled'),
    churned: mine('churned'),
    statusChanges: after.members.filter((m) => { const b = before.byId.get(m.id); return b && b.d.status !== m.d.status; })
      .map((m) => ({ member: m, from: before.byId.get(m.id).d.statusLabel, to: m.d.statusLabel })),
    totals: { before: before.members.length, after: after.members.length },
  };
}

/**
 * Everything the Report tab's model is given, for one chosen period.
 *
 * Same contract as buildDigest: only figures this engine computed, each
 * already labelled, and no member names or emails.
 */
export function buildReportDigest(ctx, from, to) {
  const o = overview(ctx, from, to);
  const a = o.cur.activity; const b = o.prev.activity;
  const days = o.cur.days;
  const adSide = (x, n) => ({
    spend: x.spend, averageDailySpend: r2(x.spend / n), impressions: x.impressions, clicks: x.clicks, landingPageViews: x.lpv,
    ctrPercent: x.ctr, costPerClick: x.cpc, cpm: x.cpm, costPerLandingPageView: x.costPerLpv, metaReportedConversions: x.metaConv,
  });
  const memberSide = (x) => ({
    newSignups: x.joins, freeTrialsStarted: x.trialStarts, trialCancellations: x.trialCancels,
    trialToPaidConversions: x.conversions, newPayingWithNoTrial: x.directPaid, newPayingTotal: x.newPaying,
    cancellationsRequestedStillMembers: x.cancelRequests, paidMembersChurned: x.churn, returningMembers: x.returns,
    wentMissingUnverified: x.missing, netMemberGrowth: x.net,
  });
  const moneySide = (x) => ({
    revenueCollected: x.revenue, fees: x.fees, adSpend: x.spend, otherExpenses: x.otherExpenses, netCashContribution: x.netCash, newMrr: x.newMrr,
  });
  const { series, ...curRest } = o.cur;
  const count = {};
  for (const m of ctx.members) count[m.d.status] = (count[m.d.status] || 0) + 1;
  const s = series;
  return {
    kind: 'period_report',
    asOf: ctx.today, timezone: ctx.settings.timezone, demoData: ctx.demo,
    period: { from, to, days }, previousPeriod: o.previous,
    business: {
      trialDays: ctx.settings.trialDays, trialOfferBeganOn: ctx.settings.trialAppliesFrom,
      trialNote: 'Paid members who joined before trialOfferBeganOn never had a trial. They are paying members, not trial conversions.',
      plans: ctx.settings.plans.map((p) => ({ label: p.label, price: p.price, interval: p.interval })), fees: ctx.settings.fees,
    },
    dataCoverage: {
      latestSkoolExport: ctx.lastCsv ? ctx.lastCsv.day : null, exportsImported: ctx.csvImports.length,
      metaFirstDay: ctx.meta.first, metaLastDay: ctx.meta.last, adAccountTimezone: ctx.meta.account ? ctx.meta.account.timezone : null,
      warnings: dataQuality(ctx).map((w) => w.message),
      softDates: { note: 'How many events in the period are dated by estimate or by the day they were observed, not an exact date.', ...a.soft },
    },
    advertising: {
      period: adSide(a, days), previousPeriod: adSide(b, days),
      ads: adEntities(ctx, 'ad', from, to).filter((x) => x.daysActive > 0).slice(0, 25).map((x) => ({
        name: x.name, campaign: x.campaign, adset: x.adset, status: x.status, daysDeliveringInPeriod: x.daysActive, pausesInPeriod: x.pauses,
        runsInPeriod: x.runs.map((r) => `${r.from}..${r.to}`), spend: x.spend, clicks: x.clicks, landingPageViews: x.lpv,
        costPerClick: x.cpc, costPerLandingPageView: x.costPerLpv, metaReportedConversions: x.conv, costPerMetaConversion: x.costPerConv,
        communityOnDeliveryDays: { note: 'whole-community figures on days this ad delivered; NOT attribution', signups: x.community.joins, concurrentAds: x.community.concurrentAds },
      })),
    },
    membership: {
      period: memberSide(a), previousPeriod: memberSide(b),
      now: o.members, membersByStatusNow: count,
    },
    membersByStatus: count,
    joiningCohort: { note: 'What became of the people who JOINED in the period, to date. Blended figures divide all ad spend in the period by everyone who joined in it, from any source.', ...curRest.cohort },
    money: {
      period: moneySide(a), previousPeriod: moneySide(b),
      mrr: {
        grossNow: o.mrr.gross, netNow: o.mrr.net, grossAtPeriodStart: o.mrr.grossBefore, payingMembersNow: o.mrr.payers,
        newInPeriod: o.mrr.newMrr, churnedInPeriod: o.mrr.churnedMrr,
        scheduledToEndFromCancelingMembers: o.mrr.canceling, unverifiedAtRiskFromMissingMembers: o.mrr.atRisk, byPlan: o.mrr.byPlan,
      },
    },
    profitability: { note: 'blendedCac and blendedRoas are account-wide, never per-ad. estimatedLtv is margin per paying member times expected lifetime.', ...o.profitability },
    settledCohorts: {
      note: 'The most recent weekly joining cohorts whose trials have all finished — the reliable basis for acquisition cost.',
      weeks: cohorts(ctx, 'week').filter((c) => (c.trials > 0 || c.directPaid > 0) && c.active === 0).slice(-6).map((c) => ({
        week: c.from, adSpend: c.spend, joined: c.joined, trials: c.trials, trialsConvertedToPaid: c.converted, paidWithNoTrial: c.directPaid,
        newPayingTotal: c.newPaying, unresolved: c.unresolved, blendedCac: c.blendedCac, revenueSoFar: c.revenue,
      })),
    },
    trialsAllTime: o.trials,
    retention: { r30: o.retention.r30, r60: o.retention.r60, r90: o.retention.r90, blendedMonthlyChurn: o.retention.blendedMonthlyChurn, canceling: o.retention.canceling, paidChurned: o.retention.paidChurned },
    forecast: forecast(ctx),
    daily: {
      columns: ['day', 'adSpend', 'signups', 'trialStarts', 'trialCancels', 'trialToPaid', 'newPayingNoTrial', 'cancellationsRequested', 'paidChurn', 'revenueCollected'],
      rows: s.days.length <= 120 ? s.days.map((d, i) => [d, s.metrics.spend[i], s.metrics.joins[i], s.metrics.trialStarts[i], s.metrics.trialCancels[i], s.metrics.conversions[i], s.metrics.directPaid[i], s.metrics.cancelRequests[i], s.metrics.churn[i], s.metrics.revenue[i]]) : 'omitted: period longer than 120 days',
    },
    ruleBasedInsights: insights(ctx),
  };
}

export const format = { money, pct, signed, plural };
