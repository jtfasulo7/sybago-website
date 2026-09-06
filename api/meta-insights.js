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
  },
  sybago: {
    label: 'Montara Forge',
    env: ['META_ADS_ACCOUNT_ID_SYBAGO', 'META_AD_ACCOUNT_ID_SYBAGO'],
    tokenEnv: ['META_ADS_TOKEN_SYBAGO', 'META_ADS_TOKEN'],
    masterOnly: true,
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

// Meta reports the same registration under a pixel-specific alias and
// sometimes a generic one. Take the FIRST that is present — never sum, or the
// same conversion is counted twice.
const REGISTRATION_TYPES = [
  'offsite_conversion.fb_pixel_complete_registration',
  'complete_registration',
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

function extractMetrics(actions, costPer, actionValues) {
  const byType = new Map((actions || []).map((a) => [a.action_type, num(a.value)]));
  const costByType = new Map((costPer || []).map((a) => [a.action_type, num(a.value)]));
  const valueByType = new Map((actionValues || []).map((a) => [a.action_type, num(a.value)]));

  return {
    registration: pull(REGISTRATION_TYPES, byType, costByType, valueByType),
    landingPageView: pull(LANDING_PAGE_VIEW_TYPES, byType, costByType, valueByType),
  };
}

function shapeRow(r, level) {
  const m = extractMetrics(r.actions, r.cost_per_action_type, r.action_values);
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
    adId: r.ad_id || null,
    adName: r.ad_name || null,
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
  const time_range = { since, until };
  const period = useToday ? { date_preset: 'today' } : { time_range };

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
  if (/^\d+$/.test(req.query.campaignId || '')) scope.campaignId = req.query.campaignId;
  if (/^\d+$/.test(req.query.adsetId || '')) scope.adsetId = req.query.adsetId;
  // Comma separated ad ids. Anything non-numeric is dropped rather than passed
  // through, same rule as the campaign and ad set ids.
  const adIds = String(req.query.adIds || '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => /^\d+$/.test(x))
    .slice(0, 20);
  if (adIds.length) scope.adIds = adIds;

  const filtering = [];
  // Ads are the narrowest scope, so they win over the ad set and campaign.
  if (scope.adIds) {
    filtering.push({ field: 'ad.id', operator: 'IN', value: scope.adIds });
  } else if (scope.adsetId) {
    filtering.push({ field: 'adset.id', operator: 'IN', value: [scope.adsetId] });
  } else if (scope.campaignId) {
    filtering.push({ field: 'campaign.id', operator: 'IN', value: [scope.campaignId] });
  }
  const filterParam = filtering.length ? { filtering } : {};

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

  try {
    // A third request fetches the campaign/ad set list for the picker. It is
    // unscoped on purpose — the dropdown must still offer every option even
    // when the view is filtered down to one of them.
    const [breakdown, series, picker] = await Promise.all([
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
          level: scope.adIds ? 'ad' : scope.adsetId ? 'adset' : scope.campaignId ? 'campaign' : 'account',
          // Ad name comes along when the series is per-ad, so the client can
          // draw one line per ad rather than one merged line.
          fields: (scope.adIds ? ['ad_id', 'ad_name', ...BASE_FIELDS] : BASE_FIELDS).join(','),
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
        buildUrl(accountId, {
          // Ad level, so the picker can offer individual ads. One level
          // deeper than the scoping needs, but it is the same single request.
          level: 'ad',
          fields: 'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name',
          ...period,
          limit: '500',
        }, token),
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
        knownRegistrationTypes: REGISTRATION_TYPES,
        knownLandingPageViewTypes: LANDING_PAGE_VIEW_TYPES,
        unifiedAttribution: true,
        actionTypes: [...tally.values()].sort((a, b) => b.daily - a.daily || b.breakdown - a.breakdown),
      });
    }

    const rows = (breakdown.json.data || []).map((r) => shapeRow(r, level));
    const daily = (series.json.data || [])
      .map((r) => shapeRow(r, 'account'))
      .sort((a, b) => {
        // With several ads there are multiple rows per period, so the ad is the
        // primary key and time is the secondary one.
        if (a.adId !== b.adId) return String(a.adId).localeCompare(String(b.adId));
        return hourly ? (a.hour ?? 0) - (b.hour ?? 0) : a.dateStart < b.dateStart ? -1 : 1;
      });

    // Totals are summed from the daily series rather than the breakdown, so the
    // headline numbers stay correct regardless of which level is selected.
    // Each metric is summed only against itself. Nothing is combined across
    // action types.
    const totals = daily.reduce(
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

    // Options for the picker: every campaign, each with its ad sets.
    const byCampaign = new Map();
    for (const r of picker.json.data || []) {
      if (!r.campaign_id) continue;
      if (!byCampaign.has(r.campaign_id)) {
        byCampaign.set(r.campaign_id, { id: r.campaign_id, name: r.campaign_name || r.campaign_id, adsets: [] });
      }
      if (!r.adset_id) continue;
      const c = byCampaign.get(r.campaign_id);
      let adset = c.adsets.find((a) => a.id === r.adset_id);
      if (!adset) {
        adset = { id: r.adset_id, name: r.adset_name || r.adset_id, ads: [] };
        c.adsets.push(adset);
      }
      if (r.ad_id && !adset.ads.some((a) => a.id === r.ad_id)) {
        adset.ads.push({ id: r.ad_id, name: r.ad_name || r.ad_id });
      }
    }
    const campaigns = [...byCampaign.values()].sort((a, b) => a.name.localeCompare(b.name));

    return res.status(200).json({
      view,
      viewLabel: VIEWS[view].label,
      granularity: hourly ? 'hour' : 'day',
      // Tells the client the daily series is split per ad rather than merged.
      seriesLevel: scope.adIds ? 'ad' : 'aggregate',
      // With date_preset the day is whatever the account's timezone says, so
      // the range is read back off a returned row rather than assumed.
      resolvedFromAccountTimezone: useToday,
      // The variable NAME only — so it is possible to tell which credential
      // answered without any part of the credential leaving the server.
      tokenSource: tokenHit.envName,
      account: accountId,
      apiVersion: API_VERSION,
      level,
      range: { since, until },
      scope: {
        campaignId: scope.campaignId || null,
        adsetId: scope.adsetId || null,
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
