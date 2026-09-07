/**
 * Tests for the finances endpoint.
 *
 * No dependencies, no credentials, no network — Meta and Google are stubbed:
 *
 *     node test/finance.test.mjs
 *
 * The things worth holding here are arithmetic and honesty. Meta returns
 * budgets in cents, budgets sit at either the campaign or the ad set level but
 * never both, and a figure someone typed must never be presented as one that
 * was fetched. Each of those has a cheap way to be wrong that still looks
 * entirely plausible on screen, which is exactly what a test is for.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';

/* A real key, because accessToken() really signs a JWT — a placeholder string
   would fail inside OpenSSL rather than exercising the path. Generated once. */
const TEST_KEY = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
const TEST_SHEET = {
  spreadsheetId: 'id',
  clientEmail: 'a@b.iam.gserviceaccount.com',
  privateKey: TEST_KEY,
};

process.env.DASHBOARD_SESSION_SECRET = 's'.repeat(40);
process.env.META_ADS_TOKEN = 'FAKE_TOKEN_should_never_appear_in_output_0123456789';
process.env.META_AD_ACCOUNT_ID = 'act_123456';
// Explicitly empty: most fixtures below are not meant to be filtered, and the
// filter gets its own section. Unset would silently apply the shipped list.
process.env.AD_SPEND_INCLUDE = '';

const auth = await import('../lib/auth.js');
const { default: finance } = await import('../api/finance.js');
const cfg = await import('../lib/finance/config.js');
const sheets = await import('../lib/finance/sheets.js');

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

/**
 * Stub Meta. `tree` answers the campaigns edge; `spendRows` answers Insights;
 * the account edge answers with a fixed timezone so day arithmetic is stable.
 */
function stubMeta(tree, spendRows = [], timezone = 'UTC') {
  globalThis.fetch = async (u) => {
    const s = String(u);
    let body;
    if (/\/campaigns\b/.test(s)) body = { data: tree };
    else if (/\/insights\b/.test(s)) body = { data: spendRows };
    else body = { timezone_name: timezone, currency: 'USD' };
    return { ok: true, status: 200, json: async () => body };
  };
}

const call = async (req = GET()) => {
  const res = mockRes();
  await finance(req, res);
  return res;
};

/** Days left after today, in the stubbed UTC account timezone. */
const daysLeft = () => {
  const now = new Date();
  const today = cfg.todayIn('UTC', now);
  return cfg.daysInMonthOf(today) - today.day;
};

/* ---------------------------------------------------------------- days ---- */
console.log('\nMonth length and the day inside it');

t('February 2027 is 28 days', () =>
  assert.equal(cfg.daysInMonthOf({ year: 2027, month: 2 }), 28));
t('February 2028 is 29 days', () =>
  assert.equal(cfg.daysInMonthOf({ year: 2028, month: 2 }), 29));
t('September is 30 days', () =>
  assert.equal(cfg.daysInMonthOf({ year: 2026, month: 9 }), 30));
t('a 31-day month is 31, not a 30.4 average', () =>
  assert.equal(cfg.daysInMonthOf({ year: 2026, month: 10 }), 31));

{
  // THE BUG THIS GUARDS: Meta reports on the ad account's timezone. Reading the
  // date off the server clock puts the projection a day out for most of every
  // day, and on the 1st or 31st that is the whole figure.
  const utcNoon = new Date('2026-09-06T23:30:00Z');
  t('the day is read in the account timezone, not the server one', () => {
    assert.deepEqual(cfg.todayIn('UTC', utcNoon), { year: 2026, month: 9, day: 6 });
    assert.deepEqual(cfg.todayIn('Australia/Sydney', utcNoon), { year: 2026, month: 9, day: 7 });
  });
  t('an unrecognised timezone falls back to UTC rather than throwing', () =>
    assert.deepEqual(cfg.todayIn('Not/AZone', utcNoon), { year: 2026, month: 9, day: 6 }));
}

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
  await finance({ method: 'DELETE', query: {}, headers: { cookie: validCookie } }, res);
  t('an unsupported method is refused', () => assert.equal(res.code, 405));
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
  t('a daily_budget of 1000 is $10.00 a day', () =>
    assert.equal(res.body.adSpend.dailyTotal, 10));
  t('the forward projection is the daily rate times the days LEFT', () =>
    assert.equal(res.body.adSpend.projectedRemainder, Math.round(10 * daysLeft() * 100) / 100));
}

