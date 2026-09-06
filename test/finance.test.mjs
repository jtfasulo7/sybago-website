/**
 * Tests for the finances endpoint.
 *
 * No dependencies, no credentials, no network — Meta is stubbed:
 *
 *     node test/finance.test.mjs
 *
 * The things worth holding here are arithmetic and honesty. Meta returns
 * budgets in cents, budgets can sit at either the campaign or the ad set level
 * but never both, and a figure someone typed must never be presented as one
 * that was fetched. Each of those has a cheap way to be wrong that still looks
 * plausible on screen, which is exactly what a test is for.
 */

import assert from 'node:assert';

process.env.DASHBOARD_SESSION_SECRET = 's'.repeat(40);
process.env.META_ADS_TOKEN = 'FAKE_TOKEN_should_never_appear_in_output_0123456789';
process.env.META_AD_ACCOUNT_ID = 'act_123456';

const auth = await import('../lib/auth.js');
const { default: finance } = await import('../api/finance.js');
const cfg = await import('../lib/finance/config.js');

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log('  PASS  ' + name);
  } catch (e) {
    fail++;
    console.log('  FAIL  ' + name + '\n        ' + e.message);
  }
};

const SECRET = process.env.DASHBOARD_SESSION_SECRET;
const validCookie = auth.createSessionCookie(SECRET).split(';')[0];

