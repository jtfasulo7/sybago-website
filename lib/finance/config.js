// Recurring money in and out for the Peps by Dave business.
//
// Two kinds of figure appear on the finances page and they are kept visibly
// apart, because trusting a stale number is worse than seeing an empty one:
//
//   LIVE   — read from Meta on every refresh. Ad spend is projected from the
//            budgets actually set on the campaigns and ad sets right now, so
//            changing a budget in Ads Manager changes this page.
//   MANUAL — the figures below. Skool has no public API (no REST, no webhooks,
//            no analytics export), so its revenue cannot be read. It is entered
//            here instead and labelled as entered rather than fetched.
//
// Everything is MONTHLY and in whole currency units, not cents. Meta's API
// returns minor units and that conversion happens in api/finance.js, not here.

/**
 * Monthly recurring revenue from the Skool community.
 *
 * Overridable with the SKOOL_MRR environment variable, so the one number that
 * actually moves each month can be changed in Vercel without a code change.
 * The value here is the fallback and the record of what it last was.
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
    amount: 0,
    cadence: 'monthly',
    category: 'Tooling',
    note: 'Video generation. Amount to be confirmed.',
  },
];

/** Revenue that is not the Skool community. Empty until there is any. */
export const OTHER_REVENUE = [];

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
