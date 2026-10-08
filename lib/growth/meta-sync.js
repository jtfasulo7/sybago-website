// Sync Meta's daily per-ad history into storage.
//
// READ-ONLY BY CONSTRUCTION. Every request here is a GET against /insights or
// a management edge. Nothing in this file can pause an ad or move a budget,
// and it must stay that way — changing a campaign is a decision for a person.
//
// Why store it at all, when api/meta-insights.js already reads Meta live?
// Because the Growth Timeline compares ad delivery with membership over
// months, at ad level, on every render — and because history that lives only
// behind a third-party API is history that can be truncated. Meta keeps 37 months.

import {
  API_VERSION, resolveAccount, resolveToken, fetchWithBackoff, extractMetrics, scrubSecrets,
} from '../../api/meta-insights.js';

const VIEW = 'dave';
const GRAPH = 'https://graph.facebook.com';

/* Recent days keep settling as attribution fills in, so every sync re-reads
   this many days and replaces what it had. */
export const RESYNC_DAYS = 35;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function url(path, params, token) {
  const u = new URL(`${GRAPH}/${API_VERSION}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) u.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  u.searchParams.set('access_token', token);   // appended last, never logged
  return u.toString();
}

/** Follow Meta's cursor paging to the end, with a ceiling so a loop cannot run away. */
async function fetchAll(first, env, maxPages = 60) {
  const rows = [];
  let next = first;
  for (let page = 0; next && page < maxPages; page++) {
    const { json } = await fetchWithBackoff(next, { env });
    for (const r of json.data || []) rows.push(r);
    next = json.paging && json.paging.next ? json.paging.next : null;
  }
  return rows;
}

/** One stored row. Positional, because there are a great many of them. */
export function shapeDaily(r) {
  const m = extractMetrics(r.actions, r.cost_per_action_type, r.action_values, 'registration');
  return [
    r.date_start, r.ad_id, Math.round(num(r.spend) * 100) / 100, num(r.impressions), num(r.reach),
    num(r.clicks), num(r.inline_link_clicks), num(m.landingPageView.count), num(m.registration.count),
  ];
}

/**
 * Merge freshly fetched rows over stored ones. A fetched window REPLACES the
 * same window in storage: a day Meta no longer reports for an ad is dropped,
 * and a day it has revised is revised here too.
 */
export function mergeDaily(existing, fresh, since) {
  const kept = (existing || []).filter((r) => !since || r[0] < since);
  const seen = new Set(kept.map((r) => r[0] + '|' + r[1]));
  for (const r of fresh) {
    const k = r[0] + '|' + r[1];
    if (seen.has(k)) continue;
    seen.add(k);
    kept.push(r);
  }
  kept.sort((a, b) => (a[0] === b[0] ? String(a[1]).localeCompare(String(b[1])) : a[0].localeCompare(b[0])));
  return kept;
}

const isoDaysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

/**
 * @param stored  the previous meta document, or null on a first sync
 * @param opts    { full: true } forces the whole history to be re-read
 */
export async function syncMeta(stored, opts = {}) {
  const account = resolveAccount(VIEW);
  const token = resolveToken(VIEW);
  const env = { tokenEnv: token.envName, accountEnv: account.envName };
  if (!account.id || !token.value) {
    const err = new Error(`Meta is not connected: set ${!token.value ? token.envName : account.envName} on this deployment.`);
    err.code = 'meta_unconfigured';
    throw err;
  }

  const full = !!opts.full || !stored || !(stored.daily && stored.daily.length);
  const since = full ? null : isoDaysAgo(RESYNC_DAYS);
  const range = full ? { date_preset: 'maximum' } : { time_range: { since, until: isoDaysAgo(-1) } };

  const insights = await fetchAll(url(`${account.id}/insights`, {
    level: 'ad',
    time_increment: 1,
    fields: 'ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,impressions,reach,clicks,inline_link_clicks,actions,date_start,date_stop',
    use_unified_attribution_setting: 'true',
    limit: 500,
    ...range,
  }, token.value), env);

  const fresh = insights.filter((r) => DAY_RE.test(String(r.date_start)) && r.ad_id).map(shapeDaily);

  /* Names and structure, taken from the insight rows first — they exist for
     every ad that ever delivered, including ones since deleted — then enriched
     from the /ads edge, which knows current status and creation time. */
  const ads = { ...((stored && stored.ads) || {}) };
  for (const r of insights) {
    if (!r.ad_id) continue;
    ads[r.ad_id] = {
      ...(ads[r.ad_id] || {}),
      name: r.ad_name || (ads[r.ad_id] && ads[r.ad_id].name) || r.ad_id,
      adsetId: r.adset_id || null, adsetName: r.adset_name || null,
      campaignId: r.campaign_id || null, campaignName: r.campaign_name || null,
    };
  }

  const warnings = [];
  try {
    const list = await fetchAll(url(`${account.id}/ads`, {
      fields: 'id,name,status,effective_status,created_time,updated_time,adset{id,name},campaign{id,name}',
      limit: 200,
    }, token.value), env, 20);
    for (const a of list) {
      const was = ads[a.id] || {};
      ads[a.id] = {
        ...was,
        name: a.name || was.name || a.id,
        adsetId: (a.adset && a.adset.id) || was.adsetId || null,
        adsetName: (a.adset && a.adset.name) || was.adsetName || null,
        campaignId: (a.campaign && a.campaign.id) || was.campaignId || null,
        campaignName: (a.campaign && a.campaign.name) || was.campaignName || null,
        status: a.status || null, effectiveStatus: a.effective_status || null,
        createdDay: a.created_time ? String(a.created_time).slice(0, 10) : null,
        updatedAt: a.updated_time || null,
      };
    }
  } catch (e) {
    warnings.push('Could not read current ad status: ' + scrubSecrets(e.message));
  }

  let info = (stored && stored.account) || { id: account.id };
  try {
    const { json } = await fetchWithBackoff(url(account.id, { fields: 'name,currency,timezone_name' }, token.value), { env });
    info = { id: account.id, name: json.name || null, currency: json.currency || null, timezone: json.timezone_name || null };
  } catch (e) {
    warnings.push('Could not read the ad account profile: ' + scrubSecrets(e.message));
  }

  /* When ads were switched on and off, from the account activity log. This is
     the only source of an explicit pause or resume time; without it the page
     still shows delivery gaps, which is the same fact seen from the other
     side. The edge is not always populated, so a failure here is a note and
     never a failed sync. */
  let statusChanges = [...((stored && stored.statusChanges) || [])];
  try {
    const acts = await fetchAll(url(`${account.id}/activities`, {
      fields: 'event_type,event_time,object_id,object_name,extra_data',
      since: since || isoDaysAgo(365 * 3),
      limit: 500,
    }, token.value), env, 10);
    const key = (c) => `${c.at}|${c.objectId}|${c.to}`;
    const have = new Set(statusChanges.map(key));
    for (const a of acts) {
      if (!/run_status/i.test(String(a.event_type))) continue;
      let extra = {};
      try { extra = typeof a.extra_data === 'string' ? JSON.parse(a.extra_data) : a.extra_data || {}; } catch { extra = {}; }
      const c = {
        at: a.event_time, objectId: a.object_id, name: a.object_name || null,
        level: /campaign/i.test(a.event_type) ? 'campaign' : /ad_set|adset/i.test(a.event_type) ? 'adset' : 'ad',
        from: extra.old_value != null ? String(extra.old_value) : null,
        to: extra.new_value != null ? String(extra.new_value) : null,
      };
      if (!have.has(key(c))) { have.add(key(c)); statusChanges.push(c); }
    }
    statusChanges.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    statusChanges = statusChanges.slice(-2000);
  } catch (e) {
    warnings.push('Pause and resume times are unavailable from the activity log; delivery gaps are shown instead.');
  }

  /* A full sync replaces everything Meta still reports and KEEPS anything
     older: Meta's history is capped at 37 months, and a day that has aged out
     of their API is exactly the day this store exists to preserve. */
  const cut = full ? fresh.reduce((lo, r) => (!lo || r[0] < lo ? r[0] : lo), null) : since;
  const daily = cut ? mergeDaily(stored && stored.daily, fresh, cut) : (stored && stored.daily) || [];
  const syncedAt = new Date().toISOString();
  const log = [...((stored && stored.log) || []), {
    at: syncedAt, mode: full ? 'full history' : `last ${RESYNC_DAYS} days`, rows: fresh.length, ads: Object.keys(ads).length,
    trigger: opts.trigger || 'manual', warnings,
  }].slice(-60);

  return {
    account: info, ads, daily, statusChanges,
    // Recorded so a figure can always be traced to the rules it was counted under.
    attribution: 'Ad set attribution setting (use_unified_attribution_setting=true); conversions = CompleteRegistration',
    apiVersion: API_VERSION,
    tokenSource: token.envName,          // the variable NAME only
    syncedAt, log,
  };
}
