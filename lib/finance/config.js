// Recurring money in and out for the Peps by Dave business.
//
// Two kinds of figure appear on the finances page and they are kept visibly
// apart, because trusting a stale number is worse than seeing an empty one:
//
//   LIVE   — read from Meta on every refresh. Ad spend is what has actually
//            been spent this month so far, plus what the budgets currently set
//            in Ads Manager will spend over the days left in the month.
//   MANUAL — entered by hand. Skool has no public API (no REST, no webhooks,
//            no analytics export), so its revenue cannot be read.
//
// Once FINANCE_SHEET_ID is set, the MANUAL figures live in the Google Sheet and
// the values below are only the seed used to create it. Until then they are the
// figures themselves.
//
// Everything is MONTHLY and in whole currency units, not cents. Meta's API
// returns minor units and that conversion happens in api/finance.js, not here.

/**
 * Monthly recurring revenue from the Skool community.
 *
 * Overridable with the SKOOL_MRR environment variable. Once the Google Sheet is
 * connected this is superseded by the "Entered" tab, which is the point of the
 * sheet: a figure that changes monthly should be editable without a deploy.
 */
export const SKOOL_MRR_DEFAULT = 0;

/**
 * Fixed monthly costs. Anything that recurs at a steady amount belongs here;
 * anything that varies with what the business does should be read live instead.
 *
 * `note` is not decoration — six months from now it is the only thing that
 * explains why a line exists.
 */
export const RECURRING_COSTS = [
  {
    id: 'higgsfield',
    label: 'Higgsfield',
    amount: 99,
    cadence: 'monthly',
    category: 'Tooling',
    note: 'Video generation subscription.',
  },
  {
    id: 'skool',
    label: 'Skool subscription',
    amount: 99,
    cadence: 'monthly',
    category: 'Platform',
    paidBy: 'Mouayed',
    note: 'Hosts the community itself.',
  },
  {
    /* Billed yearly. The AMOUNT HERE IS THE REAL INVOICE — $24, not $2 — and
       monthlyAmount() divides it. Pre-dividing in the config would leave a
       figure nobody could reconcile against a receipt. */
    id: 'domain',
    label: 'Domain',
    amount: 24,
    cadence: 'annual',
    category: 'Platform',
    paidBy: 'JT',
    note: 'peps-by-dave domain registration.',
  },
];

/** How many times a year each cadence is billed. */
const PER_YEAR = { monthly: 12, annual: 1, yearly: 1, quarterly: 4, weekly: 52 };

/**
 * A cost's contribution to ONE month.
 *
 * The whole page is monthly, and `cadence` sat on this shape for months with
 * nothing reading it — so an annual cost would have been summed at its full
 * yearly price into a single month's total. That is a wrong number that looks
 * completely ordinary, which is the kind worth a function of its own.
 *
 * An unrecognised cadence is treated as monthly rather than dropped: showing a
 * cost in the wrong period is recoverable, silently omitting it is not.
 */
export function monthlyAmount(cost) {
  const amount = Number(cost && cost.amount) || 0;
  const perYear = PER_YEAR[String((cost && cost.cadence) || 'monthly').toLowerCase()] ?? 12;
  return Math.round((amount * perYear) / 12 * 100) / 100;
}

/**
 * A cost as the page needs it: `amount` is what it costs THIS month, with the
 * billed figure kept alongside so the detail line can say "$24 billed yearly"
 * rather than quietly showing $2 and explaining nothing.
 */
export function normaliseCost(cost) {
  const monthly = monthlyAmount(cost);
  const isMonthly = monthly === Number(cost.amount);
  return {
    ...cost,
    amount: monthly,
    billedAmount: Number(cost.amount) || 0,
    cadence: cost.cadence || 'monthly',
    note: isMonthly
      ? cost.note
      : `${cost.note ? cost.note + ' ' : ''}$${Number(cost.amount) || 0} billed ${cost.cadence}.`,
  };
}

/** Revenue that is not the Skool community. Empty until there is any. */
export const OTHER_REVENUE = [];

