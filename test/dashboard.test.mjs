/**
 * Tests for the internal ads dashboard.
 *
 * Runs with no dependencies and no credentials — the Meta API is stubbed, so
 * this is safe to run any time:
 *
 *     node test/dashboard.test.mjs
 *
 * The point of these is the security boundary, not coverage for its own sake:
 * that an unauthenticated request never reaches Meta, that a forged cookie is
 * rejected, and that the access token cannot appear in any response.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';

process.env.DASHBOARD_SESSION_SECRET = 's'.repeat(40);
process.env.META_ADS_TOKEN = 'FAKE_TOKEN_should_never_appear_in_output_0123456789';
process.env.META_AD_ACCOUNT_ID = 'act_123456';
process.env.META_ADS_ACCOUNT_ID_SYBAGO = 'act_777777';
process.env.DASHBOARD_PASSWORD = 'daves-standard-password';
process.env.DASHBOARD_MASTER_PASSWORD = 'the-master-password';

const auth = await import('../lib/auth.js');
const { default: insights } = await import('../api/meta-insights.js');
const { default: login } = await import('../api/dashboard-login.js');

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
const cookieOf = (setCookie) => setCookie.split(';')[0];
const validCookie = cookieOf(auth.createSessionCookie(SECRET));

function mockRes() {
  const r = { code: 200, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}

/* ------------------------------------------------------------ session ---- */
console.log('\nSession cookie');

t('valid cookie accepted', () =>
  assert.equal(auth.hasValidSession({ headers: { cookie: validCookie } }, SECRET), true));

t('cookie signed with a different secret rejected', () =>
  assert.equal(auth.hasValidSession({ headers: { cookie: validCookie } }, 'other-secret'), false));

t('tampered payload rejected', () => {
  const raw = validCookie.split('=')[1];
  const sig = raw.slice(raw.lastIndexOf('.') + 1);
  const forged = Buffer.from(JSON.stringify({ exp: Date.now() + 9e9 })).toString('base64url');
  assert.equal(
    auth.hasValidSession({ headers: { cookie: 'sybago_dash=' + forged + '.' + sig } }, SECRET),
    false,
  );
});

t('expired cookie rejected', () => {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() - 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  assert.equal(
    auth.hasValidSession({ headers: { cookie: 'sybago_dash=' + payload + '.' + sig } }, SECRET),
    false,
  );
});

t('missing cookie rejected', () => assert.equal(auth.hasValidSession({ headers: {} }, SECRET), false));
t('garbage cookie rejected', () =>
  assert.equal(auth.hasValidSession({ headers: { cookie: 'sybago_dash=nonsense' } }, SECRET), false));
t('empty secret rejected', () =>
  assert.equal(auth.hasValidSession({ headers: { cookie: validCookie } }, ''), false));

t('cookie carries HttpOnly, Secure and SameSite=Strict', () => {
  const sc = auth.createSessionCookie(SECRET);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /Secure/);
  assert.match(sc, /SameSite=Strict/);
});

t('constant-time compare behaves', () => {
  assert.equal(auth.safeEqual('hunter2', 'hunter2'), true);
  assert.equal(auth.safeEqual('hunter2', 'hunter3'), false);
  assert.equal(auth.safeEqual('short', 'a-much-longer-value'), false);
});

/* ----------------------------------------------------------- endpoint ---- */
console.log('\nInsights endpoint');

const DAILY = [{
  date_start: '2026-09-01', date_stop: '2026-09-01',
  spend: '42.10', impressions: '5100', reach: '4200', frequency: '1.21',
  clicks: '96', inline_link_clicks: '71', ctr: '1.88', cpc: '0.44', cpm: '8.25',
  actions: [
    { action_type: 'link_click', value: '71' },
    { action_type: 'landing_page_view', value: '54' },
    { action_type: 'offsite_conversion.fb_pixel_complete_registration', value: '6' },
  ],
  cost_per_action_type: [
    { action_type: 'offsite_conversion.fb_pixel_complete_registration', value: '7.02' },
    { action_type: 'landing_page_view', value: '0.78' },
  ],
  action_values: [{ action_type: 'offsite_conversion.fb_pixel_complete_registration', value: '180' }],
}];
const CAMPAIGNS = [{ campaign_id: '1', campaign_name: 'Peps — Skool signups', ...DAILY[0] }];

