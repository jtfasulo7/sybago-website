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

import { requireSession, noStore, ROLE_MASTER } from '../lib/auth.js';

// Meta ships a new Graph API version roughly quarterly and retires old ones
// after about two years. This is the one value likely to need bumping over the
// life of the dashboard, so it is configurable — and unsupported-version errors
// are detected explicitly below and reported in plain language.
const API_VERSION = process.env.META_API_VERSION || 'v23.0';

const LEVELS = new Set(['account', 'campaign', 'adset', 'ad']);

// Which ad account each dashboard view reads, and who is allowed to ask for it.
//
// The browser sends a view NAME, never an account id. That is the point: an
// account id in the query string would let anyone with a session read any
// account the token can see, and the standard-password session is meant to see
// only Dave's. The mapping from name to account lives here, on the server, and
// masterOnly is checked against the role in the signed cookie.
// A Meta token is scoped to a USER, not to an ad account: one token reads every
// account that user holds a role on. So two ad accounts usually need only one
// token. They need two only when the accounts live under Business Managers that
// do not share a user — hence tokenEnv, which prefers a view-specific token and
// falls back to the shared one when there is no separate token to use.
const VIEWS = {
  dave: {
    label: 'Peps by Dave',
    env: ['META_AD_ACCOUNT_ID', 'META_ADS_ACCOUNT_ID'],
    tokenEnv: ['META_ADS_TOKEN_DAVE', 'META_ADS_TOKEN'],
    masterOnly: false,
    /* Skool sign-ups fire CompleteRegistration. This account ALSO carries lead
       events from unrelated older campaigns, so naming the family is what stops
       those being added to the Skool figure. */
    conversion: 'registration',
    /* The event name as it reads in Events Manager, which is NOT the Insights
       action type. Optional: without it the pixel total is simply not shown. */
    pixelEvent: 'CompleteRegistration',
    pixelEnv: ['META_PIXEL_ID_DAVE', 'META_PIXEL_ID'],
  },
  sybago: {
    label: 'Montara Forge',
    env: ['META_ADS_ACCOUNT_ID_SYBAGO', 'META_AD_ACCOUNT_ID_SYBAGO'],
    tokenEnv: ['META_ADS_TOKEN_SYBAGO', 'META_ADS_TOKEN'],
    masterOnly: true,
    // The contact form fires Lead. There is no registration event here at all.
    conversion: 'lead',
    pixelEvent: 'Lead',
    pixelEnv: ['META_PIXEL_ID_SYBAGO', 'META_PIXEL_ID'],
  },
};
const DEFAULT_VIEW = 'dave';

function firstEnv(names) {
  for (const name of names) {
    const v = (process.env[name] || '').trim();
    if (v) return { value: v, envName: name };
  }
  return { value: null, envName: names[0] };
}

function resolveAccount(view) {
  const hit = firstEnv(VIEWS[view].env);
  if (!hit.value) return { id: null, envName: hit.envName };
  return { id: hit.value.startsWith('act_') ? hit.value : `act_${hit.value}`, envName: hit.envName };
}

function resolveToken(view) {
  return firstEnv(VIEWS[view].tokenEnv);
}

/** Every token this deployment knows about, for scrubbing. */
function allTokens() {
  const names = new Set();
  for (const v of Object.values(VIEWS)) for (const n of v.tokenEnv) names.add(n);
  return [...names].map((n) => (process.env[n] || '').trim()).filter((t) => t.length > 8);
}

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

// Metrics are extracted BY NAME, never guessed.
//
// An earlier version picked whichever action type ranked highest from a
// priority list — per row, independently. Rows that had registrations resolved
// to registrations, rows that did not fell back to landing page views, and the
// totals then summed the two together. That produced a single "results" number
// that was a mixture of two different metrics and meant nothing.
//
// Registrations and landing page views are now separate figures throughout and
// are never combined.

/**
 * The conversion that matters, whatever the account calls it.
 *
 * Meta reports ONE conversion under several aliases: a pixel-specific name, a
 * generic one, and sometimes an onsite or omni variant. Take the FIRST that is
 * present — never sum, or the same conversion is counted once per alias.
 * Montara Forge returns 'lead', 'offsite_conversion.fb_pixel_lead',
 * 'onsite_web_lead' and 'offsite_lead_add_20_s_calls' all reading 2; summing
 * would report 8 leads from 2.
 *
 * Registration and lead aliases share this ONE list because they are the same
 * question asked of two businesses. Dave's Skool sign-up fires
 * CompleteRegistration; Montara Forge's form fires Lead. An account fires one
 * or the other, so first-match resolves each correctly, and 'registrationType'
 * on the response names the alias that supplied the figure.
 *
 * ORDER IS THE CONTRACT, and it is decided per family rather than by a single
 * rule. Registrations lead with the pixel-specific name because every alias was
 * verified to agree. Leads lead with the UNIFIED `lead` instead, because there
 * the aliases are subsets of each other and the specific ones under-report —
 * see LEAD_TYPES.
 */
const REGISTRATION_TYPES = [
  'offsite_conversion.fb_pixel_complete_registration',
  'complete_registration',
];

/**
 * ORDER MATTERS, and it is the opposite of the registration list's.
 *
 * `lead` is Meta's UNIFIED total and is what the Leads column in Ads Manager
 * reports — the number the business counts against. The others are each a
 * subset: `offsite_conversion.fb_pixel_lead` is website leads only, and
 * `onsite_conversion.lead_grouped` is Facebook instant-form leads only.
 *
 * Putting a subset first is how the dashboard came to read low: an account
 * running both website and instant-form leads reported only the website half,
 * with nothing on screen to say the rest had been dropped.
 *
 * Still first-match, never a sum — `lead` already contains the others, so
 * adding them would count the same lead more than once.
 */
const LEAD_TYPES = [
  'lead',
  'offsite_conversion.fb_pixel_lead',
  'onsite_conversion.lead_grouped',
  'onsite_web_lead',
];

/**
 * Which family an account's conversions belong to.
 *
 * NOT a merged list. Dave's account contains BOTH — 17 complete_registration
 * from Skool and 16 lead from old unrelated lawyer campaigns — so a shared list
 * resolves per row and totals 33, a number that is two different conversions
 * added together and means nothing. Naming the family per view is what keeps
 * the wrong kind of row from ever contributing.
 */
const CONVERSION_TYPES = {
  registration: REGISTRATION_TYPES,
  lead: LEAD_TYPES,
};

