// Cash flow for the Peps by Dave business.
//
// GET  -> the figures.
// POST -> the same figures, having first pushed them into the Google Sheet.
//
// The ad spend half is LIVE and has two parts, because the question "what does
// this month cost" has two: what has already gone out, and what the budgets
// currently set in Ads Manager will spend over the days that are left. Adding a
// new ad set therefore shows up immediately in the forward half and then moves
// into the spent half as it delivers.
//
// The revenue half cannot be fetched — Skool has no public API — so it is typed
// into the sheet and every line carries whether it was read or entered.

import { requireSession, noStore } from '../lib/auth.js';
import {
  daysInMonthOf,
  isIncluded,
  includeList,
  manualFigures,
  sumAmounts,
  todayIn,
} from '../lib/finance/config.js';
import {
  embedUrl,
  missingSheetEnv,
  openUrl,
  readEntered,
  sheetsConfig,
  syncSheet,
} from '../lib/finance/sheets.js';

const API_VERSION = process.env.META_API_VERSION || 'v23.0';
const GRAPH = 'https://graph.facebook.com';

/** The finances page is Dave's, so it reads Dave's ad account. */
const ACCOUNT_ENV = ['META_AD_ACCOUNT_ID', 'META_ADS_ACCOUNT_ID'];
const TOKEN_ENV = ['META_ADS_TOKEN_DAVE', 'META_ADS_TOKEN'];

function firstEnv(names, env = process.env) {
  for (const n of names) {
    const v = String(env[n] || '').trim();
    if (v) return { name: n, value: v };
  }
  return null;
}