/**
 * Which campaigns and ad sets the finances page counts.
 *
 * An ad account accumulates tests, drafts and finished experiments, and a cash
 * flow page that lists all of them buries the two that are actually spending.
 * Each entry is matched loosely — case, punctuation and extra words between the
 * matched words are all ignored — so "Dave Campaign 1 Ad Set 1" finds
 * "Dave - Campaign 1 / Dave - Ad Set 1".
 *
 * The words must appear IN ORDER, which is what keeps "…Ad Set 1" from also
 * matching "…Ad Set - Paid": a set-based match would let the 1 from "Campaign 1"
 * stand in for the missing one.
 *
 * An empty list means count everything. A list that matches nothing is treated
 * as a mistake rather than obeyed — api/finance.js falls back to every active
 * line and returns the names Meta actually gave, so a typo here shows up as a
 * correction to make instead of an empty page.
 */
export const AD_SPEND_INCLUDE = [
  'Dave Campaign 1 Ad Set 1',
  'Dave Campaign 1 Sales Campaign',
];

/** Reduce a name to the words that carry meaning, for loose matching. */
function words(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** True when every word of `pattern` appears in `name`, in order. */
export function looseMatch(name, pattern) {
  const hay = words(name);
  const need = words(pattern);
  if (!need.length) return false;
  let i = 0;
  for (const w of hay) if (w === need[i] && ++i === need.length) return true;
  return false;
}

/**
 * The include list in force, letting the environment override the code.
 *
 * Ad set names change more often than deploys happen, so AD_SPEND_INCLUDE can
 * be edited in Vercel: one pattern per line or separated by semicolons. Setting
 * it to an empty string is an explicit "count everything"; leaving it unset
 * falls back to the list above.
 */
export function includeList(env = process.env) {
  const raw = env.AD_SPEND_INCLUDE;
  if (raw === undefined) return AD_SPEND_INCLUDE;
  return String(raw).split(/[;\n]+/).map((p) => p.trim()).filter(Boolean);
}

/** Does this campaign/ad set line pass the include list? */
export function isIncluded(name, list = AD_SPEND_INCLUDE) {
  if (!list || !list.length) return true;
  return list.some((p) => looseMatch(name, p));
}

/**
 * How a daily budget becomes a monthly figure.
 *
 * The actual number of days in the CURRENT month, not a flat 30.4. A page whose
 * job is cash flow should agree with the bank statement, and February does not
 * cost the same as March.
 */
export function daysInCurrentMonth(now = new Date()) {
  return new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
}

/**
 * Today's date in the ad account's own timezone, as {year, month, day}.
 *
 * Meta reports on the ad account's timezone, so counting the days left in the
 * month from the server's clock would be off by one for most of every day —
 * and on the 1st or the 31st that is the difference between a projection and
 * a fiction.
 */
export function todayIn(timeZone, now = new Date()) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    parts = now.toISOString().slice(0, 10); // unknown zone: UTC is the honest fallback
  }
  const [year, month, day] = parts.split('-').map(Number);
  return { year, month, day };
}

/** Days in the month containing the given {year, month} (month is 1-based). */
export function daysInMonthOf({ year, month }) {
  return new Date(year, month, 0).getDate();
}

/** Sum a list of {amount} lines, tolerating anything unparseable. */
export function sumAmounts(rows) {
  return (rows || []).reduce((a, r) => a + (Number(r.amount) || 0), 0);
}

/** The manual side of the page, resolved against the environment. */
export function manualFigures(env = process.env) {
  const raw = env.SKOOL_MRR;
  const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
  const mrr = Number.isFinite(parsed) ? parsed : SKOOL_MRR_DEFAULT;

  return {
    skoolMrr: mrr,
    // Says where the figure came from, so the UI never implies it was fetched.
    skoolMrrSource: Number.isFinite(parsed) ? 'SKOOL_MRR' : 'lib/finance/config.js',
    recurringCosts: RECURRING_COSTS,
    otherRevenue: OTHER_REVENUE,
  };
}