/* ------------------------------------------------- spent plus projected ---- */
console.log('\nSpend already gone plus spend still to come');

{
  // The whole point of the change: the month's cost is what has actually gone
  // out plus what the budgets in force will spend over the days that are left.
  stubMeta(
    [{
      id: 'c1', name: 'Sales', status: 'ACTIVE', effective_status: 'ACTIVE',
      adsets: { data: [
        { id: 'a1', name: 'Broad', effective_status: 'ACTIVE', daily_budget: '2000' },
        { id: 'a2', name: 'New', effective_status: 'ACTIVE', daily_budget: '1000' },
      ] },
    }],
    [{ adset_id: 'a1', campaign_id: 'c1', spend: '183.20' }],
  );
  const res = await call();
  const a = res.body.adSpend;
  const left = daysLeft();

  t('month to date is the sum of what the lines actually spent', () =>
    assert.equal(a.monthToDate, 183.2));
  t('a brand new ad set with no spend still contributes its budget forward', () =>
    assert.equal(a.dailyTotal, 30));
  t('the expected month total is spent plus projected', () =>
    assert.equal(a.expectedMonthTotal, Math.round((183.2 + 30 * left) * 100) / 100));
  t('the expense line uses the expected total, not the projection alone', () =>
    assert.equal(res.body.expenses.find((e) => e.id === 'meta-ads').amount, a.expectedMonthTotal));
  t('each line carries its own spend and its own expected total', () => {
    const broad = a.lines.find((l) => l.name.endsWith('Broad'));
    const fresh = a.lines.find((l) => l.name.endsWith('New'));
    assert.equal(broad.spent, 183.2);
    assert.equal(fresh.spent, 0);
    assert.equal(fresh.expected, Math.round(10 * left * 100) / 100);
  });
  t('the days left are reported so the projection can be checked', () =>
    assert.equal(a.daysRemaining, left));
}

{
  // Spend on something with no budget left set still has to be counted — the
  // money is gone whether or not the ad set is still configured to spend more.
  stubMeta(
    [{
      id: 'c1', name: 'Old', status: 'PAUSED', effective_status: 'PAUSED',
      adsets: { data: [{ id: 'a1', name: 'Retired', effective_status: 'PAUSED' }] },
    }],
    [{ adset_id: 'a1', campaign_id: 'c1', spend: '42.00' }],
  );
  const res = await call();
  t('spend from a paused line is still counted as spent', () =>
    assert.equal(res.body.adSpend.monthToDate, 42));
  t('but a paused line projects nothing forward', () =>
    assert.equal(res.body.adSpend.projectedRemainder, 0));
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
  }], [
    { adset_id: 'a1', campaign_id: 'c1', spend: '10' },
    { adset_id: 'a2', campaign_id: 'c1', spend: '15' },
  ]);
  const res = await call();
  t('a campaign budget is counted once, not once per ad set', () =>
    assert.equal(res.body.adSpend.dailyTotal, 50));
  t('the CBO campaign is the only line reported', () =>
    assert.deepEqual(res.body.adSpend.lines.map((l) => l.level), ['campaign']));
  t('its ad sets’ spend rolls up to the campaign line', () =>
    assert.equal(res.body.adSpend.lines[0].spent, 25));
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
console.log('\nOnly what can actually spend projects forward');

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
    assert.equal(orphan.expected, 0);
  });
  t('paused work is still listed, so the page shows what exists', () =>
    assert.equal(res.body.adSpend.lines.length, 3));
}

