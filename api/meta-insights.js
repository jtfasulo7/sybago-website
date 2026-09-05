// Meta Ads Insights proxy for the internal dashboard.
//
// SECURITY CONTRACT
//   - META_ADS_TOKEN is read from the environment and used only here. It is
//     never placed in a response body, a header, a redirect, or an error
//     message, so it cannot reach the browser under any code path.
//   - Every request must carry a valid session cookie (see lib/auth.js).
//   - Responses are marked private/no-store: this data is per-user and behind a
//     login, and must not be cached in Vercel's shared edge cache.
//
// GET /api/meta-insights?level=campaign&since=YYYY-MM-DD&until=YYYY-MM-DD

import { requireSession, noStore } from '../lib/auth.js';

// Meta ships a new Graph API version roughly quarterly and retires old ones
// after about two years. This is the one value likely to need bumping over the
// life of the dashboard, so it is configurable — and unsupported-version errors
// are detected explicitly below and reported in plain language.
const API_VERSION = process.env.META_API_VERSION || 'v23.0';

const LEVELS = new Set(['account', 'campaign', 'adset', 'ad']);

const BASE_FIELDS = [
  'spend',
  'impressions',
  'reach',
  'frequency',
  'clicks',
  'inline_link_clicks',
  'ctr',
  'cpc',
  'cpm',
  'actions',
  'action_values',
  'cost_per_action_type',
  'date_start',
  'date_stop',
];

const LEVEL_FIELDS = {
  account: [],
  campaign: ['campaign_id', 'campaign_name'],
  adset: ['campaign_name', 'adset_id', 'adset_name'],
  ad: ['campaign_name', 'adset_name', 'ad_id', 'ad_name'],
};

// Ordered by how strongly each represents a real outcome. The first type
// present wins as the headline "result".
const RESULT_PRIORITY = [
  'offsite_conversion.fb_pixel_complete_registration',
  'complete_registration',
  'offsite_conversion.fb_pixel_lead',
  'lead',
  'onsite_conversion.lead_grouped',
  'offsite_conversion.fb_pixel_purchase',
  'purchase',
  'offsite_conversion.fb_pixel_custom',
  'subscribe',
];

// Not outcomes, but the useful fallback when no pixel is reporting.
const PROXY_TYPES = ['landing_page_view', 'link_click'];

/* ----------------------------------------------------------------- errors */

/**
 * Translate a Meta error payload into something actionable. The point is that a
 * dead token and a missing permission and a bad account id should not all
 * surface as "request failed".
 */
function classifyMetaError(err, status) {
  const code = err?.code;
  const sub = err?.error_subcode;
  const msg = err?.message || 'Unknown error from Meta.';

  if (code === 190) {
    if (sub === 463) {
      return { http: 401, error: 'token_expired', message: 'The Meta access token has expired. Generate a new System User token and update META_ADS_TOKEN.', metaMessage: msg };
    }
    if (sub === 467) {
      return { http: 401, error: 'token_invalidated', message: 'The Meta access token was invalidated (password change, or the token was revoked). Generate a new one and update META_ADS_TOKEN.', metaMessage: msg };
    }
    return { http: 401, error: 'token_invalid', message: 'Meta rejected the access token. Check that META_ADS_TOKEN is the System User token and was copied in full.', metaMessage: msg };
  }

  if (code === 200 || code === 10 || code === 294) {
    return { http: 403, error: 'insufficient_permission', message: 'The token is valid but lacks permission. Confirm the System User has the ads_read scope AND has been assigned this ad account with View Performance in Business Settings.', metaMessage: msg };
  }

  if (code === 17 || code === 4 || code === 32 || code === 613 || (code >= 80000 && code <= 80014)) {
    return { http: 429, error: 'rate_limited', message: 'Meta is rate limiting this ad account. The dashboard retried with backoff and still could not get through. Wait a few minutes.', metaMessage: msg };
  }

  if (code === 100) {
    if (/unsupported get request|does not exist|cannot be loaded/i.test(msg)) {
      return { http: 400, error: 'account_not_found', message: `Meta could not load this ad account. Check META_AD_ACCOUNT_ID is correct and prefixed with "act_", and that the System User has been assigned it.`, metaMessage: msg };
    }
    if (/version/i.test(msg)) {
      return { http: 400, error: 'api_version_unsupported', message: `Graph API ${API_VERSION} was rejected. Set META_API_VERSION in the Vercel environment to a currently supported version.`, metaMessage: msg };
    }
    return { http: 400, error: 'bad_request', message: 'Meta rejected the query parameters.', metaMessage: msg };
  }

  return { http: status >= 400 ? status : 502, error: 'meta_error', message: 'Meta returned an error.', metaMessage: msg };
}