/* Conversions Meta attributed that the account's own family does NOT contain.
 *
 * Montara Forge's Sep 9 submission came back only as
 * offsite_conversion.fb_pixel_custom — a custom conversion defined on the
 * shared pixel, with no matching `lead` on that day. It is a real form
 * submission that the lead count could not see.
 *
 * These are reported SEPARATELY and never added to the conversion total. A
 * custom conversion can be a rule built ON the same event, so summing the two
 * would count one submission twice — the identical mistake as merging the
 * registration and lead families, which turned 17 into 33. Naming them lets
 * the page say what else Meta recorded without claiming it is the same thing.
 */
/* ------------------------------------------------------------------------
 * MANUALLY ADDED CONVERSIONS — leads the ads produced that Meta cannot see.
 *
 * TO CHANGE THE NUMBER, edit `count` below. That is the whole knob.
 *
 * Meta credits only clicks it can attribute. This campaign's ad is also a real
 * Facebook page post that has been shared and saved, so it earns organic reach
 * the ad account never records: on 2026-09-11 it delivered 4 landing page
 * views while GoHighLevel took 3 form submissions. Those leads exist because
 * the post exists, so they are counted here.
 *
 * Rules this file lives by, because a dashboard that inflates its own
 * conversion count without saying so is worse than one that reads low:
 *
 *   - Every entry is DATED and counts only when the selected range covers it.
 *     A bare "+3 always" would show three leads on a day none happened.
 *   - Nothing is added while the figures are filtered to an ad set or an ad.
 *     An unattributed lead belongs to no ad set — that is what unattributed
 *     means — and assigning one to a specific ad would invent a conversion.
 *   - The response always reports what was added, and the page states it above
 *     the tiles. It is never silent.
 *   - Cost per lead is recomputed from the adjusted count, so the tiles agree
 *     with each other.
 *
 * NOTE ON THE FIGURE. At account level Meta attributes 3 and GoHighLevel holds
 * 5, so the observed gap is 2. The 3 configured here is the owner's explicit
 * instruction, given against a view that was filtered to one ad set showing 2.
 * Worth reconciling against GoHighLevel before trusting the total.
 * ---------------------------------------------------------------------- */
const MANUAL_CONVERSIONS = {
  sybago: [
    {
      date: '2026-09-11',
      count: 3,
      note: 'Website form submissions confirmed in GoHighLevel that Meta could not attribute to an ad click.',
    },
  ],
};

/** The entries whose day falls inside [since, until]. ISO dates compare as strings. */
function manualInRange(view, since, until) {
  return (MANUAL_CONVERSIONS[view] || []).filter((e) => e.date >= since && e.date <= until);
}

const OTHER_CONVERSION_TYPES = [
  'offsite_conversion.fb_pixel_custom',
  'offsite_conversion.fb_pixel_contact',
  'contact_total',
  'contact_website',
];

const LANDING_PAGE_VIEW_TYPES = ['landing_page_view'];

/* ----------------------------------------------------------------- errors */

/**
 * Translate a Meta error payload into something actionable. The point is that a
 * dead token and a missing permission and a bad account id should not all
 * surface as "request failed".
 */
// Default names, used when a caller has no more specific pair — the account
// and token variables the shared single-account setup uses.
const DEFAULT_ENV = { tokenEnv: 'META_ADS_TOKEN', accountEnv: 'META_AD_ACCOUNT_ID' };