{
  stubMeta([{
    id: 'c1', name: 'Live', status: 'ACTIVE', effective_status: 'ACTIVE',
    adsets: { data: [
      { id: 'a1', name: 'Running', effective_status: 'ACTIVE', daily_budget: '2000' },
      { id: 'a2', name: 'Never used', effective_status: 'PAUSED' },
    ] },
  }]);
  const res = await call();
  t('an ad set with no budget and no spend is not listed at all', () =>
    assert.deepEqual(res.body.adSpend.lines.map((l) => l.name), ['Live / Running']));
}

/* --------------------------------------------------------------- lifetime -- */
console.log('\nLifetime budgets');

{
  // A lifetime budget is a total for the whole run, not a monthly rate.
  // Projecting it across the days left would invent money.
  stubMeta([{
    id: 'c1', name: 'Burst', status: 'ACTIVE', effective_status: 'ACTIVE',
    adsets: { data: [{ id: 'a1', name: 'Flight', effective_status: 'ACTIVE', lifetime_budget: '50000' }] },
  }]);
  const res = await call();
  t('a lifetime budget is not projected forward as a daily rate', () =>
    assert.equal(res.body.adSpend.projectedRemainder, 0));
  t('the lifetime total is reported separately', () =>
    assert.equal(res.body.adSpend.lifetimeTotal, 500));
  t('and it is called out rather than left to be noticed', () =>
    assert.ok(res.body.warnings.some((w) => /lifetime/i.test(w)), JSON.stringify(res.body.warnings)));
}

/* ----------------------------------------------------------------- filter -- */
console.log('\nThe include filter');

t('words must match in order, so Ad Set 1 does not match Ad Set Paid', () => {
  assert.equal(cfg.looseMatch('Dave - Campaign 1 / Dave - Ad Set 1', 'Dave Campaign 1 Ad Set 1'), true);
  assert.equal(cfg.looseMatch('Dave - Campaign 1 / Dave - Ad Set - Paid', 'Dave Campaign 1 Ad Set 1'), false);
});
t('punctuation and case are ignored', () =>
  assert.equal(cfg.looseMatch('DAVE — campaign_1 // ad-set-1', 'dave campaign 1 ad set 1'), true));
t('an empty include list counts everything', () =>
  assert.equal(cfg.isIncluded('anything at all', []), true));
t('an unset AD_SPEND_INCLUDE falls back to the shipped list', () =>
  assert.deepEqual(cfg.includeList({}), cfg.AD_SPEND_INCLUDE));
t('an empty AD_SPEND_INCLUDE is an explicit count-everything', () =>
  assert.deepEqual(cfg.includeList({ AD_SPEND_INCLUDE: '' }), []));
t('AD_SPEND_INCLUDE splits on semicolons and newlines', () =>
  assert.deepEqual(cfg.includeList({ AD_SPEND_INCLUDE: 'a b;\n c d ;' }), ['a b', 'c d']));

const FILTER_TREE = [{
  id: 'c1', name: 'Dave - Campaign 1', status: 'ACTIVE', effective_status: 'ACTIVE',
  adsets: { data: [
    { id: 'a1', name: 'Dave - Ad Set 1', effective_status: 'ACTIVE', daily_budget: '1000' },
    { id: 'a2', name: 'Dave - Ad Set - Paid', effective_status: 'ACTIVE', daily_budget: '2000' },
  ] },
}, {
  id: 'c2', name: 'Dave - Campaign 1 - Sales Campaign', status: 'ACTIVE', effective_status: 'ACTIVE',
  daily_budget: '3000', adsets: { data: [] },
}];