const stubOk = (byUrl) => async (u) => ({
  ok: true, headers: { get: () => null }, json: async () => ({ data: byUrl(String(u)) }),
});
const stubErr = (status, error) => async () => ({
  ok: false, status, headers: { get: () => null }, json: async () => ({ error }),
});

let res;

// Unauthenticated must be rejected *before* any outbound call.
let reached = false;
globalThis.fetch = async () => { reached = true; throw new Error('unreachable'); };
res = mockRes();
await insights({ method: 'GET', query: {}, headers: {} }, res);
t('unauthenticated request returns 401', () => assert.equal(res.code, 401));
t('Meta is never contacted when unauthenticated', () => assert.equal(reached, false));

// Happy path.
globalThis.fetch = stubOk((u) => (u.includes('time_increment') ? DAILY : CAMPAIGNS));
res = mockRes();
await insights(
  { method: 'GET', query: { level: 'campaign', since: '2026-09-01', until: '2026-09-01' }, headers: { cookie: validCookie } },
  res,
);
t('authenticated request returns 200', () => assert.equal(res.code, 200));
t('campaign row is shaped correctly', () => assert.equal(res.body.rows[0].name, 'Peps — Skool signups'));
t('numeric strings are coerced', () => assert.equal(res.body.rows[0].spend, 42.1));
t('registrations are detected', () => assert.equal(res.body.results.available, true));
t('cost per registration is surfaced', () => assert.equal(res.body.rows[0].costPerRegistration, 7.02));

// THE REGRESSION THIS GUARDS: registrations and landing page views were once
// resolved by a per-row priority guess and then summed into a single figure,
// producing a number that mixed two different metrics. They must stay separate.
t('registrations and landing page views are reported separately', () => {
  assert.equal(res.body.rows[0].registrations, 6);
  assert.equal(res.body.rows[0].landingPageViews, 54);
});
t('totals never merge registrations with landing page views', () => {
  assert.equal(res.body.totals.registrations, 6);
  assert.equal(res.body.totals.landingPageViews, 54);
  assert.notEqual(res.body.totals.registrations, 60);
});
t('cost per landing page view is its own figure', () =>
  assert.equal(res.body.rows[0].costPerLandingPageView, 0.78));
t('ROAS is computed from action_values', () =>
  assert.ok(Math.abs(res.body.rows[0].roas - 180 / 42.1) < 1e-9));
t('totals are summed from the daily series', () => assert.equal(res.body.totals.spend, 42.1));
t('response is marked no-store', () => assert.match(res.headers['Cache-Control'] || '', /no-store/));
t('token is absent from the response', () =>
  assert.ok(!JSON.stringify(res.body).includes('FAKE_TOKEN')));

// Clicks-only account must say so rather than imply conversions.
const NO_REG = [{ ...DAILY[0], actions: [{ action_type: 'link_click', value: '71' }, { action_type: 'landing_page_view', value: '54' }], cost_per_action_type: [], action_values: [] }];
globalThis.fetch = stubOk(() => NO_REG);
res = mockRes();
await insights({ method: 'GET', query: {}, headers: { cookie: validCookie } }, res);
t('absence of registration events is flagged', () => assert.equal(res.body.results.available, false));
t('landing page views still reported when registrations are absent', () => {
  assert.equal(res.body.results.landingPageViewsAvailable, true);
  assert.equal(res.body.totals.landingPageViews, 54);
});
t('the distinction is explained in plain language', () =>
  assert.match(res.body.results.note || '', /visits, not sign-ups|CompleteRegistration/i));

// Auth and permission errors must be distinguishable.
globalThis.fetch = stubErr(400, { code: 190, error_subcode: 463, message: 'Session has expired' });
res = mockRes();
await insights({ method: 'GET', query: {}, headers: { cookie: validCookie } }, res);
t('expired token reports token_expired', () =>
  assert.ok(res.code === 401 && res.body.error === 'token_expired'));