function classifyMetaError(err, status, env = DEFAULT_ENV) {
  const code = err?.code;
  const sub = err?.error_subcode;
  const msg = err?.message || 'Unknown error from Meta.';
  const TOKEN = env.tokenEnv || DEFAULT_ENV.tokenEnv;
  const ACCOUNT = env.accountEnv || DEFAULT_ENV.accountEnv;

  if (code === 190) {
    if (sub === 463) {
      return { http: 401, error: 'token_expired', message: `The Meta access token has expired. Generate a new System User token and update ${TOKEN}.`, metaMessage: msg };
    }
    if (sub === 467) {
      return { http: 401, error: 'token_invalidated', message: `The Meta access token was invalidated (password change, or the token was revoked). Generate a new one and update ${TOKEN}.`, metaMessage: msg };
    }
    return { http: 401, error: 'token_invalid', message: `Meta rejected the access token. Check that ${TOKEN} is the System User token and was copied in full.`, metaMessage: msg };
  }

  // Meta returns several distinct problems under code 200. A missing asset
  // assignment is fixed in Business Settings; a BLOCKED account is Meta
  // enforcement against the account, app or business, and no permission change
  // will touch it. Telling the two apart matters more than the shared code
  // suggests, because the advice for one is useless for the other.
  if (/access blocked|api access is blocked|account.*(disabled|restricted)|business.*restricted/i.test(msg)) {
    return {
      http: 403,
      error: 'api_access_blocked',
      message:
        'Meta has blocked API access to this ad account. This is an enforcement action against ' +
        'the ad account, the app, or the business that owns them — not a missing permission, so ' +
        'assigning the System User will not fix it. Check Account Quality at ' +
        'business.facebook.com/accountquality for a restriction on the account or business, and ' +
        'the app status at developers.facebook.com. If the owning business was restricted, access ' +
        'stays blocked until that is appealed and restored.',
      metaMessage: msg,
    };
  }

  if (code === 200 || code === 10 || code === 294) {
    return { http: 403, error: 'insufficient_permission', message: `The token in ${TOKEN} is valid but cannot read this ad account. If the account is in the same Meta business as that token, assign the System User to it with View Performance (ads_read) in Business Settings. If it belongs to a different business, assignment cannot help — generate a token inside that business and set it there instead.`, metaMessage: msg };
  }

  if (code === 17 || code === 4 || code === 32 || code === 613 || (code >= 80000 && code <= 80014)) {
    return { http: 429, error: 'rate_limited', message: 'Meta is rate limiting this ad account. The dashboard retried with backoff and still could not get through. Wait a few minutes.', metaMessage: msg };
  }

  if (code === 100) {
    if (/unsupported get request|does not exist|cannot be loaded/i.test(msg)) {
      return { http: 400, error: 'account_not_found', message: `Meta could not load this ad account. Check ${ACCOUNT} is correct and prefixed with "act_", and that the token in ${TOKEN} belongs to a business that can see it.`, metaMessage: msg };
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
async function fetchWithBackoff(url, { retries = 3, env = DEFAULT_ENV } = {}) {
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

    const classified = classifyMetaError(json?.error, resp.status, env);
    lastErr = classified;

    const retryable =
      classified.error === 'rate_limited' || resp.status === 429 || resp.status >= 500;
    if (!retryable) break;
  }

  throw Object.assign(new Error(lastErr?.message || 'Meta request failed'), lastErr);
}

// The token is passed in rather than read from the environment here, so that
// which account is being queried and which credential is being used are decided
// in the same place instead of drifting apart.
function buildUrl(accountId, params, token) {
  const u = new URL(`https://graph.facebook.com/${API_VERSION}/${accountId}/insights`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  // Appended last and never logged.
  u.searchParams.set('access_token', token);
  return u.toString();
}

/**
 * URL for a management edge (/campaigns, /adsets, /ads) rather than /insights.
 *
 * The picker used to be built from an insights response, which only returns
 * entities that DELIVERED in the selected window. A brand new ad set with no
 * spend yet was therefore invisible in the dropdown — precisely when someone
 * most wants to select it and watch. The management edges list what EXISTS,
 * which is the right question for a picker.
 */
function buildEdgeUrl(accountId, edge, params, token) {
  const u = new URL(`https://graph.facebook.com/${API_VERSION}/${accountId}/${edge}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  u.searchParams.set('access_token', token);
  return u.toString();
}

/** Pixels on an ad account, so an id need not be pasted into an env var. */
function buildPixelStatsUrl(pixelId, range, token) {
  const u = new URL(`https://graph.facebook.com/${API_VERSION}/${pixelId}/stats`);
  u.searchParams.set('aggregation', 'event');
  // /stats takes seconds. The window is the one Meta RESOLVED for the charts,
  // so the two figures never cover different days.
  u.searchParams.set('start_time', String(Math.floor(Date.parse(range.since + 'T00:00:00Z') / 1000)));
  u.searchParams.set('end_time', String(Math.floor(Date.parse(range.until + 'T23:59:59Z') / 1000)));
  u.searchParams.set('access_token', token);
  return u.toString();
}

/**
 * Every event the pixel received in the window, attributed or not.
 *
 * Deliberately NOT merged into `registrations`: one counts what the ads
 * produced and the other what the business got, and a single blended figure
 * would answer neither.
 */
function sumPixelEvent(payload, eventName) {
  const buckets = (payload && payload.data) || [];
  if (!buckets.length) return { total: null, reason: 'no-events' };

  let total = 0;
  let matched = false;
  for (const bucket of buckets) {
    for (const row of bucket.data || []) {
      const name = row.value ?? row.event ?? row.name ?? row.key;
      const count = Number(row.count ?? row.value_count ?? row.total);
      if (name == null || !Number.isFinite(count)) continue;
      if (String(name).toLowerCase() === String(eventName).toLowerCase()) {
        total += count;
        matched = true;
      }
    }
  }
  if (!matched) return { total: null, reason: 'event-not-found' };
  return { total, reason: null };
}

/* --------------------------------------------------------------- shaping */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Pull one named metric out of Meta's action arrays. Returns nulls when the
 *  event simply is not being reported, which is different from zero. */
function pull(types, byType, costByType, valueByType) {
  for (const t of types) {
    if (byType.has(t)) {
      return {
        actionType: t,
        count: byType.get(t),
        costPer: costByType.get(t) ?? null,
        value: valueByType.get(t) ?? null,
      };
    }
  }
  return { actionType: null, count: null, costPer: null, value: null };
}

function extractMetrics(actions, costPer, actionValues, family = 'registration') {
  const byType = new Map((actions || []).map((a) => [a.action_type, num(a.value)]));
  const costByType = new Map((costPer || []).map((a) => [a.action_type, num(a.value)]));
  const valueByType = new Map((actionValues || []).map((a) => [a.action_type, num(a.value)]));

  const types = CONVERSION_TYPES[family] || REGISTRATION_TYPES;

  /* Every attributed conversion outside this account's family, listed by name
     rather than summed into one figure — the caller has to be able to say
     WHICH other event Meta recorded, not just how many. */
  const counted = new Set(types);
  const other = [];
  for (const type of OTHER_CONVERSION_TYPES) {
    if (counted.has(type)) continue;
    const count = byType.get(type);
    if (count) other.push({ actionType: type, count });
  }

  return {
    registration: pull(types, byType, costByType, valueByType),
    landingPageView: pull(LANDING_PAGE_VIEW_TYPES, byType, costByType, valueByType),
    other,
  };
}

function shapeRow(r, level, family) {
  const m = extractMetrics(r.actions, r.cost_per_action_type, r.action_values, family);
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
    // Registrations — the actual outcome. Complete-registration events only.
    registrations: m.registration.count,
    costPerRegistration: m.registration.costPer,
    registrationValue: m.registration.value,
    registrationType: m.registration.actionType,
    roas: m.registration.value && spend > 0 ? m.registration.value / spend : null,
    // Landing page views — a separate traffic metric, never folded into the above.
    landingPageViews: m.landingPageView.count,
    costPerLandingPageView: m.landingPageView.costPer,
    /* Attributed conversions this account does not score on, as
       [{actionType, count}]. Reported so a form submission Meta filed under a
       custom conversion is visible instead of vanishing. NEVER added to
       registrations. */
    otherConversions: m.other,
    adId: r.ad_id || null,
    adName: r.ad_name || null,
    adsetId: r.adset_id || null,
    dateStart: r.date_start,
    dateStop: r.date_stop,
    // Present only on an hourly request. Meta returns a range like
    // "13:00:00 - 13:59:59"; the leading hour is the useful part.
    hour: r.hourly_stats_aggregated_by_advertiser_time_zone
      ? Number(String(r.hourly_stats_aggregated_by_advertiser_time_zone).slice(0, 2))
      : null,
    hourLabel: r.hourly_stats_aggregated_by_advertiser_time_zone || null,
    level,
  };
}

/* The LOCAL calendar date n days back, not the UTC one.
   toISOString() is UTC, so after 20:00 in New York it already reports
   tomorrow — which put a future date on the dashboard and shifted every
   computed window forward by a day. */
function isoDaysAgo(n) {
  const d = new Date(Date.now() - n * 86400000);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
  // Every token, not just the shared one — a per-view token added later must
  // not become the one credential this net fails to catch.
  for (const tok of allTokens()) out = out.split(tok).join('REDACTED');
  return out;
}

export default async function handler(req, res) {
  noStore(res);
  const session = requireSession(req, res);
  if (!session) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // An unknown view name falls back to the default rather than erroring: it is
  // a stale bookmark, not an attack, and the fallback is the narrower account.
  const view = Object.prototype.hasOwnProperty.call(VIEWS, req.query.view) ? req.query.view : DEFAULT_VIEW;
  // Which conversion this account actually fires. Fixed by the account, never
  // by the request: a caller cannot ask to have leads counted as sign-ups.
  const conversionFamily = VIEWS[view].conversion || 'registration';

  // THE authorisation check. A standard-password session asking for the agency
  // view is refused here, before any account id is resolved and long before
  // anything reaches Meta.
  if (VIEWS[view].masterOnly && session.role !== ROLE_MASTER) {
    return res.status(403).json({
      error: 'forbidden_view',
      message: 'This dashboard requires the master password.',
    });
  }

  // ?debug=accounts — can the token each view would use actually read that
  // view's ad account?
  //
  // An earlier version asked /me/adaccounts and reported anything absent from
  // that list as unreachable. That is wrong for a System User token, which is
  // the kind this deployment uses: a System User is ASSIGNED assets rather than
  // owning them, so /me/adaccounts comes back empty and every account looks
  // unreachable — including one that is demonstrably serving data. The only
  // reliable check is to ask for the account itself with the token that would
  // be used for it, which is what this does.
  //
  // Master only, and it returns account ids and names — never any part of a
  // token.
  if (req.query.debug === 'accounts') {
    if (session.role !== ROLE_MASTER) {
      return res.status(403).json({
        error: 'forbidden_view',
        message: 'This diagnostic requires the master password.',
      });
    }

    const views = {};
    for (const key of Object.keys(VIEWS)) {
      const acct = resolveAccount(key);
      const tok = resolveToken(key);
      const entry = {
        label: VIEWS[key].label,
        accountId: acct.id,
        accountFrom: acct.envName,
        tokenSource: tok.envName,
        tokenConfigured: Boolean(tok.value),
      };

      if (!acct.id || !tok.value) {
        entry.reachable = null;
        entry.note = !acct.id
          ? `Set ${acct.envName} to this dashboard's act_… id.`
          : `No token configured — set ${tok.envName} or the shared META_ADS_TOKEN.`;
      } else {
        try {
          const u = new URL(`https://graph.facebook.com/${API_VERSION}/${acct.id}`);
          u.searchParams.set('fields', 'id,name,account_status,currency');
          u.searchParams.set('access_token', tok.value);
          const { json } = await fetchWithBackoff(u.toString(), {
            env: { tokenEnv: tok.envName, accountEnv: acct.envName },
          });
          entry.reachable = true;
          entry.accountName = json.name || null;
          entry.currency = json.currency || null;
        } catch (e) {
          entry.reachable = false;
          entry.error = e.error || 'meta_error';
          entry.note = scrubSecrets(e.message || 'Request failed');
        }
      }
      views[key] = entry;
    }

    // One token that reaches every account means no second token is needed.
    const reach = Object.values(views).filter((v) => v.reachable !== null);
    const summary = reach.length === 0
      ? 'Nothing configured yet.'
      : reach.every((v) => v.reachable)
        ? 'Every dashboard is reachable with its configured token. No extra token needed.'
        : `Unreachable: ${reach.filter((v) => !v.reachable).map((v) => v.label).join(', ')}. ` +
          'Either assign the System User to that ad account in Business Settings with View ' +
          'Performance, or set a separate token for that view.';

    return res.status(200).json({ summary, views });
  }

  /* ?debug=pixel — the raw /stats payload and the pixels on the account.
     The row shape is undocumented; this exists to read it off a real account
     rather than infer it. */
  if (req.query.debug === 'pixel') {
    const cfg = VIEWS[view];
    try {
      const list = await fetchWithBackoff(
        buildEdgeUrl(accountId, 'adspixels', { fields: 'id,name', limit: '25' }, token),
        { env: envNames },
      );
      const pixels = (list.json.data || []).map((p) => ({ id: p.id, name: p.name || null }));
      const configured = firstEnv(cfg.pixelEnv || []).value;
      const pixelId = configured || (pixels[0] && pixels[0].id) || null;
      if (!pixelId) {
        return res.status(200).json({ view, pixels, message: 'No pixel is attached to this ad account.' });
      }
      const raw = await fetchWithBackoff(
        buildPixelStatsUrl(pixelId, { since, until }, token), { env: envNames },
      );
      return res.status(200).json({
        view,
        pixels,
        pixelId,
        pixelIdSource: configured ? firstEnv(cfg.pixelEnv).envName : 'discovered from the ad account',
        expectedEvent: cfg.pixelEvent || null,
        range: { since, until },
        parsed: sumPixelEvent(raw.json, cfg.pixelEvent || 'Lead'),
        raw: raw.json,
      });
    } catch (e) {
      return res.status(200).json({ view, error: scrubSecrets(e.message || String(e)) });
    }
  }

  // ?debug=meta-assets — the Facebook Pages each configured Meta token can act
  // on, and the Instagram account linked to each one.
  //
  // This exists to answer "what do I put in FB_PAGE_ID and IG_USER_ID" without
  // digging through Business Settings, and to show whether the token actually
  // holds the publishing permissions — being in the same business portfolio
  // gets the assets in one place, but a token still only does what its scopes
  // allow, and an ads_read token cannot post.
  //
  // Master only. Returns ids and names. It deliberately does NOT return any
  // page access token: those are long-lived credentials, and printing one into
  // a response body puts it somewhere it does not need to be.
  if (req.query.debug === 'meta-assets') {
    if (session.role !== ROLE_MASTER) {
      return res.status(403).json({
        error: 'forbidden_view',
        message: 'This diagnostic requires the master password.',
      });
    }

    // Includes the POSTING credentials, not just the ads ones. Publishing
    // belongs in its own Meta app: App Review is per app and per permission, so
    // an app awaiting review for pages_manage_posts cannot disturb the ads
    // dashboard, and a revoked posting token does not take insights down.
    const names = [...new Set([
      ...Object.values(VIEWS).flatMap((v) => v.tokenEnv),
      'FB_PAGE_ACCESS_TOKEN',
      'IG_ACCESS_TOKEN',
    ])];
    const tokens = [];

    for (const name of names) {
      const value = (process.env[name] || '').trim();
      if (!value) { tokens.push({ envName: name, configured: false }); continue; }

      const entry = { envName: name, configured: true, purpose: /PAGE|IG_/.test(name) ? 'posting' : 'ads' };

      // Which scopes the token actually carries. Publishing needs more than
      // reading insights does, so a token that works for the dashboard can
      // still be unable to post.
      try {
        const pu = new URL(`https://graph.facebook.com/${API_VERSION}/me/permissions`);
        pu.searchParams.set('access_token', value);
        const { json } = await fetchWithBackoff(pu.toString());
        const granted = (json.data || []).filter((p) => p.status === 'granted').map((p) => p.permission);
        entry.scopes = granted;
        entry.canPostToPages = granted.includes('pages_manage_posts');
        entry.canPostToInstagram = granted.includes('instagram_content_publish');
      } catch (e) {
        // A System User token often refuses /me/permissions outright; that is
        // not a failure of the check, just a shape it does not support.
        entry.scopes = null;
        entry.scopesNote = scrubSecrets(e.message || 'Could not read permissions.');
      }

      try {
        const u = new URL(`https://graph.facebook.com/${API_VERSION}/me/accounts`);
        u.searchParams.set('fields', 'id,name,instagram_business_account{id,username}');
        u.searchParams.set('limit', '100');
        u.searchParams.set('access_token', value);
        const { json } = await fetchWithBackoff(u.toString());
        entry.pages = (json.data || []).map((p) => ({
          pageId: p.id,
          pageName: p.name,
          instagramUserId: p.instagram_business_account?.id || null,
          instagramUsername: p.instagram_business_account?.username || null,
        }));
      } catch (e) {
        entry.pages = null;
        entry.pagesError = scrubSecrets(e.message || 'Could not list Pages.');
      }

      tokens.push(entry);
    }

    // Spell out what to set, so nothing has to be inferred from the shape above.
    const found = tokens.flatMap((t) => (t.pages || []).map((p) => ({ ...p, from: t.envName })));
    const suggestion = found.length
      ? {
          FB_PAGE_ID: found[0].pageId,
          IG_USER_ID: found[0].instagramUserId,
          note:
            'FB_PAGE_ACCESS_TOKEN and IG_ACCESS_TOKEN are not shown here on purpose. Get a ' +
            'long-lived Page token from Business Settings or the Graph API Explorer and set ' +
            'both to it — a user token expires in about an hour.',
        }
      : {
          note:
            'No Pages came back. Either the token has no Page assigned to it, or it lacks ' +
            'pages_show_list. Assign the Page to this System User in Business Settings and ' +
            'grant pages_manage_posts and instagram_content_publish.',
        };

    return res.status(200).json({ tokens, pagesFound: found, setThese: suggestion });
  }

  // META_AD_ACCOUNT_ID and META_ADS_ACCOUNT_ID are trivially easy to confuse
  // (the token variable is plural, so the plural form is the natural typo), so
  // each view accepts either spelling.
  const account = resolveAccount(view);
  const tokenHit = resolveToken(view);
  const token = tokenHit.value;
  // Carried into every Meta call so a failure names the variables for THIS
  // dashboard rather than the other one's.
  const envNames = { tokenEnv: tokenHit.envName, accountEnv: account.envName };

  if (!token || !account.id) {
    const missing = [];
    if (!token) missing.push(`${tokenHit.envName} (for the "${VIEWS[view].label}" dashboard)`);
    if (!account.id) missing.push(`${account.envName} (for the "${VIEWS[view].label}" dashboard)`);
    return res.status(500).json({
      error: 'server_misconfigured',
      message:
        `Missing in this deployment: ${missing.join(' and ')}. ` +
        'Set them in Vercel → Project → Settings → Environment Variables, then redeploy — ' +
        'environment changes only apply to new deployments.',
    });
  }

  const accountId = account.id;

  const level = LEVELS.has(req.query.level) ? req.query.level : 'campaign';
  const since = DATE_RE.test(req.query.since || '') ? req.query.since : isoDaysAgo(29);
  const until = DATE_RE.test(req.query.until || '') ? req.query.until : isoDaysAgo(0);

  if (since > until) {
    return res.status(400).json({ error: 'bad_range', message: 'Start date must be on or before end date.' });
  }

  // "Today" is resolved by META, not by us.
  //
  // Computing it from the caller's clock asks for the wrong day whenever the
  // browser and the ad account are in different timezones: at 00:30 Mountain
  // the account may still be on the previous day in Pacific, so an explicit
  // date range returns an empty set and the dashboard reads as broken when
  // nothing is wrong. date_preset=today is evaluated in the ad account's own
  // timezone, which is also the timezone Ads Manager reports in.
  const useToday = req.query.preset === 'today';

  /* Rolling windows are resolved by META, in the ad account's timezone.
     Computing "the last 7 days" from the caller's clock asks the wrong
     question whenever the browser and the ad account disagree about what day
     it is — which, for a US account viewed in the evening, is every evening.
     Meta's last_Nd presets are evaluated in the account's own timezone, the
     same one Ads Manager reports in. Only this fixed list is honoured, so a
     query string can never inject an arbitrary preset. */
  const ROLLING_PRESETS = new Set(['last_7d', 'last_14d', 'last_30d', 'last_90d']);
  const rollingPreset = ROLLING_PRESETS.has(req.query.preset) ? req.query.preset : null;

  /* Lifetime is Meta's own `maximum` preset rather than a date range we invent.
     Asking for "since the beginning" by guessing a start date means guessing:
     too early and every chart carries months of empty axis, too late and the
     first weeks of the account silently vanish. `maximum` is resolved by Meta
     against what the account actually has — capped by Meta at 37 months, which
     is why the response reports the window it really used. */
  const useMaximum = req.query.preset === 'maximum';

  const time_range = { since, until };
  const period = useToday
    ? { date_preset: 'today' }
    : useMaximum
      ? { date_preset: 'maximum' }
      : rollingPreset
        ? { date_preset: rollingPreset }
        : { time_range };

  // Hourly is a BREAKDOWN, not a finer time_increment: asking for
  // time_increment=1 across a single day returns one row for that day, not
  // twenty-four. The advertiser-timezone variant is the one that lines up with
  // what Ads Manager shows, rather than the viewer's timezone.
  const hourly = req.query.hourly === '1';
  const hourlyParams = hourly
    ? { breakdowns: 'hourly_stats_aggregated_by_advertiser_time_zone' }
    : {};
  const warnings = [];

  // Optional scoping to one campaign or ad set.
  //
  // This has to happen server-side. Filtering the breakdown rows in the browser
  // would be easy, but the daily trend series is requested at account level —
  // so without passing the filter to Meta the charts would keep showing totals
  // for the whole account while the table showed one campaign. Meta's own
  // `filtering` parameter scopes both requests identically.
  const scope = {};

  // Comma separated ids. Anything non-numeric is dropped rather than passed
  // through — an id from a query string reaches Meta's filter, so it is checked
  // for shape here rather than trusted.
  const idList = (raw) =>
    String(raw || '')
      .split(',')
      .map((x) => x.trim())
      .filter((x) => /^\d+$/.test(x))
      .slice(0, 20);

  /* `adsetIds` is the list; `adsetId` is the older single-value form, still
     accepted so an existing link or a cached client keeps working. */
  const adsetIds = idList(req.query.adsetIds);
  if (adsetIds.length) scope.adsetIds = adsetIds;
  else if (/^\d+$/.test(req.query.adsetId || '')) scope.adsetIds = [req.query.adsetId];
  // The narrowest single ad set, for callers that still read one.
  scope.adsetId = scope.adsetIds && scope.adsetIds.length === 1 ? scope.adsetIds[0] : null;

  /* `campaignIds` is the list; `campaignId` is the older single-value form,
     still accepted so a bookmarked link keeps working. */
  const campaignIds = idList(req.query.campaignIds);
  if (campaignIds.length) scope.campaignIds = campaignIds;
  else if (/^\d+$/.test(req.query.campaignId || '')) scope.campaignIds = [req.query.campaignId];
  scope.campaignId = scope.campaignIds && scope.campaignIds.length === 1 ? scope.campaignIds[0] : null;

  const adIds = idList(req.query.adIds);
  if (adIds.length) scope.adIds = adIds;

  const filtering = [];
  // Ads are the narrowest scope, so they win over the ad set and campaign.
  if (scope.adIds) {
    filtering.push({ field: 'ad.id', operator: 'IN', value: scope.adIds });
  } else if (scope.adsetIds) {
    filtering.push({ field: 'adset.id', operator: 'IN', value: scope.adsetIds });
  } else if (scope.campaignIds) {
    filtering.push({ field: 'campaign.id', operator: 'IN', value: scope.campaignIds });
  }
  const filterParam = filtering.length ? { filtering } : {};

  /* Comparing ad sets against each other, rather than reporting one total.
     Only when there is more than one and no ad is selected — ads are the
     narrower scope and win, exactly as they do in the filter above. */
  const splitByAdset = !scope.adIds && !!(scope.adsetIds && scope.adsetIds.length > 1);



  // NOTE ON ATTRIBUTION.
  //
  // action_attribution_windows is deliberately NOT sent. The 7-day and 28-day
  // view-through windows were removed from the API in January 2026, and passing
  // a retired window is an error.
  //
  // use_unified_attribution_setting=true IS sent. Without it the Insights API
  // falls back to a legacy default window instead of the attribution setting
  // the ad set is actually configured with, so the API returns a lower
  // conversion count than the same date range in Ads Manager — the exact
  // symptom of "the dashboard says 6 and Ads Manager says 10". With it, both
  // read the ad set's own setting and agree.
  const attribution = { use_unified_attribution_setting: 'true' };

  /* ?breakdown=geo — where the delivery actually happened.
     country and region are requested TOGETHER so a row reads "US, Utah" rather
     than just "US", which is the difference between knowing a campaign reached
     America and knowing it reached the state being sold to.

     Answered on its own request rather than folded into the main payload: a geo
     breakdown multiplies the row count by every region delivered to, and the
     other panels would carry that weight for a widget that may never be opened.
     It reuses the period, scope and filter resolved above so it can never
     disagree with the rest of the page about what is being looked at. */
  if (req.query.breakdown === 'geo') {
    try {
      const { json } = await fetchWithBackoff(
        buildUrl(
          accountId,
          {
            level: 'account',
            fields: BASE_FIELDS.join(','),
            ...period,
            breakdowns: 'country,region',
            limit: '500',
            ...attribution,
            ...filterParam,
          },
          token,
        ),
        { env: envNames },
      );

      const rows = (json.data || []).map((r) => {
        const shaped = shapeRow(r, 'account', conversionFamily);
        const country = r.country || null;
        const region = r.region || null;
        return {
          ...shaped,
          country,
          region,
          // Region alone is ambiguous across countries; country alone is too
          // coarse to act on.
          name: country && region ? country + ', ' + region : region || country || 'Unknown',
        };
      });

      return res.status(200).json({
        view,
        viewLabel: VIEWS[view].label,
        range: time_range,
        rows,
        fetchedAt: new Date().toISOString(),
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


  try {
    // A third request fetches the campaign/ad set list for the picker. It is
    // unscoped on purpose — the dropdown must still offer every option even
    // when the view is filtered down to one of them.
    const [breakdown, series, deduped, picker] = await Promise.all([
      fetchWithBackoff(
        buildUrl(accountId, {
          level,
          fields: [...LEVEL_FIELDS[level], ...BASE_FIELDS].join(','),
          ...period,
          limit: '500',
          ...attribution,
          ...filterParam,
        }, token),
        { env: envNames },
      ),
      fetchWithBackoff(
        buildUrl(accountId, {
          // When scoped, the trend must be scoped too, so it is requested at
          // the scoped level rather than at account level.
          /* Several ad sets means one row per ad set per day, which is what
             lets the client draw a line each. ONE ad set is left aggregated:
             the split would produce the same numbers at more cost, and the
             single-line path is what the metric overlay expects. */
          level: scope.adIds
            ? 'ad'
            : scope.adsetIds ? 'adset' : scope.campaignIds ? 'campaign' : 'account',
          // Ad name comes along when the series is per-ad, so the client can
          // draw one line per ad rather than one merged line.
          fields: (scope.adIds
            ? ['ad_id', 'ad_name', ...BASE_FIELDS]
            : splitByAdset ? ['adset_id', 'adset_name', ...BASE_FIELDS] : BASE_FIELDS).join(','),
          ...period,
          // Hourly replaces the daily increment; the two cannot be combined.
          ...(hourly ? {} : { time_increment: '1' }), // one row per day, for the trend charts
          limit: '500',
          ...attribution,
          ...hourlyParams,
          ...filterParam,
        }, token),
        { env: envNames },
      ),
      fetchWithBackoff(
        /* THE headline row: the whole window, aggregated by Meta itself.
           Every KPI tile reads this rather than a sum of the daily series.

           Two reasons, and both matter.

           FRESHNESS. time_increment=1 is materialised separately inside Meta
           from the aggregate, and the current day's row arrives later and keeps
           settling longer. Summing it meant the tiles trailed Ads Manager by
           however long Meta took to write today's row.

           CORRECTNESS. Reach counts PEOPLE, so summing the daily series counts
           somebody reached on Monday and again on Tuesday twice, and the total
           climbs past impressions — impossible, and entirely plausible-looking
           on a tile. Only Meta can deduplicate, and it only does so for the
           period it is asked about: one row, no time_increment, no level
           breakdown.

           The same request already existed for reach alone. Asking it for the
           full field set costs nothing extra. */
        buildUrl(accountId, {
          level: 'account',
          fields: BASE_FIELDS.join(','),
          ...period,
          limit: '1',
          ...attribution,
          ...filterParam,
        }, token),
        { env: envNames },
      ),
      fetchWithBackoff(
        // The whole campaign tree in one request, via nested edges. Lists what
        // exists rather than what delivered, so a new ad set appears
        // immediately instead of only after its first impression.
        buildEdgeUrl(
          accountId,
          'campaigns',
          {
            fields: 'id,name,status,adsets.limit(200){id,name,status,ads.limit(200){id,name,status}}',
            limit: '200',
          },
          token,
        ),
        { env: envNames },
      ),
    ]);

    // ?debug=actions — every action type present, with its total, so a
    // missing conversion can be traced to the right cause without guessing.
    if (req.query.debug === 'actions') {
      // Tallied per source. Keying off date_start === date_stop would put the
      // breakdown rows into the daily bucket whenever the range is a single
      // day, and report every figure twice.
      const tally = new Map();
      const add = (rowsIn, bucket) => {
        for (const r of rowsIn || []) {
          for (const a of r.actions || []) {
            const k = a.action_type;
            if (!tally.has(k)) tally.set(k, { actionType: k, breakdown: 0, daily: 0 });
            tally.get(k)[bucket] += num(a.value);
          }
        }
      };
      add(breakdown.json.data, 'breakdown');
      add(series.json.data, 'daily');
      return res.status(200).json({
        range: time_range,
        conversionFamily,
      knownRegistrationTypes: CONVERSION_TYPES[conversionFamily] || REGISTRATION_TYPES,
        knownLandingPageViewTypes: LANDING_PAGE_VIEW_TYPES,
        unifiedAttribution: true,
        actionTypes: [...tally.values()].sort((a, b) => b.daily - a.daily || b.breakdown - a.breakdown),
      });
    }

    const rows = (breakdown.json.data || []).map((r) => shapeRow(r, level, conversionFamily));
    const daily = (series.json.data || [])
      .map((r) => shapeRow(r, 'account', conversionFamily))
      .sort((a, b) => {
        // With several ads there are multiple rows per period, so the ad is the
        // primary key and time is the secondary one.
        // Whichever id is splitting the rows is the primary key; time is
        // secondary. Sorting by ad id alone would interleave ad set series.
        const ka = splitByAdset ? a.adsetId : a.adId;
        const kb = splitByAdset ? b.adsetId : b.adId;
        if (ka !== kb) return String(ka).localeCompare(String(kb));
        return hourly ? (a.hour ?? 0) - (b.hour ?? 0) : a.dateStart < b.dateStart ? -1 : 1;
      });

    /* What the range ACTUALLY was.
       For a preset, Meta resolved the window, not us — the since/until computed
       from the caller's clock is a placeholder that would be wrong. The client
       builds its x-axis from this, so handing back the placeholder would draw an
       axis that does not match the data sitting on it: for lifetime, months of
       empty leading axis, or a chart that silently starts after the account did.
       Read back off the rows Meta returned. */
    const dates = daily.map((r) => r.dateStart).filter(Boolean).sort();
    const resolved = (useToday || useMaximum || rollingPreset) && dates.length
      ? { since: dates[0], until: dates[dates.length - 1] }
      : { since, until };

    /* THE ANCHOR: everything, all time, no filter.
       A scoped or short-range figure is unreadable on its own — "1 lead" gives
       no way to tell a quiet day apart from a broken page. This is the number
       the tiles are a subset OF, so the client can say "1 today, 3 all-time"
       in one breath.

       Skipped when the request is already unfiltered lifetime, where it would
       be the identical call twice. Wrapped, like the pixel total: an anchor
       failing must never cost the figures it was there to explain. */
    let lifetime = null;
    const isFiltered = Object.keys(filterParam).length > 0;
    if (isFiltered || !useMaximum) {
      try {
        const anchor = await fetchWithBackoff(
          buildUrl(accountId, {
            level: 'account',
            fields: BASE_FIELDS.join(','),
            date_preset: 'maximum',
            limit: '1',
            ...attribution,
          }, token),
          { env: envNames },
        );
        const row = (anchor.json.data || [])[0];
        if (row) {
          const a = shapeRow(row, 'account', conversionFamily);
          /* The anchor is the unfiltered all-time figure, so it carries EVERY
             manual entry. Leaving them out would have the comparison line
             contradict the tile it is there to explain. */
          const allManual = (MANUAL_CONVERSIONS[view] || []).reduce((n, e) => n + e.count, 0);
          lifetime = {
            registrations: (a.registrations || 0) + allManual,
            spend: a.spend,
            otherConversions: a.otherConversions,
            since: row.date_start,
            until: row.date_stop,
          };
        }
      } catch (e) {
        lifetime = null;
      }
    }

    /* The pixel's own count, over the range Meta resolved for the charts.
       Wrapped so a pixel problem can never take the dashboard down with it —
       this is context beside the headline figure, not the figure itself. */
    let pixelTotal = null;
    const pixelCfg = VIEWS[view];
    if (pixelCfg.pixelEvent) {
      try {
        let pixelId = firstEnv(pixelCfg.pixelEnv || []).value;
        if (!pixelId) {
          const list = await fetchWithBackoff(
            buildEdgeUrl(accountId, 'adspixels', { fields: 'id', limit: '5' }, token),
            { env: envNames },
          );
          pixelId = ((list.json.data || [])[0] || {}).id || null;
        }
        if (pixelId) {
          const raw = await fetchWithBackoff(
            buildPixelStatsUrl(pixelId, resolved, token), { env: envNames },
          );
          const sum = sumPixelEvent(raw.json, pixelCfg.pixelEvent);
          pixelTotal = { event: pixelCfg.pixelEvent, total: sum.total, reason: sum.reason, pixelId };
        }
      } catch (e) {
        pixelTotal = { event: pixelCfg.pixelEvent, total: null, reason: 'error', message: scrubSecrets(e.message || String(e)) };
      }
    }

    // Totals are summed from the daily series rather than the breakdown, so the
    // headline numbers stay correct regardless of which level is selected.
    // Each metric is summed only against itself. Nothing is combined across
    // action types.
    /* Summed from the daily series. No longer the headline figure — kept as
       the fallback for a window Meta returns no aggregate row for, where a sum
       of nothing is a truthful zero but an absent row is not. */
    const summed = daily.reduce(
      (acc, d) => {
        acc.spend += d.spend;
        acc.impressions += d.impressions;
        acc.clicks += d.clicks;
        acc.linkClicks += d.linkClicks;
        acc.registrations += d.registrations || 0;
        acc.registrationValue += d.registrationValue || 0;
        acc.landingPageViews += d.landingPageViews || 0;
        return acc;
      },
      {
        spend: 0, impressions: 0, clicks: 0, linkClicks: 0,
        registrations: 0, registrationValue: 0, landingPageViews: 0,
      },
    );

    /* A missing row means no delivery in the window — a real zero rather than
       a fault, and the only case where the daily sum answers instead. */
    const dedupRow = (deduped.json.data || [])[0] || null;
    const agg = dedupRow ? shapeRow(dedupRow, 'account', conversionFamily) : null;
    const totalsSource = agg ? 'aggregate' : 'daily-sum';

    const totals = agg
      ? {
          spend: agg.spend,
          impressions: agg.impressions,
          clicks: agg.clicks,
          linkClicks: agg.linkClicks,
          registrations: agg.registrations || 0,
          registrationValue: agg.registrationValue || 0,
          landingPageViews: agg.landingPageViews || 0,
        }
      : summed;

    /* From the aggregate row, so this is the figure for the whole window and
       the whole current scope — not a sum that could double-count. */
    totals.otherConversions = agg ? agg.otherConversions : [];

    totals.reach = agg ? agg.reach : 0;
    /* Frequency is impressions per person. Meta returns its own, but deriving
       it from the two figures actually on the tiles keeps all three consistent
       — a tile reading 1.2 beside numbers that divide to 1.4 looks like a bug
       whichever one is right. */
    totals.frequency = totals.reach ? totals.impressions / totals.reach : 0;

    /* Manually added conversions, folded in before any cost-per figure is
       derived so every tile agrees with every other one.

       Withheld while filtered: an unattributed lead cannot be assigned to an
       ad set or an ad without inventing a conversion for one. The client is
       told WHY rather than just seeing a smaller number. */
    const manualEntries = manualInRange(view, resolved.since, resolved.until);
    const manualCount = manualEntries.reduce((n, e) => n + e.count, 0);
    const manualApplied = manualCount > 0 && !isFiltered;

    if (manualApplied) {
      totals.registrations += manualCount;
      /* The chart reads the daily series, so the day gets its share too —
         otherwise the tile says 6 and the line adds up to 3. A day Meta
         returned no row for is skipped rather than invented, since there is no
         spend to sit it beside. */
      for (const e of manualEntries) {
        const row = daily.find((r) => r.dateStart === e.date);
        if (row) row.registrations = (row.registrations || 0) + e.count;
      }
    }

    const manualConversions = {
      count: manualCount,
      applied: manualApplied,
      entries: manualEntries.map((e) => ({ date: e.date, count: e.count, note: e.note })),
      /* Why it was not applied, so the page can say so instead of silently
         showing a different number than it did a moment ago. */
      withheldReason: manualCount > 0 && !manualApplied
        ? 'filtered to an ad set or ad, which an unattributed lead cannot belong to'
        : null,
    };

    totals.ctr = totals.impressions ? (totals.clicks / totals.impressions) * 100 : 0;
    totals.cpc = totals.clicks ? totals.spend / totals.clicks : 0;
    totals.cpm = totals.impressions ? (totals.spend / totals.impressions) * 1000 : 0;
    totals.costPerRegistration = totals.registrations ? totals.spend / totals.registrations : null;
    totals.costPerLandingPageView = totals.landingPageViews ? totals.spend / totals.landingPageViews : null;
    totals.roas =
      totals.spend > 0 && totals.registrationValue ? totals.registrationValue / totals.spend : null;

    // Report separately whether each metric is present at all. A row reporting
    // landing page views but no registrations is a real and meaningful state —
    // traffic arriving but not converting — and must not be disguised.
    const anyReg = [...rows, ...daily].some((r) => r.registrationType);
    const anyLpv = [...rows, ...daily].some((r) => r.landingPageViews !== null);

    const results = {
      available: anyReg,
      actionType: ([...rows, ...daily].find((r) => r.registrationType) || {}).registrationType || null,
      landingPageViewsAvailable: anyLpv,
      note: anyReg
        ? null
        : anyLpv
          ? 'No complete-registration events were reported in this range, so there are no sign-up figures. Landing page views are shown separately below — those are visits, not sign-ups. If you expect registrations here, check that a CompleteRegistration event is firing on the Skool destination.'
          : 'Meta reported neither complete-registration nor landing-page-view events for this range.',
    };
    if (!anyReg) warnings.push('no_registration_events');
    if (!anyLpv) warnings.push('no_landing_page_views');

    // Options for the picker, read straight off the management tree.
    //
    // Meta omits an edge entirely rather than returning it empty, so a campaign
    // with no ad sets, or an ad set with no ads, simply has no key — hence the
    // ?. and the fallbacks. That is the normal shape for something just
    // created, which is the case this exists to handle.
    const campaigns = (picker.json.data || [])
      .map((c) => ({
        id: c.id,
        name: c.name || c.id,
        status: c.status || null,
        adsets: (c.adsets?.data || []).map((a) => ({
          id: a.id,
          name: a.name || a.id,
          status: a.status || null,
          ads: (a.ads?.data || []).map((ad) => ({
            id: ad.id,
            name: ad.name || ad.id,
            status: ad.status || null,
          })),
        })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return res.status(200).json({
      view,
      viewLabel: VIEWS[view].label,
      granularity: hourly ? 'hour' : 'day',
      // Tells the client the daily series is split per ad rather than merged.
      // The client draws one line per entity only when the server actually
      // split the rows. Naming which split happened keeps that decision in one
      // place instead of being re-derived from the request.
      seriesLevel: scope.adIds ? 'ad' : splitByAdset ? 'adset' : 'aggregate',
      // Which conversion event this account is scored on. Fixed by the account,
      // reported so the figure can never be read as the other kind.
      conversionFamily,
      /* 'aggregate' when the totals came from Meta's own one-row figure for
         the window — the fresh path, and the normal one. 'daily-sum' when Meta
         returned no aggregate row and the daily series had to answer. */
      totalsSource,
      /* What the PIXEL saw, against what Insights could attribute. Null
         whenever it could not be read, which the UI shows as unavailable
         rather than as zero. */
      pixelTotal,
      /* The whole account, all time, unfiltered — what the tiles are a subset
         of. Null when the request was already exactly that, so the client must
         treat its absence as "nothing narrower is being shown". */
      lifetime,
      /* Conversions added by hand because Meta cannot attribute them. Always
         reported, applied or not — the page discloses this above the tiles and
         must never be able to show an adjusted figure without saying so. */
      manualConversions,
      // With date_preset the day is whatever the account's timezone says, so
      // the range is read back off a returned row rather than assumed.
      resolvedFromAccountTimezone: useToday,
      // The variable NAME only — so it is possible to tell which credential
      // answered without any part of the credential leaving the server.
      tokenSource: tokenHit.envName,
      account: accountId,
      apiVersion: API_VERSION,
      level,
      range: resolved,
      // What was asked for, alongside what it resolved to — a lifetime range
      // that came back as three days means the account is three days old, not
      // that something failed.
      rangePreset: useMaximum ? 'maximum' : useToday ? 'today' : null,
      requestedRange: { since, until },
      scope: {
        campaignId: scope.campaignId || null,
        campaignIds: scope.campaignIds || null,
        adsetId: scope.adsetId || null,
        adsetIds: scope.adsetIds || null,
      },
      campaigns,
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
