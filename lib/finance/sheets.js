// Google Sheets, as the finances page's manual half.
//
// The sheet is the system of record for anything that cannot be fetched: Skool
// MRR, subscriptions, anything added later. The dashboard writes the live Meta
// figures into a server-owned tab and reads the hand-entered ones back out, so
// there is exactly one place to type a number and it is a spreadsheet — which
// is where a small business's figures already live.
//
// Two tabs, and the split is the whole contract:
//
//   Live     — overwritten on every sync. Never type in it; the next refresh
//              discards whatever was there.
//   Entered  — never written after it is first created. Type here.
//
// Auth is a Google service account. There is no SDK: minting a JWT is one
// crypto.sign call and the REST API is three endpoints, which is a smaller
// surface than a dependency that has to be pinned, audited and updated.

import crypto from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

export const LIVE_TAB = 'Live';
export const ENTERED_TAB = 'Entered';

/**
 * Read the sheet credentials out of the environment.
 *
 * Returns `null` when the sheet is not set up, which is a supported state, not
 * an error — the page falls back to its own table until someone connects one.
 */
export function sheetsConfig(env = process.env) {
  const spreadsheetId = String(env.FINANCE_SHEET_ID || '').trim();
  const clientEmail = String(env.GOOGLE_SHEETS_CLIENT_EMAIL || '').trim();
  let privateKey = String(env.GOOGLE_SHEETS_PRIVATE_KEY || '').trim();

  // Some dashboards wrap the whole value in quotes.
  if (/^".*"$/s.test(privateKey)) privateKey = privateKey.slice(1, -1);
  // A PEM pasted into a dashboard env var usually arrives with its newlines
  // escaped. Both forms have to work or setup fails with an opaque crypto error.
  // Trimmed AFTER unescaping, so a trailing \n does not survive as whitespace.
  privateKey = privateKey.replace(/\\n/g, '\n').trim();

  if (!spreadsheetId || !clientEmail || !privateKey) return null;
  return { spreadsheetId, clientEmail, privateKey };
}

/** Which of the three variables are missing, for a setup message. */
export function missingSheetEnv(env = process.env) {
  return ['FINANCE_SHEET_ID', 'GOOGLE_SHEETS_CLIENT_EMAIL', 'GOOGLE_SHEETS_PRIVATE_KEY']
    .filter((n) => !String(env[n] || '').trim());
}

/** The URL that embeds the sheet in an iframe, editable in place. */
export function embedUrl(spreadsheetId) {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit?embedded=true`;
}

/** The URL that opens the real Google Sheets editor in its own tab. */
export function openUrl(spreadsheetId) {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit`;
}

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* A token lasts an hour and a warm function may serve many requests in that
   time, so it is cached rather than re-minted per call. Keyed by the account
   email so a credential rotation cannot serve the old token. */
let tokenCache = null;

export async function accessToken(cfg, now = Date.now()) {
  if (tokenCache && tokenCache.key === cfg.clientEmail && tokenCache.expires > now + 60_000) {
    return tokenCache.token;
  }

  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: cfg.clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat,
    exp: iat + 3600,
  }));

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${b64url(signer.sign(cfg.privateKey))}`;

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.access_token) {
    throw new Error(googleMessage(json, resp.status, 'Google refused the service account credentials'));
  }

  tokenCache = {
    key: cfg.clientEmail,
    token: json.access_token,
    expires: now + (Number(json.expires_in) || 3600) * 1000,
  };
  return json.access_token;
}

/** Google's errors nest differently per endpoint; this finds the sentence. */
function googleMessage(json, status, fallback) {
  const m = json?.error?.message || json?.error_description || json?.error;
  return typeof m === 'string' && m ? m : `${fallback} (HTTP ${status}).`;
}

async function api(cfg, path, init = {}) {
  const token = await accessToken(cfg);
  const resp = await fetch(`${SHEETS}/${encodeURIComponent(cfg.spreadsheetId)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(googleMessage(json, resp.status, 'Google Sheets refused the request'));
  return json;
}

/** Tab names that already exist in the spreadsheet. */
export async function tabNames(cfg) {
  const meta = await api(cfg, '?fields=sheets.properties.title');
  return (meta.sheets || []).map((s) => s.properties?.title).filter(Boolean);
}

export async function addTab(cfg, title) {
  return api(cfg, ':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
  });
}

export async function readRange(cfg, range) {
  const json = await api(cfg, `/values/${encodeURIComponent(range)}`);
  return json.values || [];
}