{
  process.env.AD_SPEND_INCLUDE = 'Dave Campaign 1 Ad Set 1;Dave Campaign 1 Sales Campaign';
  stubMeta(FILTER_TREE, [{ adset_id: 'a2', campaign_id: 'c1', spend: '77' }]);
  const res = await call();
  const names = res.body.adSpend.lines.map((l) => l.name);

  t('only the named campaign and ad set are listed', () =>
    assert.deepEqual(names.sort(), [
      'Dave - Campaign 1 - Sales Campaign',
      'Dave - Campaign 1 / Dave - Ad Set 1',
    ]));
  t('excluded lines are left out of the totals', () =>
    assert.equal(res.body.adSpend.dailyTotal, 40));
  t('excluded spend is left out of month to date', () =>
    assert.equal(res.body.adSpend.monthToDate, 0));
  t('but an excluded line that is still spending is called out', () =>
    assert.ok(res.body.warnings.some((w) => /excluded/i.test(w) && /77/.test(w)),
      JSON.stringify(res.body.warnings)));
  t('the page is told how many lines exist in total', () => {
    assert.equal(res.body.adSpend.totalLines, 3);
    assert.equal(res.body.adSpend.filtered, true);
  });
}

{
  // A filter that matches nothing is a typo, not an instruction to show an
  // empty page. Obeying it would look exactly like an account with no spend.
  process.env.AD_SPEND_INCLUDE = 'Campaign That Does Not Exist';
  stubMeta(FILTER_TREE);
  const res = await call();
  t('a filter matching nothing falls back to showing everything', () =>
    assert.equal(res.body.adSpend.lines.length, 3));
  t('and it says so, with the names Meta actually returned', () => {
    const w = res.body.warnings.find((x) => /matched nothing/i.test(x));
    assert.ok(w, JSON.stringify(res.body.warnings));
    assert.match(w, /Dave - Ad Set - Paid/);
  });
  process.env.AD_SPEND_INCLUDE = '';
}

/* ----------------------------------------------------------------- totals -- */
console.log('\nRevenue, expenses and the net');

{
  process.env.SKOOL_MRR = '1200';
  stubMeta([{
    id: 'c1', name: 'Sales', status: 'ACTIVE', effective_status: 'ACTIVE',
    adsets: { data: [{ id: 'a1', name: 'Broad', effective_status: 'ACTIVE', daily_budget: '1000' }] },
  }], [{ adset_id: 'a1', campaign_id: 'c1', spend: '318.44' }]);
  const res = await call();

  t('the manual MRR is used when SKOOL_MRR is set', () =>
    assert.equal(res.body.revenue.find((r) => r.id === 'skool').amount, 1200));
  t('revenue totals the revenue lines', () =>
    assert.equal(res.body.totals.revenue, 1200));
  t('Higgsfield is on the books at $99', () =>
    assert.equal(res.body.expenses.find((e) => e.id === 'higgsfield').amount, 99));
  t('net is revenue minus expenses', () =>
    assert.equal(res.body.totals.net,
      Math.round((res.body.totals.revenue - res.body.totals.expenses) * 100) / 100));

  delete process.env.SKOOL_MRR;
}

{
  // Margin on zero revenue is undefined, not zero and not negative infinity.
  process.env.SKOOL_MRR = '0';
  stubMeta([]);
  const res = await call();
  t('margin is null when nothing is coming in', () =>
    assert.equal(res.body.totals.margin, null));
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
    assert.ok(res.body.revenue.find((r) => r.id === 'skool').note.includes('SKOOL_MRR')));
  t('ad spend is labelled live', () =>
    assert.equal(res.body.expenses.find((e) => e.id === 'meta-ads').source, 'live'));
  t('every recurring cost is labelled entered', () =>
    assert.ok(res.body.expenses.filter((e) => e.id !== 'meta-ads').every((e) => e.source === 'manual')));
  t('every line carries a source', () =>
    assert.ok([...res.body.revenue, ...res.body.expenses].every((l) => l.source)));

  delete process.env.SKOOL_MRR;
}

{
  delete process.env.SKOOL_MRR;
  t('the fallback MRR is reported as coming from the config file', () =>
    assert.equal(cfg.manualFigures({}).skoolMrrSource, 'lib/finance/config.js'));
  t('a blank SKOOL_MRR falls back rather than reading as zero revenue', () =>
    assert.equal(cfg.manualFigures({ SKOOL_MRR: '' }).skoolMrrSource, 'lib/finance/config.js'));
  t('a non-numeric SKOOL_MRR falls back', () =>
    assert.equal(cfg.manualFigures({ SKOOL_MRR: 'twelve hundred' }).skoolMrrSource, 'lib/finance/config.js'));
  t('an explicit zero is honoured, because zero is a real answer', () =>
    assert.equal(cfg.manualFigures({ SKOOL_MRR: '0' }).skoolMrrSource, 'SKOOL_MRR'));
}