/* ------------------------------------------------------------- fetching */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch with exponential backoff and jitter. Retries only on conditions that
 * can plausibly succeed later: transport failures, 5xx, 429, and Meta's own
 * throttling codes. A bad token is never retried — it will never succeed.
 */
async function fetchWithBackoff(url, { retries = 3 } = {}) {
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(8000, 500 * 2 ** (attempt - 1));
      await sleep(backoff + Math.random() * 250); // jitter
    }

    let resp;
    try {
      resp = await fetch(url, { headers: { Accept: 'application/json' } });
    } catch (e) {
      // Deliberately NOT interpolating e.message here. A fetch failure can
      // carry the request URL in its message or cause, and that URL contains
      // access_token. Generic text only.
      lastErr = {
        http: 502,
        error: 'network_error',
        message: 'Could not reach the Meta API. This is usually transient — try refreshing.',
      };
      continue;
    }

    let json = null;
    try {
      json = await resp.json();
    } catch {
      json = null;
    }

    if (resp.ok && json && !json.error) {
      return { json, usage: resp.headers.get('x-business-use-case-usage') };
    }

    const classified = classifyMetaError(json?.error, resp.status);
    lastErr = classified;

    const retryable =
      classified.error === 'rate_limited' || resp.status === 429 || resp.status >= 500;
    if (!retryable) break;
  }

  throw Object.assign(new Error(lastErr?.message || 'Meta request failed'), lastErr);
}