function scrubSecrets(text) {
  if (typeof text !== 'string') return text;
  let out = text.replace(/access_token=[^&\s]*/gi, 'access_token=REDACTED');
  for (const n of TOKEN_ENV) {
    const v = String(process.env[n] || '').trim();
    if (v.length > 8) out = out.split(v).join('REDACTED');
  }
  // The service-account key must never reach a browser either. Google echoes
  // credential fragments back in its error text, so this scrubs the key LINE BY
  // LINE rather than as one blob: a message quoting a single line of the PEM
  // would sail straight past a whole-value match.
  const key = String(process.env.GOOGLE_SHEETS_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  for (const line of key.split(/\r?\n/)) {
    const chunk = line.trim();
    if (chunk.length >= 12 && !chunk.startsWith('---')) out = out.split(chunk).join('REDACTED');
  }
  return out;
}

/**
 * Meta returns budgets in MINOR UNITS. A daily_budget of "1000" on a USD
 * account is ten dollars, not a thousand. Getting this wrong overstates the
 * business's costs by a hundred times, which is the single most expensive
 * mistake available on this page.
 */
function minorToMajor(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n / 100 : 0;
}

/** Only things actually able to spend money count toward a projection. */
function isLive(status) {
  return status === 'ACTIVE';
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * The namespace a spreadsheet cell can reach with =META("...").
 *
 * Flat and string-keyed on purpose: a formula names one figure, and a nested
 * path would mean writing a path parser into the sheet engine to reach it.
 * Every key here is a promise — renaming one silently turns somebody's cell
 * into #NAME?, so add keys freely and rename them never.
 */
export function metaNamespace(adSpend) {
  const ns = {
    'adSpend.monthToDate': adSpend.monthToDate,
    'adSpend.dailyTotal': adSpend.dailyTotal,
    'adSpend.projectedRemainder': adSpend.projectedRemainder,
    'adSpend.expectedMonthTotal': adSpend.expectedMonthTotal,
    'adSpend.lifetimeTotal': adSpend.lifetimeTotal,
    'adSpend.daysInMonth': adSpend.daysInMonth,
    'adSpend.daysRemaining': adSpend.daysRemaining,
    'adSpend.daysElapsed': adSpend.daysElapsed,
    'adSpend.activeLines': adSpend.lines.filter((l) => l.live).length,
    'adSpend.timeZone': adSpend.timeZone,
  };
  // Per line, addressable by name, so a sheet can break spend out by ad set
  // without anyone hand-copying figures across.
  for (const l of adSpend.lines) {
    ns['spent:' + l.name] = l.spent;
    ns['daily:' + l.name] = l.live ? l.daily : 0;
    ns['expected:' + l.name] = l.expected;
  }
  return ns;
}

export default async function handler(req, res) {
  noStore(res);
  const session = requireSession(req, res);
  if (!session) return;

  const method = req.method === 'POST' ? 'POST' : 'GET';
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const account = firstEnv(ACCOUNT_ENV);
  const token = firstEnv(TOKEN_ENV);
  if (!account || !token) {
    return res.status(500).json({
      error: 'server_misconfigured',
      message: `Missing ${!token ? TOKEN_ENV[0] : ACCOUNT_ENV[0]} for the finances page.`,
    });
  }
  const accountId = account.value.startsWith('act_') ? account.value : `act_${account.value}`;

  const warnings = [];
  let manual = manualFigures();

  try {
    /* ------------------------------------------------------------- meta ---- */

    // The account itself, for its timezone and currency. Meta reports on the
    // account's timezone, so counting the days left in the month from this
    // server's clock would be wrong for most of every day.
    const acctUrl = new URL(`${GRAPH}/${API_VERSION}/${accountId}`);
    acctUrl.searchParams.set('fields', 'timezone_name,currency');
    acctUrl.searchParams.set('access_token', token.value);

    // The budget tree, with no date range: a brand new ad set has never
    // delivered, and asking Insights for it would leave it invisible on exactly
    // the day someone wants to watch it start.
    const treeUrl = new URL(`${GRAPH}/${API_VERSION}/${accountId}/campaigns`);
    treeUrl.searchParams.set(
      'fields',
      'id,name,status,effective_status,daily_budget,lifetime_budget,' +
        'adsets.limit(200){id,name,status,effective_status,daily_budget,lifetime_budget}',
    );
    treeUrl.searchParams.set('limit', '200');
    treeUrl.searchParams.set('access_token', token.value);

    // Spend so far, per ad set, so it can be attributed to the same lines the
    // budgets came from. `this_month` is resolved by Meta in the account's
    // timezone, which is the same basis Ads Manager reports on.
    const spendUrl = new URL(`${GRAPH}/${API_VERSION}/${accountId}/insights`);
    spendUrl.searchParams.set('fields', 'spend,campaign_id,adset_id');
    spendUrl.searchParams.set('level', 'adset');
    spendUrl.searchParams.set('date_preset', 'this_month');
    spendUrl.searchParams.set('limit', '500');
    spendUrl.searchParams.set('use_unified_attribution_setting', 'true');
    spendUrl.searchParams.set('access_token', token.value);

    const [acctResp, treeResp, spendResp] = await Promise.all([
      fetch(acctUrl), fetch(treeUrl), fetch(spendUrl),
    ]);
    const acct = await acctResp.json().catch(() => ({}));
    const tree = await treeResp.json().catch(() => ({}));
    const spendJson = await spendResp.json().catch(() => ({}));

    if (!treeResp.ok || tree.error) {
      const msg = tree?.error?.message || `Meta returned HTTP ${treeResp.status}.`;
      return res.status(502).json({ error: 'meta_error', message: scrubSecrets(msg) });
    }

    const timeZone = acct?.timezone_name || 'UTC';
    const currency = acct?.currency || 'USD';

    const today = todayIn(timeZone);
    const daysInMonth = daysInMonthOf(today);
    // Whole days still to come. Today is excluded because month-to-date spend
    // already covers the part of it that has happened; the rest of today is the
    // small, deliberate understatement noted in the UI.
    const daysRemaining = Math.max(0, daysInMonth - today.day);

    // Spend indexed by ad set, and rolled up per campaign for CBO lines.
    const spentByAdset = new Map();
    const spentByCampaign = new Map();
    for (const row of spendJson?.data || []) {
      const amt = Number(row.spend) || 0;
      if (row.adset_id) spentByAdset.set(row.adset_id, (spentByAdset.get(row.adset_id) || 0) + amt);
      if (row.campaign_id) {
        spentByCampaign.set(row.campaign_id, (spentByCampaign.get(row.campaign_id) || 0) + amt);
      }
    }

    /* ------------------------------------------------- walk the budget tree */
    const all = [];
    for (const c of tree.data || []) {
      const campaignLive = isLive(c.effective_status || c.status);
      const campaignDaily = minorToMajor(c.daily_budget);
      const campaignLifetime = minorToMajor(c.lifetime_budget);

      if (campaignDaily > 0 || campaignLifetime > 0) {
        // Campaign budget optimisation: the campaign holds the budget and its
        // ad sets hold none, so counting both levels would double the figure.
        all.push({
          level: 'campaign',
          id: c.id,
          name: c.name,
          status: c.effective_status || c.status,
          live: campaignLive,
          daily: campaignDaily,
          lifetime: campaignLifetime,
          spent: round2(spentByCampaign.get(c.id) || 0),
        });
        continue;
      }

      for (const a of c.adsets?.data || []) {
        const adsetLive = campaignLive && isLive(a.effective_status || a.status);
        const daily = minorToMajor(a.daily_budget);
        const lifetime = minorToMajor(a.lifetime_budget);
        const spent = round2(spentByAdset.get(a.id) || 0);
        // A line with no budget and no spend is noise, not information.
        if (daily === 0 && lifetime === 0 && spent === 0) continue;
        all.push({
          level: 'adset',
          id: a.id,
          name: `${c.name} / ${a.name}`,
          status: adsetLive ? 'ACTIVE' : a.effective_status || a.status,
          live: adsetLive,
          daily,
          lifetime,
          spent,
        });
      }
    }

    /* --------------------------------------------------- apply the filter */
    // A list that matches nothing is a typo, not an instruction to show an
    // empty page — so it is reported with the real names instead of obeyed.
    const include = includeList();
    let lines = all.filter((l) => isIncluded(l.name, include));
    const filterActive = include.length > 0;
    if (filterActive && lines.length === 0 && all.length > 0) {
      lines = all;
      warnings.push(
        'The AD_SPEND_INCLUDE filter matched nothing, so every line is shown. ' +
          'Meta returned: ' + all.map((l) => l.name).join('; ') + '.',
      );
    } else if (filterActive && all.length > lines.length) {
      const hidden = all.filter((l) => !isIncluded(l.name, include));
      const hiddenSpend = round2(hidden.reduce((s, l) => s + l.spent, 0));
      const hiddenDaily = round2(hidden.filter((l) => l.live).reduce((s, l) => s + l.daily, 0));
      // Excluded work is named rather than silently dropped: a hidden line that
      // is still spending would otherwise make this page disagree with the bill.
      warnings.push(
        `${hidden.length} campaign/ad set(s) are excluded by AD_SPEND_INCLUDE` +
          (hiddenSpend || hiddenDaily
            ? ` and are still spending (${hiddenSpend.toFixed(2)} so far this month, ` +
              `${hiddenDaily.toFixed(2)} a day active). They are NOT in the totals below.`
            : ' and none of them are spending.'),
      );
    }

    /* ------------------------------------------------------------- totals */
    let dailyTotal = 0;
    let lifetimeTotal = 0;
    let monthToDate = 0;

    for (const l of lines) {
      monthToDate += l.spent;
      if (l.live) {
        dailyTotal += l.daily;
        lifetimeTotal += l.lifetime;
      }
      l.projected = l.live ? round2(l.daily * daysRemaining) : 0;
      l.expected = round2(l.spent + l.projected);
    }
    monthToDate = round2(monthToDate);
    dailyTotal = round2(dailyTotal);
    lifetimeTotal = round2(lifetimeTotal);

    const projectedRemainder = round2(dailyTotal * daysRemaining);
    const expectedMonthTotal = round2(monthToDate + projectedRemainder);

    if (lifetimeTotal > 0) {
      warnings.push(
        `Active items carry ${lifetimeTotal.toFixed(2)} of lifetime budget. A lifetime budget ` +
          'is a total for the whole run rather than a monthly rate, so it is listed but not ' +
          'projected into the rest of the month.',
      );
    }

    lines.sort((a, b) => b.expected - a.expected || a.name.localeCompare(b.name));

    const adSpend = {
      dailyTotal,
      monthToDate,
      projectedRemainder,
      expectedMonthTotal,
      lifetimeTotal,
      daysInMonth,
      daysRemaining,
      daysElapsed: today.day,
      timeZone,
      filtered: filterActive,
      totalLines: all.length,
      lines,
    };

    /* -------------------------------------------------------- the sheet ---- */
    const cfg = sheetsConfig();
    const sheet = {
      configured: !!cfg,
      missing: cfg ? [] : missingSheetEnv(),
      embedUrl: cfg ? embedUrl(cfg.spreadsheetId) : null,
      openUrl: cfg ? openUrl(cfg.spreadsheetId) : null,
      synced: false,
      error: null,
    };

    let revenue;
    let expenses;

    const adSpendLine = {
      id: 'meta-ads',
      label: 'Meta ad spend',
      amount: expectedMonthTotal,
      source: 'live',
      note:
        `${monthToDate.toFixed(2)} already spent, plus ${projectedRemainder.toFixed(2)} projected ` +
        `from ${dailyTotal.toFixed(2)} a day over the ${daysRemaining} day(s) left in the month ` +
        `(${timeZone}). Changing a budget in Ads Manager changes this.`,
    };

    if (cfg) {
      try {
        // POST syncs and reads back; GET only reads, so opening the page never
        // writes to the user's sheet as a side effect of looking at it.
        const entered = method === 'POST'
          ? await syncSheet(cfg, { adSpend, fetchedAt: new Date().toISOString() }, manual)
          : await readEntered(cfg);
        sheet.synced = method === 'POST';
        revenue = entered.revenue;
        expenses = [adSpendLine, ...entered.expenses];
      } catch (e) {
        // A sheet that cannot be reached must not take the whole page down —
        // the live half is still worth showing, clearly labelled as incomplete.
        sheet.error = scrubSecrets(e.message || 'Could not reach the Google Sheet.');
        warnings.push('The Google Sheet could not be read, so the entered figures below are the ' +
          'fallback values from lib/finance/config.js, not the sheet.');
      }
    }

    if (!revenue) {
      revenue = [
        {
          id: 'skool',
          label: 'Skool community',
          amount: manual.skoolMrr,
          source: 'manual',
          note: cfg
            ? 'Fallback value — the sheet could not be read.'
            : `Skool has no public API, so this is entered. Currently from ${manual.skoolMrrSource}.`,
        },
        ...manual.otherRevenue.map((r) => ({ ...r, source: 'manual' })),
      ];
      expenses = [adSpendLine, ...manual.recurringCosts.map((c) => ({ ...c, source: 'manual' }))];
    }

    const metaValues = metaNamespace(adSpend);

    const revenueTotal = round2(sumAmounts(revenue));
    const expenseTotal = round2(sumAmounts(expenses));

    return res.status(200).json({
      currency,
      daysInMonth,
      revenue,
      expenses,
      totals: {
        revenue: revenueTotal,
        expenses: expenseTotal,
        net: round2(revenueTotal - expenseTotal),
        // Margin is undefined rather than zero when nothing is coming in.
        margin: revenueTotal > 0 ? ((revenueTotal - expenseTotal) / revenueTotal) * 100 : null,
      },
      adSpend,
      // What a spreadsheet cell can reach with =META("..."). Sent on every
      // load so the figures in the ledger are as fresh as the ones above it.
      meta: metaValues,
      metaKeys: Object.keys(metaValues),
      sheet,
      warnings,
      fetchedAt: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(502).json({
      error: 'network_error',
      message: 'Could not reach Meta to read the current budgets.',
    });
  }
}