function mockRes() {
  const r = { code: 200, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}

// Built as an object rather than a default parameter: passing undefined to a
// default parameter selects the default, which would have quietly turned the
// unauthenticated case into a signed-in one that passes for the wrong reason.
const GET = (headers = { cookie: validCookie }) => ({ method: 'GET', query: {}, headers });

/** Stub Meta: `tree` answers the campaigns edge, `spend` answers insights. */
function stubMeta(tree, spend = '0') {
  const urls = [];
  globalThis.fetch = async (u) => {
    const s = String(u);
    urls.push(s);
    const body = /\/campaigns\b/.test(s) ? { data: tree } : { data: [{ spend }] };
    return { ok: true, status: 200, json: async () => body };
  };
  return urls;
}

const call = async (req = GET()) => {
  const res = mockRes();
  await finance(req, res);
  return res;
};

/* ---------------------------------------------------------------- days ---- */
console.log('\nMonth length');

t('February 2027 is 28 days', () =>
  assert.equal(cfg.daysInCurrentMonth(new Date(Date.UTC(2027, 1, 15))), 28));
t('February 2028 is 29 days', () =>
  assert.equal(cfg.daysInCurrentMonth(new Date(Date.UTC(2028, 1, 15))), 29));
t('September is 30 days', () =>
  assert.equal(cfg.daysInCurrentMonth(new Date(Date.UTC(2026, 8, 6))), 30));
t('a 31-day month is 31, not a 30.4 average', () =>
  assert.equal(cfg.daysInCurrentMonth(new Date(Date.UTC(2026, 9, 6))), 31));

/* -------------------------------------------------------------- access ---- */
console.log('\nAccess');

{
  let reached = false;
  globalThis.fetch = async () => { reached = true; throw new Error('should not be called'); };
  const res = await call(GET({}));
  t('an unauthenticated request is rejected', () => assert.equal(res.code, 401));
  t('an unauthenticated request never reaches Meta', () => assert.equal(reached, false));
}

{
  const forged = validCookie.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
  let reached = false;
  globalThis.fetch = async () => { reached = true; throw new Error('should not be called'); };
  const res = await call(GET({ cookie: forged }));
  t('a tampered cookie is rejected', () => assert.equal(res.code, 401));
  t('a tampered cookie never reaches Meta', () => assert.equal(reached, false));
}

{
  stubMeta([]);
  const res = await call();
  t('responses are no-store', () =>
    assert.match(String(res.headers['Cache-Control'] || ''), /no-store/));
}

{
  stubMeta([]);
  const res = mockRes();
  await finance({ method: 'POST', query: {}, headers: { cookie: validCookie } }, res);
  t('POST is refused', () => assert.equal(res.code, 405));
}

/* ----------------------------------------------------------- minor units -- */
console.log('\nBudgets are read in cents');

{
  // THE BUG THIS GUARDS: daily_budget "1000" is ten dollars, not a thousand.
  // Reading it as whole currency overstates the business's costs a hundredfold
  // and the page still looks entirely normal.
  stubMeta([{
    id: 'c1', name: 'Sales', status: 'ACTIVE', effective_status: 'ACTIVE',
    adsets: { data: [{ id: 'a1', name: 'Broad', effective_status: 'ACTIVE', daily_budget: '1000' }] },
  }]);
  const res = await call();
  const days = cfg.daysInCurrentMonth();
  t('a daily_budget of 1000 is $10.00 a day', () =>
    assert.equal(res.body.adSpend.dailyTotal, 10));
  t('the monthly projection is the daily rate times the days in this month', () =>
    assert.equal(res.body.adSpend.projectedMonthly, 10 * days));
}

/* ------------------------------------------------------------- CBO vs ad set */
console.log('\nCampaign budget optimisation');

{
  // A CBO campaign holds the budget and its ad sets hold none. If both levels
  // were summed the total would double — and Meta happily returns both objects.
  stubMeta([{
    id: 'c1', name: 'CBO', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '5000',
    adsets: { data: [
      { id: 'a1', name: 'One', effective_status: 'ACTIVE', daily_budget: '5000' },
      { id: 'a2', name: 'Two', effective_status: 'ACTIVE', daily_budget: '5000' },
    ] },
  }]);
  const res = await call();
  t('a campaign budget is counted once, not once per ad set', () =>
    assert.equal(res.body.adSpend.dailyTotal, 50));
  t('the CBO campaign is the only line reported', () =>
    assert.deepEqual(res.body.adSpend.lines.map((l) => l.level), ['campaign']));
}

{
  stubMeta([{
    id: 'c1', name: 'ABO', status: 'ACTIVE', effective_status: 'ACTIVE',
    adsets: { data: [
      { id: 'a1', name: 'One', effective_status: 'ACTIVE', daily_budget: '2000' },
      { id: 'a2', name: 'Two', effective_status: 'ACTIVE', daily_budget: '3000' },
    ] },
  }]);
  const res = await call();
  t('ad set budgets sum when the campaign has none', () =>
    assert.equal(res.body.adSpend.dailyTotal, 50));
  t('each ad set gets its own line', () =>
    assert.equal(res.body.adSpend.lines.length, 2));
  t('an ad set line names its campaign', () =>
    assert.ok(res.body.adSpend.lines.every((l) => l.name.startsWith('ABO / '))));
}

/* ------------------------------------------------------------- what counts -- */
console.log('\nOnly what can actually spend');

{
  stubMeta([{
    id: 'c1', name: 'Live', status: 'ACTIVE', effective_status: 'ACTIVE',
    adsets: { data: [
      { id: 'a1', name: 'Running', effective_status: 'ACTIVE', daily_budget: '2000' },
      { id: 'a2', name: 'Paused', effective_status: 'PAUSED', daily_budget: '9900' },
    ] },
  }, {
    id: 'c2', name: 'Off', status: 'PAUSED', effective_status: 'PAUSED',
    adsets: { data: [{ id: 'a3', name: 'Orphan', effective_status: 'ACTIVE', daily_budget: '9900' }] },
  }]);
  const res = await call();
  t('a paused ad set does not spend', () =>
    assert.equal(res.body.adSpend.dailyTotal, 20));
  t('an active ad set under a paused campaign does not spend either', () => {
    const orphan = res.body.adSpend.lines.find((l) => l.name.endsWith('Orphan'));
    assert.equal(orphan.live, false);
    assert.equal(orphan.monthly, 0);
  });
  t('paused work is still listed, so the page shows what exists', () =>
    assert.equal(res.body.adSpend.lines.length, 3));
}

/* --------------------------------------------------------------- lifetime -- */
console.log('\nLifetime budgets');

{
  // A lifetime budget is a total for the whole run, not a monthly rate.
  // Multiplying it by the days in the month would invent money.
  stubMeta([{
    id: 'c1', name: 'Burst', status: 'ACTIVE', effective_status: 'ACTIVE',
    adsets: { data: [{ id: 'a1', name: 'Flight', effective_status: 'ACTIVE', lifetime_budget: '50000' }] },
  }]);
  const res = await call();
  t('a lifetime budget is not multiplied into a monthly rate', () =>
    assert.equal(res.body.adSpend.projectedMonthly, 0));
  t('the lifetime total is reported separately', () =>
    assert.equal(res.body.adSpend.lifetimeTotal, 500));
  t('and it is called out rather than left to be noticed', () =>
    assert.ok(res.body.warnings.some((w) => /lifetime/i.test(w)), JSON.stringify(res.body.warnings)));
}

/* ----------------------------------------------------------------- totals -- */
console.log('\nRevenue, expenses and the net');

{
  process.env.SKOOL_MRR = '1200';
  stubMeta([{
    id: 'c1', name: 'Sales', status: 'ACTIVE', effective_status: 'ACTIVE',
    adsets: { data: [{ id: 'a1', name: 'Broad', effective_status: 'ACTIVE', daily_budget: '1000' }] },
  }], '318.44');
  const res = await call();
  const days = cfg.daysInCurrentMonth();

  t('the manual MRR is used when SKOOL_MRR is set', () =>
    assert.equal(res.body.revenue.find((r) => r.id === 'skool').amount, 1200));
  t('revenue totals the revenue lines', () =>
    assert.equal(res.body.totals.revenue, 1200));
  t('expenses include the projected ad spend', () =>
    assert.equal(res.body.expenses.find((e) => e.id === 'meta-ads').amount, 10 * days));
  t('net is revenue minus expenses', () =>
    assert.equal(res.body.totals.net, res.body.totals.revenue - res.body.totals.expenses));
  t('month-to-date actual spend is reported for comparison', () =>
    assert.equal(res.body.adSpend.monthToDate, 318.44));

  delete process.env.SKOOL_MRR;
}

{
  // Margin on zero revenue is undefined, not zero and not negative infinity.
  process.env.SKOOL_MRR = '0';
  stubMeta([]);
  const res = await call();
  t('margin is null when nothing is coming in', () =>
    assert.equal(res.body.totals.margin, null));
  t('a zero projection is explained rather than left ambiguous', () =>
    assert.ok(res.body.warnings.some((w) => /paused/i.test(w))));
  delete process.env.SKOOL_MRR;
}

/* ------------------------------------------------------------- provenance -- */
console.log('\nLive and entered are never confused');

{
  process.env.SKOOL_MRR = '500';
  stubMeta([]);
  const res = await call();

  t('the Skool figure is labelled as entered, not fetched', () =>
    assert.equal(res.body.revenue.find((r) => r.id === 'skool').source, 'manual'));
  t('and it says where it was entered', () =>
    assert.equal(res.body.revenue.find((r) => r.id === 'skool').note.includes('SKOOL_MRR'), true));
  t('ad spend is labelled live', () =>
    assert.equal(res.body.expenses.find((e) => e.id === 'meta-ads').source, 'live'));
  t('every recurring cost is labelled entered', () =>
    assert.ok(res.body.expenses.filter((e) => e.id !== 'meta-ads').every((e) => e.source === 'manual')));
  t('every line carries a source', () =>
    assert.ok([...res.body.revenue, ...res.body.expenses].every((l) => l.source)));

  delete process.env.SKOOL_MRR;
}

{
  // Without the env var the fallback is used, and the note must point at the
  // file rather than implying an environment value that is not there.
  delete process.env.SKOOL_MRR;
  const m = cfg.manualFigures({});
  t('the fallback MRR is reported as coming from the config file', () =>
    assert.equal(m.skoolMrrSource, 'lib/finance/config.js'));
  t('a blank SKOOL_MRR falls back rather than reading as zero revenue', () =>
    assert.equal(cfg.manualFigures({ SKOOL_MRR: '' }).skoolMrrSource, 'lib/finance/config.js'));
  t('a non-numeric SKOOL_MRR falls back', () =>
    assert.equal(cfg.manualFigures({ SKOOL_MRR: 'twelve hundred' }).skoolMrrSource, 'lib/finance/config.js'));
  t('an explicit zero is honoured, because zero is a real answer', () =>
    assert.equal(cfg.manualFigures({ SKOOL_MRR: '0' }).skoolMrrSource, 'SKOOL_MRR'));
}

/* ----------------------------------------------------------------- secrets -- */
console.log('\nThe token never leaves the server');

{
  const TOKEN = process.env.META_ADS_TOKEN;

  // Meta echoes the request back in some errors, token and all.
  globalThis.fetch = async (u) => ({
    ok: false,
    status: 400,
    json: async () => ({ error: { message: `Bad request: access_token=${TOKEN} is invalid` } }),
  });
  const res = await call();
  t('a Meta error is surfaced', () => assert.equal(res.code, 502));
  t('but the token is scrubbed out of it', () =>
    assert.equal(JSON.stringify(res.body).includes(TOKEN), false));
}

{
  const TOKEN = process.env.META_ADS_TOKEN;
  stubMeta([{
    id: 'c1', name: 'Sales', status: 'ACTIVE', effective_status: 'ACTIVE',
    adsets: { data: [{ id: 'a1', name: 'Broad', effective_status: 'ACTIVE', daily_budget: '1000' }] },
  }]);
  const res = await call();
  t('a successful response contains no part of the token', () =>
    assert.equal(JSON.stringify(res.body).includes(TOKEN), false));
}

{
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED graph.facebook.com'); };
  const res = await call();
  t('a network failure is a clean error, not a stack trace', () => {
    assert.equal(res.code, 502);
    assert.equal(/ECONNREFUSED/.test(JSON.stringify(res.body)), false);
  });
}

/* -------------------------------------------------------------- misconfig -- */
console.log('\nMissing configuration is named, never guessed');

{
  const saved = process.env.META_AD_ACCOUNT_ID;
  delete process.env.META_AD_ACCOUNT_ID;
  let reached = false;
  globalThis.fetch = async () => { reached = true; throw new Error('should not be called'); };
  const res = await call();
  t('a missing account id is a 500 naming the variable', () => {
    assert.equal(res.code, 500);
    assert.match(res.body.message, /META_AD_ACCOUNT_ID/);
  });
  t('and nothing is asked of Meta', () => assert.equal(reached, false));
  process.env.META_AD_ACCOUNT_ID = saved;
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