export async function writeRange(cfg, range, values) {
  return api(cfg, `/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    body: JSON.stringify({ values }),
  });
}

export async function clearRange(cfg, range) {
  return api(cfg, `/values/${encodeURIComponent(range)}:clear`, { method: 'POST' });
}

/**
 * Parse a cell that is meant to hold money.
 *
 * A spreadsheet will hand back "$1,200.00", "1200", "1,200 " or an actual
 * number depending on how it was typed and formatted. All of those mean the
 * same thing and none of them should read as zero.
 */
export function parseAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const cleaned = String(v ?? '').replace(/[^0-9.\-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Read the hand-entered rows.
 *
 * Rows are found by their Type column rather than by position, so inserting,
 * deleting or reordering rows in the sheet cannot silently move a figure into
 * the wrong side of the ledger.
 */
export async function readEntered(cfg) {
  const rows = await readRange(cfg, `${ENTERED_TAB}!A2:D400`);
  const revenue = [];
  const expenses = [];

  rows.forEach((r, i) => {
    const type = String(r[0] || '').trim().toLowerCase();
    const label = String(r[1] || '').trim();
    if (!label || !type) return;            // blank spacer rows are fine
    const line = {
      id: `sheet-${i}`,
      label,
      amount: parseAmount(r[2]),
      note: String(r[3] || '').trim(),
      source: 'manual',
    };
    if (type.startsWith('rev')) revenue.push(line);
    else if (type.startsWith('exp')) expenses.push(line);
    // Anything else is a typo in the Type column; skipping it is better than
    // guessing which side of the ledger it belongs on.
  });

  return { revenue, expenses };
}

/** The header and seed rows written when the Entered tab is first created. */
export function seedEnteredRows(manual) {
  const rows = [
    ['Type', 'Line', 'Monthly', 'Note'],
    ['Revenue', 'Skool community', manual.skoolMrr || '',
      'Monthly recurring revenue. Skool has no API, so type it here.'],
  ];
  for (const c of manual.recurringCosts) rows.push(['Expense', c.label, c.amount, c.note || '']);
  for (const r of manual.otherRevenue) rows.push(['Revenue', r.label, r.amount, r.note || '']);
  rows.push(['', '', '', '']);
  rows.push(['', 'Add rows below. Type must be Revenue or Expense.', '', '']);
  return rows;
}

/** Everything the dashboard pushes into the server-owned tab. */
export function liveRows(payload) {
  const a = payload.adSpend;
  const rows = [
    ['Peps by Dave — live figures'],
    ['Written by the dashboard on every refresh. Do not edit; edits are overwritten.'],
    ['Last synced', payload.fetchedAt],
    ['Ad account timezone', a.timeZone || 'unknown'],
    [],
    ['Meta ad spend this month', ''],
    ['Already spent (month to date)', a.monthToDate],
    ['Active daily budget', a.dailyTotal],
    ['Days left in the month', a.daysRemaining],
    ['Projected for the rest of the month', a.projectedRemainder],
    ['Expected month total', a.expectedMonthTotal],
    [],
    ['Campaign / ad set', 'Level', 'Status', 'Daily budget', 'Spent so far', 'Projected month total'],
  ];
  for (const l of a.lines) {
    rows.push([
      l.name,
      l.level,
      l.live ? 'active' : String(l.status || '').toLowerCase().replace(/_/g, ' '),
      l.daily || '',
      l.spent || 0,
      l.expected || 0,
    ]);
  }
  return rows;
}

/**
 * Push the live figures in and read the entered ones back.
 *
 * Both tabs are created on first run, so setup is: make a blank spreadsheet,
 * share it with the service account, paste its id into FINANCE_SHEET_ID.
 */
export async function syncSheet(cfg, payload, manual) {
  const existing = await tabNames(cfg);

  if (!existing.includes(ENTERED_TAB)) {
    await addTab(cfg, ENTERED_TAB);
    // Seeded once, then never touched again — this tab belongs to the user.
    await writeRange(cfg, `${ENTERED_TAB}!A1`, seedEnteredRows(manual));
  }
  if (!existing.includes(LIVE_TAB)) await addTab(cfg, LIVE_TAB);

  const rows = liveRows(payload);
  // Cleared first: a shorter run than last time would otherwise leave the tail
  // of the previous sync sitting under the new figures, looking current.
  await clearRange(cfg, `${LIVE_TAB}!A1:Z400`);
  await writeRange(cfg, `${LIVE_TAB}!A1`, rows);

  return readEntered(cfg);
}
