// Cash flow for the Peps by Dave business.
//
// GET -> { revenue, expenses, totals, adSpend, warnings }
//
// The ad spend half is LIVE. It is projected from the budgets currently set on
// the campaigns and ad sets in Meta, which is what makes changing a budget in
// Ads Manager change this page. It is deliberately not "last month's spend" —
// the question this page answers is what the business is committed to spending
// now, not what it already spent.
//
// Month-to-date actual spend is fetched alongside it, because a projection with
// nothing to check it against is a guess with a decimal point.

import { requireSession, noStore } from '../lib/auth.js';
import {
  daysInCurrentMonth,
  manualFigures,
  sumAmounts,
} from '../lib/finance/config.js';

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

export default async function handler(req, res) {
  noStore(res);
  const session = requireSession(req, res);
  if (!session) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
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
  const manual = manualFigures();
  const days = daysInCurrentMonth();

  try {
    // The budget tree. Budgets can sit on the campaign (campaign budget
    // optimisation) OR on each ad set, never meaningfully on both, so both
    // levels are read and the campaign wins where it has one.
    const treeUrl = new URL(`${GRAPH}/${API_VERSION}/${accountId}/campaigns`);
    treeUrl.searchParams.set(
      'fields',
      'id,name,status,effective_status,daily_budget,lifetime_budget,' +
        'adsets.limit(200){id,name,status,effective_status,daily_budget,lifetime_budget}',
    );
    treeUrl.searchParams.set('limit', '200');
    treeUrl.searchParams.set('access_token', token.value);

    // Month to date actual, as a sanity check against the projection.
    const now = new Date();
    const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
    const today = now.toISOString().slice(0, 10);

    const spendUrl = new URL(`${GRAPH}/${API_VERSION}/${accountId}/insights`);
    spendUrl.searchParams.set('fields', 'spend');
    spendUrl.searchParams.set('level', 'account');
    spendUrl.searchParams.set('time_range', JSON.stringify({ since: monthStart, until: today }));
    spendUrl.searchParams.set('access_token', token.value);

    const [treeResp, spendResp] = await Promise.all([fetch(treeUrl), fetch(spendUrl)]);
    const tree = await treeResp.json().catch(() => ({}));
    const spendJson = await spendResp.json().catch(() => ({}));

    if (!treeResp.ok || tree.error) {
      const msg = tree?.error?.message || `Meta returned HTTP ${treeResp.status}.`;
      return res.status(502).json({ error: 'meta_error', message: scrubSecrets(msg) });
    }

    const monthToDate = Number(spendJson?.data?.[0]?.spend) || 0;

    // Walk the tree once, collecting every budget that can actually spend.
    const lines = [];
    let dailyTotal = 0;
    let lifetimeTotal = 0;

    for (const c of tree.data || []) {
      const campaignLive = isLive(c.effective_status || c.status);
      const campaignDaily = minorToMajor(c.daily_budget);
      const campaignLifetime = minorToMajor(c.lifetime_budget);

      if (campaignDaily > 0 || campaignLifetime > 0) {
        // Campaign budget optimisation: the campaign holds the budget and its
        // ad sets do not, so counting both would double the figure.
        if (campaignLive) {
          dailyTotal += campaignDaily;
          lifetimeTotal += campaignLifetime;
        }
        lines.push({
          level: 'campaign',
          id: c.id,
          name: c.name,
          status: c.effective_status || c.status,
          live: campaignLive,
          daily: campaignDaily,
          lifetime: campaignLifetime,
          monthly: campaignLive ? campaignDaily * days : 0,
        });
        continue;
      }

      for (const a of c.adsets?.data || []) {
        const adsetLive = campaignLive && isLive(a.effective_status || a.status);
        const d = minorToMajor(a.daily_budget);
        const l = minorToMajor(a.lifetime_budget);
        if (d === 0 && l === 0) continue;
        if (adsetLive) {
          dailyTotal += d;
          lifetimeTotal += l;
        }
        lines.push({
          level: 'adset',
          id: a.id,
          name: `${c.name} / ${a.name}`,
          status: adsetLive ? 'ACTIVE' : a.effective_status || a.status,
          live: adsetLive,
          daily: d,
          lifetime: l,
          monthly: adsetLive ? d * days : 0,
        });
      }
    }

    const projectedAdSpend = dailyTotal * days;

    if (lifetimeTotal > 0) {
      warnings.push(
        `${lines.filter((l) => l.lifetime > 0 && l.live).length} active item(s) use a lifetime budget ` +
          `totalling ${lifetimeTotal.toFixed(2)}. A lifetime budget is a total, not a monthly rate, ` +
          'so it is listed but not included in the monthly projection.',
      );
    }
    if (dailyTotal === 0) {
      warnings.push(
        'No active daily budgets were found, so the projected monthly ad spend is zero. ' +
          'That is correct if everything is paused.',
      );
    }

    /* ------------------------------------------------------------ assemble */
    const revenue = [
      {
        id: 'skool',
        label: 'Skool community',
        amount: manual.skoolMrr,
        source: 'manual',
        note:
          'Skool has no public API — no REST, no webhooks, no analytics export — so this figure ' +
          `is entered rather than fetched. Set in ${manual.skoolMrrSource}.`,
      },
      ...manual.otherRevenue.map((r) => ({ ...r, source: 'manual' })),
    ];

    const expenses = [
      {
        id: 'meta-ads',
        label: 'Meta ad spend (projected)',
        amount: projectedAdSpend,
        source: 'live',
        note:
          `${dailyTotal.toFixed(2)} a day across ${lines.filter((l) => l.live).length} active ` +
          `item(s), over ${days} days this month. Changing a budget in Ads Manager changes this.`,
      },
      ...manual.recurringCosts.map((c) => ({ ...c, source: 'manual' })),
    ];

    const revenueTotal = sumAmounts(revenue);
    const expenseTotal = sumAmounts(expenses);

    return res.status(200).json({
      currency: 'USD',
      daysInMonth: days,
      revenue,
      expenses,
      totals: {
        revenue: revenueTotal,
        expenses: expenseTotal,
        net: revenueTotal - expenseTotal,
        // Margin is undefined rather than zero when nothing is coming in.
        margin: revenueTotal > 0 ? ((revenueTotal - expenseTotal) / revenueTotal) * 100 : null,
      },
      adSpend: {
        dailyTotal,
        projectedMonthly: projectedAdSpend,
        monthToDate,
        lifetimeTotal,
        lines: lines.sort((a, b) => b.monthly - a.monthly || a.name.localeCompare(b.name)),
      },
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