t('expired-token message is actionable', () => assert.match(res.body.message, /generate a new/i));
t('token is not leaked in an error response', () =>
  assert.ok(!JSON.stringify(res.body).includes('FAKE_TOKEN')));

globalThis.fetch = stubErr(403, { code: 200, message: 'Permissions error' });
res = mockRes();
await insights({ method: 'GET', query: {}, headers: { cookie: validCookie } }, res);
t('permission error reports insufficient_permission', () =>
  assert.ok(res.code === 403 && res.body.error === 'insufficient_permission'));
t('permission message names ads_read and View Performance', () =>
  assert.ok(/ads_read/.test(res.body.message) && /View Performance/.test(res.body.message)));

// Scoping to one campaign must reach Meta, not just filter in the browser.
var lastUrls = [];
globalThis.fetch = async (u) => { lastUrls.push(String(u)); return { ok: true, headers: { get: () => null }, json: async () => ({ data: DAILY }) }; };
res = mockRes();
await insights({ method: 'GET', query: { campaignId: '12345' }, headers: { cookie: validCookie } }, res);
t('campaign scope is sent to Meta as a filter', () =>
  assert.ok(lastUrls.some((u) => /campaign.id/.test(decodeURIComponent(u)) && /12345/.test(u))));
t('the scoped trend is not requested at account level', () =>
  assert.ok(lastUrls.some((u) => /time_increment/.test(u) && /level=campaign/.test(u))));
t('a non-numeric campaign id is ignored rather than passed through', async () => {
  lastUrls = [];
  const r2 = mockRes();
  await insights({ method: 'GET', query: { campaignId: "'; DROP" }, headers: { cookie: validCookie } }, r2);
  assert.ok(!lastUrls.some((u) => /DROP/i.test(decodeURIComponent(u))));
});

// Bad input.
globalThis.fetch = stubOk(() => DAILY);
res = mockRes();
await insights(
  { method: 'GET', query: { since: '2026-09-10', until: '2026-09-01' }, headers: { cookie: validCookie } },
  res,
);
t('reversed date range is rejected', () => assert.equal(res.code, 400));


/* --------------------------------------------------- roles and views ---- */
console.log('\nMaster password and view access');

const masterCookie = cookieOf(auth.createSessionCookie(SECRET, auth.ROLE_MASTER));
const daveCookie = validCookie; // created with the default role

t('the default role is the narrow one', () =>
  assert.equal(auth.readSession({ headers: { cookie: daveCookie } }, SECRET).role, auth.ROLE_DAVE));

t('a master cookie reads back as master', () =>
  assert.equal(auth.readSession({ headers: { cookie: masterCookie } }, SECRET).role, auth.ROLE_MASTER));

t('an unknown role in a signed payload degrades to the narrow role', () => {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 6e5, role: 'superuser' })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  assert.equal(
    auth.readSession({ headers: { cookie: 'sybago_dash=' + payload + '.' + sig } }, SECRET).role,
    auth.ROLE_DAVE,
  );
});

// THE ESCALATION THIS GUARDS: the role must come from the signed payload, so
// editing it in the cookie has to invalidate the signature rather than grant
// master access.
t('forging role=master into a cookie is rejected outright', () => {
  const raw = daveCookie.split('=')[1];
  const sig = raw.slice(raw.lastIndexOf('.') + 1);
  const forged = Buffer.from(JSON.stringify({ exp: Date.now() + 6e5, role: 'master' })).toString('base64url');
  assert.equal(auth.readSession({ headers: { cookie: 'sybago_dash=' + forged + '.' + sig } }, SECRET), null);
});

// Login issues the right tier.
async function signIn(password) {
  const r = mockRes();
  await login({ method: 'POST', body: { password }, headers: {}, socket: {} }, r);
  return r;
}

let lr = await signIn('daves-standard-password');
t('the standard password signs in as the narrow role', () =>
  assert.ok(lr.code === 200 && lr.body.role === auth.ROLE_DAVE));