/* ----------------------------------------------------------- google sheet -- */
console.log('\nThe Google Sheet');

t('no sheet variables means not configured, which is a supported state', () =>
  assert.equal(sheets.sheetsConfig({}), null));
t('a partially configured sheet is not treated as configured', () =>
  assert.equal(sheets.sheetsConfig({ FINANCE_SHEET_ID: 'abc' }), null));
t('the missing variables are named for the setup message', () =>
  assert.deepEqual(sheets.missingSheetEnv({ FINANCE_SHEET_ID: 'abc' }),
    ['GOOGLE_SHEETS_CLIENT_EMAIL', 'GOOGLE_SHEETS_PRIVATE_KEY']));

{
  // THE BUG THIS GUARDS: a PEM pasted into a dashboard env var arrives with its
  // newlines escaped, and crypto then fails with an opaque parse error rather
  // than anything that points at the cause.
  const PEM = '-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n';
  t('an escaped-newline private key is unescaped', () =>
    assert.equal(sheets.sheetsConfig({
      FINANCE_SHEET_ID: 'id', GOOGLE_SHEETS_CLIENT_EMAIL: 'a@b.iam.gserviceaccount.com',
      GOOGLE_SHEETS_PRIVATE_KEY: PEM.split('\n').join('\\n'),
    }).privateKey, PEM.trim()));
  t('a quote-wrapped private key is unwrapped', () =>
    assert.equal(sheets.sheetsConfig({
      FINANCE_SHEET_ID: 'id', GOOGLE_SHEETS_CLIENT_EMAIL: 'a@b.iam.gserviceaccount.com',
      GOOGLE_SHEETS_PRIVATE_KEY: '"' + PEM.split('\n').join('\\n') + '"',
    }).privateKey, PEM.trim()));
  t('a real multi-line key is left alone', () =>
    assert.equal(sheets.sheetsConfig({
      FINANCE_SHEET_ID: 'id', GOOGLE_SHEETS_CLIENT_EMAIL: 'a@b.iam.gserviceaccount.com',
      GOOGLE_SHEETS_PRIVATE_KEY: PEM,
    }).privateKey, PEM.trim()));
}

t('the embed url is the editable one, not a read-only publish', () =>
  assert.match(sheets.embedUrl('SHEET_ID'), /\/spreadsheets\/d\/SHEET_ID\/edit\?embedded=true$/));

{
  // A spreadsheet hands back whatever the user typed, formatted however the
  // sheet is formatted. All of these mean the same amount.
  t('money cells parse whatever the sheet returns', () => {
    assert.equal(sheets.parseAmount(1200), 1200);
    assert.equal(sheets.parseAmount('1200'), 1200);
    assert.equal(sheets.parseAmount('$1,200.00'), 1200);
    assert.equal(sheets.parseAmount(' 1,200 '), 1200);
    assert.equal(sheets.parseAmount('-45.50'), -45.5);
  });
  t('an empty or unreadable cell is zero, not NaN', () => {
    assert.equal(sheets.parseAmount(''), 0);
    assert.equal(sheets.parseAmount(undefined), 0);
    assert.equal(sheets.parseAmount('n/a'), 0);
  });
}