function buildUrl(accountId, params) {
  const u = new URL(`https://graph.facebook.com/${API_VERSION}/${accountId}/insights`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  // Appended last and never logged.
  u.searchParams.set('access_token', process.env.META_ADS_TOKEN);
  return u.toString();
}

/* --------------------------------------------------------------- shaping */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function pickResult(actions, costPer, actionValues) {
  const byType = new Map((actions || []).map((a) => [a.action_type, num(a.value)]));
  const costByType = new Map((costPer || []).map((a) => [a.action_type, num(a.value)]));
  const valueByType = new Map((actionValues || []).map((a) => [a.action_type, num(a.value)]));

  for (const t of RESULT_PRIORITY) {
    if (byType.has(t)) {
      return {
        actionType: t,
        isConversion: true,
        count: byType.get(t),
        costPer: costByType.get(t) ?? null,
        value: valueByType.get(t) ?? null,
      };
    }
  }
  for (const t of PROXY_TYPES) {
    if (byType.has(t)) {
      return {
        actionType: t,
        isConversion: false,
        count: byType.get(t),
        costPer: costByType.get(t) ?? null,
        value: valueByType.get(t) ?? null,
      };
    }
  }
  return { actionType: null, isConversion: false, count: null, costPer: null, value: null };
}

function shapeRow(r, level) {
  const result = pickResult(r.actions, r.cost_per_action_type, r.action_values);
  const spend = num(r.spend);
  return {
    id: r.ad_id || r.adset_id || r.campaign_id || 'account',
    campaign: r.campaign_name || null,
    adset: r.adset_name || null,
    ad: r.ad_name || null,
    name: r.ad_name || r.adset_name || r.campaign_name || 'Account total',
    spend,
    impressions: num(r.impressions),
    reach: num(r.reach),
    frequency: num(r.frequency),
    clicks: num(r.clicks),
    linkClicks: num(r.inline_link_clicks),
    ctr: num(r.ctr),
    cpc: num(r.cpc),
    cpm: num(r.cpm),
    resultType: result.actionType,
    resultIsConversion: result.isConversion,
    results: result.count,
    costPerResult: result.costPer,
    resultValue: result.value,
    roas: result.value && spend > 0 ? result.value / spend : null,
    dateStart: r.date_start,
    dateStop: r.date_stop,
    level,
  };
}

function isoDaysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  return d.toISOString().slice(0, 10);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* --------------------------------------------------------------- handler */

/**
 * Last line of defence. Nothing in this file should place the token into an
 * outbound string, but every message that leaves the server is passed through
 * here so that a future edit cannot quietly turn into a credential leak.
 */
function scrubSecrets(text) {
  if (typeof text !== 'string') return text;
  let out = text.replace(/access_token=[^&\s]*/gi, 'access_token=REDACTED');
  const tok = process.env.META_ADS_TOKEN;
  if (tok && tok.length > 8) out = out.split(tok).join('REDACTED');
  return out;
}

export default async function handler(req, res) {
  noStore(res);
  if (!requireSession(req, res)) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const token = process.env.META_ADS_TOKEN;
  const accountRaw = process.env.META_AD_ACCOUNT_ID;

  if (!token || !accountRaw) {
    return res.status(500).json({
      error: 'server_misconfigured',
      message: 'META_ADS_TOKEN and META_AD_ACCOUNT_ID must both be set in the Vercel project environment variables.',
    });
  }

  const accountId = accountRaw.startsWith('act_') ? accountRaw : `act_${accountRaw}`;

  const level = LEVELS.has(req.query.level) ? req.query.level : 'campaign';
  const since = DATE_RE.test(req.query.since || '') ? req.query.since : isoDaysAgo(29);
  const until = DATE_RE.test(req.query.until || '') ? req.query.until : isoDaysAgo(0);

  if (since > until) {
    return res.status(400).json({ error: 'bad_range', message: 'Start date must be on or before end date.' });
  }

  const time_range = { since, until };
  const warnings = [];

  // NOTE ON ATTRIBUTION: action_attribution_windows is deliberately NOT sent.
  // The 7-day and 28-day view-through windows were removed from the API in
  // January 2026, and passing a retired window is an error. Omitting the
  // parameter uses the ad account's own default, which is both valid and what
  // Ads Manager shows. If explicit windows are ever wanted, use click-based
  // windows (1d_click / 7d_click) plus 1d_view only.

  try {
    const [breakdown, series] = await Promise.all([
      fetchWithBackoff(
        buildUrl(accountId, {
          level,
          fields: [...LEVEL_FIELDS[level], ...BASE_FIELDS].join(','),
          time_range,
          limit: '500',
        }),
      ),
      fetchWithBackoff(
        buildUrl(accountId, {
          level: 'account',
          fields: BASE_FIELDS.join(','),
          time_range,
          time_increment: '1', // one row per day, for the trend charts
          limit: '500',
        }),
      ),
    ]);

    const rows = (breakdown.json.data || []).map((r) => shapeRow(r, level));
    const daily = (series.json.data || [])
      .map((r) => shapeRow(r, 'account'))
      .sort((a, b) => (a.dateStart < b.dateStart ? -1 : 1));

    // Totals are summed from the daily series rather than the breakdown, so the
    // headline numbers stay correct regardless of which level is selected.
    const totals = daily.reduce(
      (acc, d) => {
        acc.spend += d.spend;
        acc.impressions += d.impressions;
        acc.clicks += d.clicks;
        acc.linkClicks += d.linkClicks;
        acc.results += d.results || 0;
        acc.resultValue += d.resultValue || 0;
        return acc;
      },
      { spend: 0, impressions: 0, clicks: 0, linkClicks: 0, results: 0, resultValue: 0 },
    );
    totals.ctr = totals.impressions ? (totals.clicks / totals.impressions) * 100 : 0;
    totals.cpc = totals.clicks ? totals.spend / totals.clicks : 0;
    totals.cpm = totals.impressions ? (totals.spend / totals.impressions) * 1000 : 0;
    totals.costPerResult = totals.results ? totals.spend / totals.results : null;
    totals.roas = totals.spend > 0 && totals.resultValue ? totals.resultValue / totals.spend : null;

    // Is anything actually reporting conversions, or are we looking at clicks?
    const conversionRow = [...rows, ...daily].find((r) => r.resultIsConversion);
    const proxyRow = [...rows, ...daily].find((r) => r.resultType && !r.resultIsConversion);

    let results;
    if (conversionRow) {
      results = {
        available: true,
        actionType: conversionRow.resultType,
        note: null,
      };
    } else if (proxyRow) {
      results = {
        available: false,
        actionType: proxyRow.resultType,
        note: `No conversion events are being reported for this account in this date range. The "results" figures below are ${proxyRow.resultType.replace(/_/g, ' ')} — a traffic proxy, not sign-ups. To measure Skool sign-ups you need a pixel or Conversions API event firing on the destination.`,
      };
      warnings.push('no_conversion_events');
    } else {
      results = {
        available: false,
        actionType: null,
        note: 'Meta returned no action data at all for this range, so no result or cost-per-result figures can be shown.',
      };
      warnings.push('no_action_data');
    }

    return res.status(200).json({
      account: accountId,
      apiVersion: API_VERSION,
      level,
      range: { since, until },
      fetchedAt: new Date().toISOString(),
      totals,
      rows,
      daily,
      results,
      warnings,
    });
  } catch (e) {
    const payload = {
      error: e.error || 'meta_error',
      message: scrubSecrets(e.message) || 'Request to Meta failed.',
    };
    if (e.metaMessage) payload.detail = scrubSecrets(e.metaMessage);
    return res.status(e.http || 502).json(payload);
  }
}