lr = await signIn('the-master-password');
t('the master password signs in as master', () =>
  assert.ok(lr.code === 200 && lr.body.role === auth.ROLE_MASTER));
t('the master session cookie actually carries the master role', () =>
  assert.equal(
    auth.readSession({ headers: { cookie: cookieOf(lr.headers['Set-Cookie']) } }, SECRET).role,
    auth.ROLE_MASTER,
  ));

lr = await signIn('neither-of-them');
t('a wrong password is still rejected', () => assert.equal(lr.code, 401));

// A deployment that sets both passwords to the same string must not silently
// promote the standard password to master.
{
  const saved = process.env.DASHBOARD_MASTER_PASSWORD;
  process.env.DASHBOARD_MASTER_PASSWORD = process.env.DASHBOARD_PASSWORD;
  const r = await signIn(process.env.DASHBOARD_PASSWORD);
  t('identical passwords do not grant master', () =>
    assert.ok(r.code === 200 && r.body.role === auth.ROLE_DAVE));
  process.env.DASHBOARD_MASTER_PASSWORD = saved;
}

// View authorisation on the data endpoint.
globalThis.fetch = stubOk(() => DAILY);
res = mockRes();
await insights({ method: 'GET', query: { view: 'dave' }, headers: { cookie: daveCookie } }, res);
t('the narrow role may read its own view', () => assert.equal(res.code, 200));
t('the response names the view it answered for', () => assert.equal(res.body.view, 'dave'));

// THE BOUNDARY: a standard-password session must not reach the agency account.
reached = false;
globalThis.fetch = async () => { reached = true; throw new Error('unreachable'); };
res = mockRes();
await insights({ method: 'GET', query: { view: 'sybago' }, headers: { cookie: daveCookie } }, res);
t('the narrow role is refused the master-only view', () =>
  assert.ok(res.code === 403 && res.body.error === 'forbidden_view'));
t('Meta is never contacted for a refused view', () => assert.equal(reached, false));

// Master reaches the other account — and it must be the OTHER account.
lastUrls = [];
globalThis.fetch = async (u) => {
  lastUrls.push(String(u));
  return { ok: true, headers: { get: () => null }, json: async () => ({ data: DAILY }) };
};
res = mockRes();
await insights({ method: 'GET', query: { view: 'sybago' }, headers: { cookie: masterCookie } }, res);
t('master may read the agency view', () => assert.equal(res.code, 200));
t('the agency view queries the agency account', () =>
  assert.ok(lastUrls.length > 0 && lastUrls.every((u) => u.includes('act_777777'))));
t("the agency view never touches Dave's account", () =>
  assert.ok(!lastUrls.some((u) => u.includes('act_123456'))));

// An unknown view name falls back to the narrow account, never the wide one.
lastUrls = [];
res = mockRes();
await insights({ method: 'GET', query: { view: 'nonsense' }, headers: { cookie: daveCookie } }, res);
t('an unknown view falls back to the default account', () =>
  assert.ok(res.code === 200 && lastUrls.every((u) => u.includes('act_123456'))));

// A missing agency account id must be reported as configuration, not as a
// silent fallback to whichever account happens to be set.
{
  const saved = process.env.META_ADS_ACCOUNT_ID_SYBAGO;
  delete process.env.META_ADS_ACCOUNT_ID_SYBAGO;
  lastUrls = [];
  const r = mockRes();
  await insights({ method: 'GET', query: { view: 'sybago' }, headers: { cookie: masterCookie } }, r);
  t('an unset agency account id is a configuration error, not a fallback', () =>
    assert.ok(r.code === 500 && r.body.error === 'server_misconfigured'));
  t('the error names the variable to set', () =>
    assert.match(r.body.message, /META_ADS_ACCOUNT_ID_SYBAGO/));
  t('nothing is requested when the account is unset', () => assert.equal(lastUrls.length, 0));
  process.env.META_ADS_ACCOUNT_ID_SYBAGO = saved;
}

t('no password appears in any login response', () =>
  assert.ok(!JSON.stringify(lr.body).includes('the-master-password')));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