{
  // Rows are classified by their Type column, so reordering rows in the sheet
  // cannot move a figure to the other side of the ledger.
  const rows = [
    ['Type', 'Line', 'Monthly', 'Note'],
    ['Revenue', 'Skool community', '$1,450', 'as of today'],
    ['Expense', 'Higgsfield', '99', ''],
    ['', '', '', ''],
    ['expense', 'Domain', '2.50', 'annual / 12'],
    ['Expense', '', '999', 'no label, ignored'],
    ['Notes', 'not a ledger row', '500', ''],
  ];
  // One stub answers both the token endpoint and the values endpoint.
  globalThis.fetch = async (u) => ({
    ok: true,
    status: 200,
    json: async () => (String(u).includes('oauth2')
      ? { access_token: 'stub', expires_in: 3600 }
      : { values: rows }),
  });

  const entered = await sheets.readEntered(TEST_SHEET);

  t('revenue rows are read off the sheet', () => {
    assert.equal(entered.revenue.length, 1);
    assert.equal(entered.revenue[0].amount, 1450);
  });
  t('expense rows are read off the sheet, case-insensitively', () =>
    assert.deepEqual(entered.expenses.map((e) => e.label), ['Higgsfield', 'Domain']));
  t('a row with no label is skipped rather than counted as a blank line', () =>
    assert.ok(!entered.expenses.some((e) => e.amount === 999)));
  t('a row with an unrecognised Type is skipped, not guessed at', () =>
    assert.ok(![...entered.revenue, ...entered.expenses].some((l) => l.amount === 500)));
  t('sheet rows are labelled entered, never live', () =>
    assert.ok([...entered.revenue, ...entered.expenses].every((l) => l.source === 'manual')));
}

{
  const seeded = sheets.seedEnteredRows({
    skoolMrr: 0, recurringCosts: cfg.RECURRING_COSTS, otherRevenue: [],
  });
  t('the seeded sheet has a header row', () =>
    assert.deepEqual(seeded[0], ['Type', 'Line', 'Monthly', 'Note']));
  t('the seeded sheet gives Skool a row to type into', () =>
    assert.equal(seeded[1][1], 'Skool community'));
  t('the seeded sheet carries the known recurring costs', () =>
    assert.ok(seeded.some((r) => r[1] === 'Higgsfield' && r[2] === 99)));
}

{
  const rows = sheets.liveRows({
    fetchedAt: '2026-09-06T12:00:00.000Z',
    adSpend: {
      timeZone: 'America/Denver', monthToDate: 183.2, dailyTotal: 30,
      daysRemaining: 24, projectedRemainder: 720, expectedMonthTotal: 903.2,
      lines: [{ name: 'C / A', level: 'adset', live: true, daily: 30, spent: 183.2, expected: 903.2 }],
    },
  });
  const flat = rows.map((r) => r.join('|')).join('\n');
  t('the live tab carries the figures the page shows', () => {
    assert.match(flat, /Already spent \(month to date\)\|183\.2/);
    assert.match(flat, /Expected month total\|903\.2/);
  });
  t('the live tab says it is overwritten, so nobody types in it', () =>
    assert.match(flat, /Do not edit/i));
  t('the live tab carries a per-line breakdown', () =>
    assert.match(flat, /C \/ A\|adset\|active/));
}

{
  stubMeta([]);
  const res = await call();
  t('an unconfigured sheet is reported, not hidden', () => {
    assert.equal(res.body.sheet.configured, false);
    assert.deepEqual(res.body.sheet.missing, [
      'FINANCE_SHEET_ID', 'GOOGLE_SHEETS_CLIENT_EMAIL', 'GOOGLE_SHEETS_PRIVATE_KEY',
    ]);
  });
  t('and the figures still come through from the fallback', () =>
    assert.equal(res.body.expenses.find((e) => e.id === 'higgsfield').amount, 99));
}

/* ----------------------------------------------------------------- secrets -- */
console.log('\nCredentials never leave the server');

{
  const TOKEN = process.env.META_ADS_TOKEN;

  // Meta echoes the request back in some errors, token and all.
  globalThis.fetch = async () => ({
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
  process.env.GOOGLE_SHEETS_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nSECRETKEYMATERIAL\n-----END PRIVATE KEY-----';
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: { message: 'Invalid key: SECRETKEYMATERIAL' } }),
  });
  const res = await call();
  t('a Google error cannot leak the service account key', () =>
    assert.equal(JSON.stringify(res.body).includes('SECRETKEYMATERIAL'), false));
  delete process.env.GOOGLE_SHEETS_PRIVATE_KEY;
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
