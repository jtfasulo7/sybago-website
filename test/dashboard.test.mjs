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

/* The one-row aggregate for the whole window: account level, no daily
   increment. That ABSENCE is how the server asks for it, so it is how the stub
   recognises it — not by which fields are named or in what order. */
const isAggregate = (u) => {
  const url = String(u);
  return /level=account/.test(url) && !/time_increment/.test(url) && !/\/campaigns\b/.test(url);
};

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


/* ------------------------------------------------------- token routing ---- */
console.log('\nPer-view tokens');

const tokenOf = (u) => new URL(String(u)).searchParams.get('access_token');

// One token, two accounts: the ordinary case. A Meta token is scoped to a user,
// so it reads every account that user has a role on.
lastUrls = [];
globalThis.fetch = async (u) => {
  lastUrls.push(String(u));
  return { ok: true, headers: { get: () => null }, json: async () => ({ data: DAILY }) };
};
res = mockRes();
await insights({ method: 'GET', query: { view: 'sybago' }, headers: { cookie: masterCookie } }, res);
t('with one token configured, the agency view uses it', () =>
  assert.ok(lastUrls.length > 0 && lastUrls.every((u) => tokenOf(u) === process.env.META_ADS_TOKEN)));
t('the response names the credential it used', () =>
  assert.equal(res.body.tokenSource, 'META_ADS_TOKEN'));

// Two Business Managers with no shared user: a per-view token takes over.
{
  process.env.META_ADS_TOKEN_SYBAGO = 'SECOND_TOKEN_also_never_in_output_987654321';
  lastUrls = [];
  const r = mockRes();
  await insights({ method: 'GET', query: { view: 'sybago' }, headers: { cookie: masterCookie } }, r);
  t('a view-specific token overrides the shared one', () =>
    assert.ok(lastUrls.length > 0 && lastUrls.every((u) => tokenOf(u) === process.env.META_ADS_TOKEN_SYBAGO)));
  t('the response reports the view-specific credential', () =>
    assert.equal(r.body.tokenSource, 'META_ADS_TOKEN_SYBAGO'));

  // Dave must NOT pick up the agency token.
  lastUrls = [];
  const r2 = mockRes();
  await insights({ method: 'GET', query: { view: 'dave' }, headers: { cookie: masterCookie } }, r2);
  t("the agency token never leaks into Dave's requests", () =>
    assert.ok(lastUrls.every((u) => tokenOf(u) === process.env.META_ADS_TOKEN)));

  // THE LEAK THIS GUARDS: scrubSecrets once knew about a single token, so a
  // second one added later would have been the one credential it missed.
  globalThis.fetch = stubErr(400, {
    code: 1,
    message: 'Boom https://graph.facebook.com/x?access_token=' + process.env.META_ADS_TOKEN_SYBAGO,
  });
  const r3 = mockRes();
  await insights({ method: 'GET', query: { view: 'sybago' }, headers: { cookie: masterCookie } }, r3);
  t('an error never echoes the view-specific token', () =>
    assert.ok(!JSON.stringify(r3.body).includes('SECOND_TOKEN')));
  t('an error never echoes the shared token either', () =>
    assert.ok(!JSON.stringify(r3.body).includes('FAKE_TOKEN')));

  delete process.env.META_ADS_TOKEN_SYBAGO;
}

// The accounts diagnostic is master-only and must not emit a token.
globalThis.fetch = async (u) => {
  lastUrls.push(String(u));
  return {
    ok: true, headers: { get: () => null },
    json: async () => ({ data: [{ id: 'act_123456', name: 'Dave', account_status: 1 }] }),
  };
};
res = mockRes();
await insights({ method: 'GET', query: { debug: 'accounts' }, headers: { cookie: daveCookie } }, res);
t('the accounts diagnostic is refused to the narrow role', () => assert.equal(res.code, 403));

lastUrls = [];
res = mockRes();
await insights({ method: 'GET', query: { debug: 'accounts' }, headers: { cookie: masterCookie } }, res);
t('master may run the reachability diagnostic', () =>
  assert.ok(res.code === 200 && res.body.views && res.body.summary));
// Probing the account directly is the only check that works for a System User
// token, which is assigned assets rather than owning them.
t('a readable account is reported reachable', () =>
  assert.equal(res.body.views.dave.reachable, true));
t('the diagnostic names the token each view would use', () =>
  assert.equal(res.body.views.dave.tokenSource, 'META_ADS_TOKEN'));
t('the summary says no extra token is needed when all are reachable', () =>
  assert.match(res.body.summary, /No extra token needed/));
t('no token value appears in the diagnostic', () =>
  assert.ok(!JSON.stringify(res.body).includes('FAKE_TOKEN')));


/* ------------------------------------- error messages name the right var -- */
console.log('\nErrors name the failing credential');

// The two dashboards read two UNRELATED Meta businesses. An expired agency
// token that tells someone to regenerate META_ADS_TOKEN points them at the
// other business's credential entirely — so the variable in the message has to
// follow the view that failed.
process.env.META_ADS_TOKEN_SYBAGO = 'AGENCY_TOKEN_never_in_output_5555';

globalThis.fetch = stubErr(400, { code: 190, error_subcode: 463, message: 'Session has expired' });

res = mockRes();
await insights({ method: 'GET', query: { view: 'sybago' }, headers: { cookie: masterCookie } }, res);
t('an expired agency token names the agency variable', () =>
  assert.match(res.body.message, /META_ADS_TOKEN_SYBAGO/));
t("it does not name the other business's token", () =>
  assert.ok(!/META_ADS_TOKEN\b(?!_SYBAGO)/.test(res.body.message)));

res = mockRes();
await insights({ method: 'GET', query: { view: 'dave' }, headers: { cookie: masterCookie } }, res);
t("an expired token on Dave's view names the shared variable", () =>
  assert.ok(/META_ADS_TOKEN/.test(res.body.message) && !/SYBAGO/.test(res.body.message)));

// A cross-business permission failure must not send someone to Business
// Settings for an assignment that cannot exist.
globalThis.fetch = stubErr(403, { code: 200, message: 'Permissions error' });
res = mockRes();
await insights({ method: 'GET', query: { view: 'sybago' }, headers: { cookie: masterCookie } }, res);
t('a permission error explains the cross-business case too', () =>
  assert.match(res.body.message, /different business/i));
t('and still names the token variable that failed', () =>
  assert.match(res.body.message, /META_ADS_TOKEN_SYBAGO/));

// A bad account id should name that view's account variable.
globalThis.fetch = stubErr(400, { code: 100, message: 'Unsupported get request; object does not exist' });
res = mockRes();
await insights({ method: 'GET', query: { view: 'sybago' }, headers: { cookie: masterCookie } }, res);
t("an unloadable account names that view's account variable", () =>
  assert.match(res.body.message, /META_ADS_ACCOUNT_ID_SYBAGO/));

// A missing token must name the variable for the dashboard being asked for.
{
  const savedShared = process.env.META_ADS_TOKEN;
  delete process.env.META_ADS_TOKEN_SYBAGO;
  delete process.env.META_ADS_TOKEN;
  const r = mockRes();
  await insights({ method: 'GET', query: { view: 'sybago' }, headers: { cookie: masterCookie } }, r);
  t('a missing token is reported against the right dashboard', () =>
    assert.ok(r.code === 500 && /Montara Forge/.test(r.body.message)));
  process.env.META_ADS_TOKEN = savedShared;
}

delete process.env.META_ADS_TOKEN_SYBAGO;


/* ---------------------------------------------- blocked vs unpermitted ---- */
console.log('\nBlocked access is not a permission gap');

// Meta sends both of these on code 200, and the fix for one is useless for the
// other: an assignment in Business Settings solves a missing permission and does
// nothing at all for an enforcement block.
globalThis.fetch = stubErr(403, { code: 200, message: 'API access blocked.' });
res = mockRes();
await insights({ method: 'GET', query: {}, headers: { cookie: validCookie } }, res);
t('a blocked account is not reported as a missing permission', () =>
  assert.equal(res.body.error, 'api_access_blocked'));
t('it does not tell the reader to assign the System User', () =>
  assert.ok(!/assign the System User to it/i.test(res.body.message)));
t('it names where the restriction is actually visible', () =>
  assert.match(res.body.message, /accountquality/i));
t("it says a permission change will not help", () =>
  assert.match(res.body.message, /not a missing permission/i));
t('Meta\'s own words are preserved', () =>
  assert.match(res.body.detail || '', /API access blocked/));

// A genuine permission gap must still get the assignment advice.
globalThis.fetch = stubErr(403, { code: 200, message: 'Permissions error' });
res = mockRes();
await insights({ method: 'GET', query: {}, headers: { cookie: validCookie } }, res);
t('an ordinary permission error still advises assignment', () =>
  assert.ok(res.body.error === 'insufficient_permission' && /View Performance/.test(res.body.message)));

// A disabled account reads as enforcement too, whatever wording Meta picks.
globalThis.fetch = stubErr(400, { code: 100, message: 'Ad account is disabled' });
res = mockRes();
await insights({ method: 'GET', query: {}, headers: { cookie: validCookie } }, res);
t('a disabled ad account is classified as blocked, not as a bad id', () =>
  assert.equal(res.body.error, 'api_access_blocked'));


/* ------------------------------------------------ the picker lists assets ---- */
console.log('\nThe picker lists what exists, not what delivered');

/* THE BUG THIS GUARDS: the picker was built from an insights response, which
   only returns entities that DELIVERED in the window. A brand new ad set with
   no spend was invisible in the dropdown — exactly when someone wants to select
   it and watch it. It now reads the management tree instead. */
const TREE = [{
  id: 'c1',
  name: 'Dave - Campaign 1',
  status: 'ACTIVE',
  adsets: { data: [
    { id: 'as1', name: 'Dave - Ad Set 1', status: 'ACTIVE',
      ads: { data: [{ id: 'ad1', name: 'Dave Image Ad 1', status: 'ACTIVE' }] } },
    // No ads and no delivery — Meta omits the edge entirely rather than
    // returning it empty, which is the shape of something just created.
    { id: 'as2', name: 'Dave - Ad Set - Paid', status: 'PAUSED' },
  ] },
}, {
  // A campaign with no ad sets at all: the edge is absent, not empty.
  id: 'c2', name: 'Empty Campaign', status: 'PAUSED',
}];

globalThis.fetch = async (u) =>
  String(u).includes('/campaigns?') || /\/campaigns\b/.test(String(u))
    ? { ok: true, headers: { get: () => null }, json: async () => ({ data: TREE }) }
    : { ok: true, headers: { get: () => null }, json: async () => ({ data: DAILY }) };

res = mockRes();
await insights({ method: 'GET', query: {}, headers: { cookie: validCookie } }, res);

t('a brand new ad set with no delivery is offered', () => {
  const names = res.body.campaigns.flatMap((c) => c.adsets.map((a) => a.name));
  assert.ok(names.includes('Dave - Ad Set - Paid'), 'got ' + JSON.stringify(names));
});
t('an ad set with no ads does not break the tree', () => {
  const as2 = res.body.campaigns[0].adsets.find((a) => a.id === 'as2');
  assert.deepEqual(as2.ads, []);
});
t('a campaign with no ad sets does not break the tree', () => {
  const c2 = res.body.campaigns.find((c) => c.id === 'c2');
  assert.deepEqual(c2.adsets, []);
});
t('existing ad sets and their ads still come through', () => {
  const as1 = res.body.campaigns[0].adsets.find((a) => a.id === 'as1');
  assert.equal(as1.ads[0].name, 'Dave Image Ad 1');
});
t('status is carried so a paused asset can be labelled', () => {
  const as2 = res.body.campaigns[0].adsets.find((a) => a.id === 'as2');
  assert.equal(as2.status, 'PAUSED');
});
t('campaigns are sorted by name', () => {
  const names = res.body.campaigns.map((c) => c.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});

// The picker must not be narrowed by the date range — that was the whole bug.
{
  const urls = [];
  globalThis.fetch = async (u) => {
    urls.push(String(u));
    return /\/campaigns\b/.test(String(u))
      ? { ok: true, headers: { get: () => null }, json: async () => ({ data: TREE }) }
      : { ok: true, headers: { get: () => null }, json: async () => ({ data: DAILY }) };
  };
  const r = mockRes();
  await insights({
    method: 'GET',
    query: { since: '2026-09-06', until: '2026-09-06' },
    headers: { cookie: validCookie },
  }, r);
  const pickerUrl = urls.find((u) => /\/campaigns\b/.test(u));
  t('the picker request carries no date range', () =>
    assert.ok(pickerUrl && !/time_range|date_preset/.test(pickerUrl), pickerUrl));
  t('a one-day range still offers every ad set', () => {
    const names = r.body.campaigns.flatMap((c) => c.adsets.map((a) => a.name));
    assert.ok(names.includes('Dave - Ad Set - Paid'));
  });
}


/* ------------------------------------------------ reach is not a sum ----- */
console.log('\nReach is deduplicated, never summed');

{
  /* Three days, each reaching 4,000 people. Summing gives 12,000 — more than
     the 9,000 impressions that delivered them, which is impossible: a person
     cannot be reached without being shown the ad at least once. Meta's own
     deduplicated answer for the window is 5,000, and that is the only figure
     that can be correct. */
  const threeDays = [0, 1, 2].map((i) => ({
    date_start: `2026-09-0${i + 1}`, date_stop: `2026-09-0${i + 1}`,
    spend: '10.00', impressions: '3000', reach: '4000', frequency: '0.75',
    clicks: '10', inline_link_clicks: '8', ctr: '0.33', cpc: '1.00', cpm: '3.33',
  }));

  let dedupAsked = null;
  globalThis.fetch = async (u) => {
    const url = String(u);
    if (/\/campaigns\b/.test(url)) {
      return { ok: true, headers: { get: () => null }, json: async () => ({ data: [] }) };
    }
    /* The aggregate request is the one at ACCOUNT level with no daily
       increment. That absence is the whole mechanism — and it is checked that
       way rather than by which fields are named, so adding a field to the
       request cannot break a test about reach. */
    if (isAggregate(url)) {
      dedupAsked = url;
      return {
        ok: true,
        headers: { get: () => null },
        // Deliberately NOT 30.00/9000: the daily rows sum to that, so a total
        // reading 33.00 proves the aggregate answered and the sum did not.
        json: async () => ({ data: [{
          reach: '5000', frequency: '1.8', impressions: '9000', spend: '33.00',
          clicks: '30', inline_link_clicks: '24',
        }] }),
      };
    }
    return { ok: true, headers: { get: () => null }, json: async () => ({ data: threeDays }) };
  };

  const r = mockRes();
  await insights({ method: 'GET', query: {}, headers: { cookie: validCookie } }, r);

  t('reach is asked for separately, over the whole window', () =>
    assert.ok(dedupAsked, 'no deduplicated reach request was made'));

  t('reach is Meta\'s deduplicated figure, not the sum of the days', () => {
    assert.equal(r.body.totals.reach, 5000);
    assert.notEqual(r.body.totals.reach, 12000);
  });

  t('reach never exceeds impressions', () =>
    assert.ok(r.body.totals.reach <= r.body.totals.impressions,
      `reach ${r.body.totals.reach} > impressions ${r.body.totals.impressions}`));

  t('frequency is impressions over people, from the same two figures', () =>
    assert.equal(r.body.totals.frequency, 9000 / 5000));

  /* WHY THE TILES USED TO LAG. Everything except reach was summed from the
     time_increment=1 series, which Meta materialises separately from the
     aggregate and writes later for the current day. The tiles therefore trailed
     Ads Manager by however long that took. The aggregate is the figure Ads
     Manager itself reads. */
  t('spend comes from Meta\'s aggregate, not from summing the days', () => {
    assert.equal(r.body.totals.spend, 33);
    assert.notEqual(r.body.totals.spend, 30);   // 3 x 10.00, the daily sum
  });

  t('the response says which figure answered', () =>
    assert.equal(r.body.totalsSource, 'aggregate'));
}

{
  /* No aggregate row comes back for a window with no delivery. The daily sum
     answers instead, because falling back beats reporting a zero that is only
     an absent row. */
  const oneDay = [{
    date_start: '2026-09-01', date_stop: '2026-09-01',
    spend: '12.50', impressions: '900', reach: '700', frequency: '1.29',
    clicks: '9', inline_link_clicks: '7', ctr: '1', cpc: '1.39', cpm: '13.89',
  }];
  globalThis.fetch = async (u) => {
    const ok = (data) => ({ ok: true, headers: { get: () => null }, json: async () => ({ data }) });
    if (/\/campaigns\b/.test(String(u))) return ok([]);
    if (isAggregate(u)) return ok([]);          // Meta returns nothing at all
    return ok(oneDay);
  };
  const r = mockRes();
  await insights({ method: 'GET', query: {}, headers: { cookie: validCookie } }, r);

  t('a missing aggregate falls back to the daily series rather than to zero', () =>
    assert.equal(r.body.totals.spend, 12.5));
  t('and says so, so the fallback is visible rather than inferred', () =>
    assert.equal(r.body.totalsSource, 'daily-sum'));
}

{
  // No delivery in the window: Meta returns no row at all. That is a real zero,
  // not a fault, and the tile must read 0 rather than blank.
  globalThis.fetch = async (u) =>
    /\/campaigns\b/.test(String(u))
      ? { ok: true, headers: { get: () => null }, json: async () => ({ data: [] }) }
      : { ok: true, headers: { get: () => null }, json: async () => ({ data: [] }) };

  const r = mockRes();
  await insights({ method: 'GET', query: {}, headers: { cookie: validCookie } }, r);

  t('no delivery reports reach as zero, not undefined', () => {
    assert.equal(r.body.totals.reach, 0);
    assert.equal(r.body.totals.frequency, 0);
  });
}


/* --------------------------------------------- comparing ad sets --------- */
console.log('\nComparing several ad sets');

{
  const seen = [];
  const dayRow = (adsetId, name, date, spend) => ({
    adset_id: adsetId, adset_name: name,
    date_start: date, date_stop: date,
    spend: String(spend), impressions: '100', reach: '80', frequency: '1.25',
    clicks: '5', inline_link_clicks: '4', ctr: '5', cpc: '1', cpm: '10',
  });

  globalThis.fetch = async (u) => {
    const url = String(u);
    seen.push(url);
    if (/\/campaigns\b/.test(url)) {
      return { ok: true, headers: { get: () => null }, json: async () => ({ data: [] }) };
    }
    if (url.includes('fields=reach') && !url.includes('time_increment')) {
      return { ok: true, headers: { get: () => null }, json: async () => ({ data: [{ reach: '150', frequency: '1.3' }] }) };
    }
    return {
      ok: true, headers: { get: () => null },
      json: async () => ({ data: [
        dayRow('111', 'Dave Image', '2026-09-01', 10),
        dayRow('222', 'Vile Image', '2026-09-01', 20),
        dayRow('111', 'Dave Image', '2026-09-02', 11),
        dayRow('222', 'Vile Image', '2026-09-02', 21),
      ] }),
    };
  };

  const r = mockRes();
  await insights(
    { method: 'GET', query: { adsetIds: '111,222' }, headers: { cookie: validCookie } },
    r,
  );

  t('several ad sets split the series, so a line can be drawn for each', () =>
    assert.equal(r.body.seriesLevel, 'adset'));

  t('every daily row carries the ad set it belongs to', () => {
    const ids = new Set((r.body.daily || []).map((x) => x.adsetId));
    assert.deepEqual([...ids].sort(), ['111', '222']);
  });

  t('the series is requested at ad set level with the name attached', () => {
    // Without adset_name the chart has ids and no labels; without the level it
    // gets one merged row per day and every line would be identical.
    const series = seen.find((u) => u.includes('time_increment=1'));
    assert.ok(series, 'no daily series request');
    assert.match(decodeURIComponent(series), /level=adset/);
    assert.match(decodeURIComponent(series), /adset_name/);
  });

  t('both ad sets reach Meta as one filter, not two requests', () => {
    const series = seen.find((u) => u.includes('time_increment=1'));
    const f = decodeURIComponent(series);
    assert.match(f, /adset\.id/);
    assert.match(f, /111/);
    assert.match(f, /222/);
  });
}

{
  // ONE ad set is a scope, not a comparison: splitting would cost more and
  // return the same numbers, and the single-line path is what the metric
  // overlay expects.
  globalThis.fetch = async (u) =>
    /\/campaigns\b/.test(String(u))
      ? { ok: true, headers: { get: () => null }, json: async () => ({ data: [] }) }
      : { ok: true, headers: { get: () => null }, json: async () => ({ data: DAILY }) };

  const r = mockRes();
  await insights(
    { method: 'GET', query: { adsetIds: '111' }, headers: { cookie: validCookie } },
    r,
  );

  t('one ad set is a scope, not a split', () => {
    assert.equal(r.body.seriesLevel, 'aggregate');
    assert.equal(r.body.scope.adsetId, '111');
  });
}

{
  // The older single-value parameter still has to work: a bookmarked link, or
  // a client that has not reloaded, still sends it.
  globalThis.fetch = async (u) =>
    /\/campaigns\b/.test(String(u))
      ? { ok: true, headers: { get: () => null }, json: async () => ({ data: [] }) }
      : { ok: true, headers: { get: () => null }, json: async () => ({ data: DAILY }) };

  const r = mockRes();
  await insights(
    { method: 'GET', query: { adsetId: '999' }, headers: { cookie: validCookie } },
    r,
  );

  t('the older single adsetId parameter still scopes', () => {
    assert.equal(r.body.scope.adsetId, '999');
    assert.deepEqual(r.body.scope.adsetIds, ['999']);
  });
}

{
  // Ads are the narrower scope and win, exactly as they do in the filter.
  const seen = [];
  globalThis.fetch = async (u) => {
    seen.push(String(u));
    return /\/campaigns\b/.test(String(u))
      ? { ok: true, headers: { get: () => null }, json: async () => ({ data: [] }) }
      : { ok: true, headers: { get: () => null }, json: async () => ({ data: DAILY }) };
  };

  const r = mockRes();
  await insights(
    { method: 'GET', query: { adsetIds: '111,222', adIds: '777' }, headers: { cookie: validCookie } },
    r,
  );

  t('selecting an ad beats comparing ad sets', () => {
    assert.equal(r.body.seriesLevel, 'ad');
    const series = seen.find((u) => u.includes('time_increment=1'));
    assert.match(decodeURIComponent(series), /ad\.id/);
  });
}

{
  // An id from a query string reaches Meta's filter, so its shape is checked
  // rather than trusted.
  globalThis.fetch = async (u) =>
    /\/campaigns\b/.test(String(u))
      ? { ok: true, headers: { get: () => null }, json: async () => ({ data: [] }) }
      : { ok: true, headers: { get: () => null }, json: async () => ({ data: DAILY }) };

  const r = mockRes();
  await insights(
    { method: 'GET', query: { adsetIds: "111,DROP TABLE,222,'; --" }, headers: { cookie: validCookie } },
    r,
  );

  t('non-numeric ad set ids are dropped, not passed through', () =>
    assert.deepEqual(r.body.scope.adsetIds, ['111', '222']));
}


/* ------------------------------------------------------------ leads ------ */
console.log('\nLeads, whatever the account calls them');

/* The conversion event is a property of the ACCOUNT. Montara Forge's form fires
   Lead; Dave's Skool sign-up fires CompleteRegistration. */

const leadActions = [
  { action_type: 'lead', value: '2' },
  { action_type: 'offsite_conversion.fb_pixel_lead', value: '2' },
  { action_type: 'onsite_web_lead', value: '2' },
  { action_type: 'offsite_lead_add_20_s_calls', value: '2' },
  { action_type: 'landing_page_view', value: '41' },
];

const rowWith = (actions, costPer) => ({
  date_start: '2026-09-07', date_stop: '2026-09-07',
  spend: '40.00', impressions: '500', reach: '400', frequency: '1.25',
  clicks: '12', inline_link_clicks: '10', ctr: '2.4', cpc: '3.33', cpm: '80',
  actions,
  cost_per_action_type: costPer || [],
});

/* What Meta returns for that request: ONE row covering the window, carrying
   every action across it. A stub that replayed the daily rows here would hand
   back day one alone and read as an under-count. */
const aggregateOf = (rows) => {
  const sum = (k) => rows.reduce((n, r) => n + Number(r[k] || 0), 0);
  return {
    date_start: rows[0].date_start, date_stop: rows[rows.length - 1].date_stop,
    spend: sum('spend').toFixed(2),
    impressions: String(sum('impressions')),
    // Reach is NOT summed: Meta deduplicates people across the window, which is
    // the entire reason this request exists.
    reach: String(Math.max(...rows.map((r) => Number(r.reach || 0)))),
    clicks: String(sum('clicks')),
    inline_link_clicks: String(sum('inline_link_clicks')),
    ctr: rows[0].ctr, cpc: rows[0].cpc, cpm: rows[0].cpm,
    actions: rows.flatMap((r) => r.actions || []),
    cost_per_action_type: rows.flatMap((r) => r.cost_per_action_type || []),
    action_values: rows.flatMap((r) => r.action_values || []),
  };
};

const serve = (rows) => async (u) => {
  const ok = (data) => ({ ok: true, headers: { get: () => null }, json: async () => ({ data }) });
  if (/\/campaigns\b/.test(String(u))) return ok([]);
  if (isAggregate(u)) return ok(rows.length ? [aggregateOf(rows)] : []);
  return ok(rows);
};

{
  globalThis.fetch = serve([
    rowWith(leadActions, [{ action_type: 'offsite_conversion.fb_pixel_lead', value: '20.00' }]),
  ]);

  const r = mockRes();
  await insights(
    { method: 'GET', query: { view: 'sybago' }, headers: { cookie: masterCookie } },
    r,
  );

  t('a lead-optimised account reports its leads', () =>
    // The bug: this read 0 while the account was demonstrably producing leads.
    assert.equal(r.body.totals.registrations, 2));

  t('four aliases for the same conversion count once, not four times', () => {
    // Summing them would report 8 from 2, and look entirely plausible.
    assert.notEqual(r.body.totals.registrations, 8);
    assert.equal(r.body.totals.registrations, 2);
  });

  t('the alias that supplied the figure is named', () =>
    // The unified total, not a subset of it — see the next block for why.
    assert.equal(r.body.rows[0].registrationType, 'lead'));

  t('leads and landing page views stay separate figures', () => {
    assert.equal(r.body.totals.landingPageViews, 41);
    assert.notEqual(r.body.totals.registrations, 43);
  });
}

{
  /* THE BUG THIS FIXED: the dashboard read low on a real account.
     `offsite_conversion.fb_pixel_lead` counts WEBSITE leads only and
     `onsite_conversion.lead_grouped` counts instant-form leads only, while
     `lead` is Meta's unified total and the number Ads Manager shows. With a
     subset first, an account running both reported just the website half and
     said nothing about the rest. */
  globalThis.fetch = serve([
    rowWith([
      { action_type: 'lead', value: '5' },                              // Ads Manager's figure
      { action_type: 'offsite_conversion.fb_pixel_lead', value: '2' },  // website only
      { action_type: 'onsite_conversion.lead_grouped', value: '3' },    // instant forms only
    ]),
  ]);

  const r = mockRes();
  await insights({ method: 'GET', query: { view: 'sybago' }, headers: { cookie: masterCookie } }, r);

  t('a mixed lead account reports the unified total, not the website half', () => {
    assert.equal(r.body.totals.registrations, 5);
    assert.notEqual(r.body.totals.registrations, 2);
  });

  t('and does not sum the subsets into a double count', () =>
    // 5 + 2 + 3 = 10 would be the same lead counted three times.
    assert.notEqual(r.body.totals.registrations, 10));
}

{
  // An account that only ever reports the pixel alias still works — the
  // unified name simply is not present to be preferred.
  globalThis.fetch = serve([
    rowWith([{ action_type: 'offsite_conversion.fb_pixel_lead', value: '4' }]),
  ]);
  const r = mockRes();
  await insights({ method: 'GET', query: { view: 'sybago' }, headers: { cookie: masterCookie } }, r);

  t('a website-only account falls through to the pixel alias', () => {
    assert.equal(r.body.totals.registrations, 4);
    assert.equal(r.body.rows[0].registrationType, 'offsite_conversion.fb_pixel_lead');
  });
}

{
  /* THE BUG THIS GUARDS, and the reason the families are not one list.
     Dave's account really does carry both: 17 complete_registration from Skool
     and 16 lead left over from unrelated older campaigns. A shared list
     resolves per row and totals 33 — two different conversions added together,
     which is a number that means nothing and looks entirely reasonable. */
  globalThis.fetch = serve([
    rowWith([{ action_type: 'offsite_conversion.fb_pixel_complete_registration', value: '17' }]),
    rowWith([{ action_type: 'lead', value: '16' }]),
  ]);

  const r = mockRes();
  await insights({ method: 'GET', query: { view: 'dave' }, headers: { cookie: masterCookie } }, r);

  t('an account carrying both families counts only the one it converts on', () => {
    assert.equal(r.body.totals.registrations, 17);
    assert.notEqual(r.body.totals.registrations, 33);
  });

  t('the family is fixed by the account and reported back', () =>
    assert.equal(r.body.conversionFamily, 'registration'));
}

{
  // And the mirror: a lead account ignores stray registration events.
  globalThis.fetch = serve([
    rowWith([{ action_type: 'complete_registration', value: '99' }]),
    rowWith([{ action_type: 'lead', value: '2' }]),
  ]);

  const r = mockRes();
  await insights({ method: 'GET', query: { view: 'sybago' }, headers: { cookie: masterCookie } }, r);

  t('a lead account ignores stray registration events', () => {
    assert.equal(r.body.totals.registrations, 2);
    assert.notEqual(r.body.totals.registrations, 101);
  });

  t('the lead account reports its family', () =>
    assert.equal(r.body.conversionFamily, 'lead'));
}

{
  // The family must not be selectable from the query string — that would let a
  // caller relabel one account's conversions as another's.
  globalThis.fetch = serve([rowWith(leadActions)]);
  const r = mockRes();
  await insights(
    { method: 'GET', query: { view: 'dave', conversion: 'lead', conversionFamily: 'lead' },
      headers: { cookie: masterCookie } },
    r,
  );

  t('the conversion family cannot be chosen by the caller', () => {
    assert.equal(r.body.conversionFamily, 'registration');
    assert.equal(r.body.totals.registrations, 0);
  });
}


/* ------------------------------------------- several campaigns at once --- */
console.log('\nSeveral campaigns at once');

{
  const seen = [];
  globalThis.fetch = async (u) => {
    seen.push(String(u));
    return /\/campaigns\b/.test(String(u))
      ? { ok: true, headers: { get: () => null }, json: async () => ({ data: [] }) }
      : { ok: true, headers: { get: () => null }, json: async () => ({ data: DAILY }) };
  };

  const r = mockRes();
  await insights(
    { method: 'GET', query: { campaignIds: '111,222' }, headers: { cookie: validCookie } },
    r,
  );

  t('both campaigns reach Meta as one filter', () => {
    const series = seen.find((u) => u.includes('time_increment=1'));
    const f = decodeURIComponent(series);
    assert.match(f, /campaign\.id/);
    assert.match(f, /111/);
    assert.match(f, /222/);
  });

  t('the scope reports the list it was given', () =>
    assert.deepEqual(r.body.scope.campaignIds, ['111', '222']));

  t('campaignId stays null when several are in scope', () =>
    // It names THE campaign, and with two there is no such thing. A caller
    // reading it as "the first one" would be silently wrong.
    assert.equal(r.body.scope.campaignId, null));
}

{
  globalThis.fetch = async (u) =>
    /\/campaigns\b/.test(String(u))
      ? { ok: true, headers: { get: () => null }, json: async () => ({ data: [] }) }
      : { ok: true, headers: { get: () => null }, json: async () => ({ data: DAILY }) };

  const r = mockRes();
  await insights(
    { method: 'GET', query: { campaignId: '999' }, headers: { cookie: validCookie } },
    r,
  );

  t('the older single campaignId parameter still scopes', () => {
    // A bookmarked link, or a client that has not reloaded, still sends it.
    assert.equal(r.body.scope.campaignId, '999');
    assert.deepEqual(r.body.scope.campaignIds, ['999']);
  });
}

{
  globalThis.fetch = async (u) =>
    /\/campaigns\b/.test(String(u))
      ? { ok: true, headers: { get: () => null }, json: async () => ({ data: [] }) }
      : { ok: true, headers: { get: () => null }, json: async () => ({ data: DAILY }) };

  const r = mockRes();
  await insights(
    { method: 'GET', query: { campaignIds: "111,DROP TABLE,'; --,222" }, headers: { cookie: validCookie } },
    r,
  );

  t('non-numeric campaign ids are dropped, not passed through', () =>
    // These reach Meta's filter, so the shape is checked rather than trusted.
    assert.deepEqual(r.body.scope.campaignIds, ['111', '222']));
}

{
  // An ad set beats a campaign, which beats nothing — the narrowest scope wins,
  // and the filter must carry exactly one of them.
  const seen = [];
  globalThis.fetch = async (u) => {
    seen.push(String(u));
    return /\/campaigns\b/.test(String(u))
      ? { ok: true, headers: { get: () => null }, json: async () => ({ data: [] }) }
      : { ok: true, headers: { get: () => null }, json: async () => ({ data: DAILY }) };
  };
  const r = mockRes();
  await insights(
    { method: 'GET', query: { campaignIds: '111,222', adsetIds: '333' }, headers: { cookie: validCookie } },
    r,
  );
  t('an ad set scope beats the campaign list', () => {
    const f = decodeURIComponent(seen.find((u) => u.includes('time_increment=1')));
    assert.match(f, /adset\.id/);
    assert.ok(!/campaign\.id/.test(f), 'campaign filter should not also be applied');
  });
}


/* ------------------------------------------------------- pixel totals ---- */
console.log('\nWhat the pixel saw, against what the ads got credit for');

/* Insights and Events Manager are different datasets. Insights reports only the
   conversions Meta could attribute to an ad; the pixel reports every event it
   received. Montara Forge's five leads against two attributed ones is that gap,
   not a bug — so both figures are carried, separately and plainly labelled. */

// aggregation=event returns hourly buckets, each holding per-event rows.
const PIXEL_OK = {
  data: [
    { aggregation: 'event', start_time: '2026-09-01T00:00:00+0000',
      data: [{ value: 'Lead', count: 2 }, { value: 'PageView', count: 140 }] },
    { aggregation: 'event', start_time: '2026-09-01T01:00:00+0000',
      data: [{ value: 'Lead', count: 3 }, { value: 'ViewContent', count: 11 }] },
  ],
};

const pixelStub = (payload) => async (u) => {
  const url = String(u);
  if (url.includes('/stats')) {
    return { ok: true, headers: { get: () => null }, json: async () => payload };
  }
  if (url.includes('/adspixels')) {
    return { ok: true, headers: { get: () => null }, json: async () => ({ data: [{ id: '99887766' }] }) };
  }
  return { ok: true, headers: { get: () => null }, json: async () => ({ data: DAILY }) };
};

{
  const seen = [];
  globalThis.fetch = async (u) => { seen.push(String(u)); return pixelStub(PIXEL_OK)(u); };
  const r = mockRes();
  await insights(
    { method: 'GET', query: { view: 'sybago', since: '2026-09-01', until: '2026-09-07' },
      headers: { cookie: masterCookie } },
    r,
  );

  t('the pixel total counts every event, not only the attributed ones', () =>
    assert.equal(r.body.pixelTotal.total, 5));

  t('hourly buckets are summed rather than the first one being taken', () =>
    // Two buckets of 2 and 3. Reading only one gives 2 or 3 — which is exactly
    // the under-count this whole feature exists to correct.
    assert.notEqual(r.body.pixelTotal.total, 2));

  t('other events in the same bucket are not swept in', () =>
    // PageView 140 and ViewContent 11 sit alongside Lead in the payload.
    assert.equal(r.body.pixelTotal.total, 5));

  t('the event it counted is named', () =>
    assert.equal(r.body.pixelTotal.event, 'Lead'));

  t('the pixel figure is kept apart from the attributed conversions', () =>
    // Merging them would produce a number that answers neither question.
    assert.notEqual(r.body.totals.registrations, r.body.pixelTotal.total));

  t('the pixel window is the one the charts use', () => {
    const stats = seen.find((u) => u.includes('/stats'));
    const q = new URL(stats).searchParams;
    assert.equal(new Date(Number(q.get('start_time')) * 1000).toISOString().slice(0, 10), '2026-09-01');
    assert.equal(new Date(Number(q.get('end_time')) * 1000).toISOString().slice(0, 10), '2026-09-07');
  });

  t('the pixel id is discovered from the ad account, not hard-coded', () =>
    assert.equal(r.body.pixelTotal.pixelId, '99887766'));

  t('the token does not appear anywhere in the pixel response', () =>
    assert.ok(!JSON.stringify(r.body).includes(process.env.META_ADS_TOKEN)));
}

{
  // Meta documents the row type only as list<AdsPixelStats>, with no field
  // names at all. Rather than guess, an unreadable row reports nothing.
  globalThis.fetch = pixelStub({ data: [{ data: [{ mystery_field: 'Lead', tally: 5 }] }] });
  const r = mockRes();
  await insights({ method: 'GET', query: { view: 'sybago' }, headers: { cookie: masterCookie } }, r);
  t('an unrecognised row shape reports null, never zero', () => {
    assert.equal(r.body.pixelTotal.total, null);
    assert.equal(r.body.pixelTotal.reason, 'event-not-found');
  });
}

{
  globalThis.fetch = pixelStub({ data: [] });
  const r = mockRes();
  await insights({ method: 'GET', query: { view: 'sybago' }, headers: { cookie: masterCookie } }, r);
  t('an empty payload reads as unknown rather than as no leads', () =>
    assert.equal(r.body.pixelTotal.total, null));
}

{
  // The pixel figure is context beside the headline number. If reading it
  // fails, the dashboard still has to render everything else.
  globalThis.fetch = async (u) => {
    if (String(u).includes('/stats') || String(u).includes('/adspixels')) {
      return { ok: false, status: 400, headers: { get: () => null },
        json: async () => ({ error: { code: 100, message: 'nonexistent pixel' } }) };
    }
    return { ok: true, headers: { get: () => null }, json: async () => ({ data: DAILY }) };
  };
  const r = mockRes();
  await insights({ method: 'GET', query: { view: 'sybago' }, headers: { cookie: masterCookie } }, r);
  t('a pixel failure does not take the dashboard down with it', () => {
    assert.equal(r.code, 200);
    assert.ok(r.body.totals.impressions > 0);
  });
  t('and the failure is reported rather than shown as zero', () =>
    assert.equal(r.body.pixelTotal.total, null));
}

{
  // Dave's account converts on CompleteRegistration, Montara Forge on Lead.
  // Reading the wrong event would quietly report another campaign's number.
  globalThis.fetch = pixelStub({
    data: [{ data: [{ value: 'CompleteRegistration', count: 9 }, { value: 'Lead', count: 4 }] }],
  });
  const r = mockRes();
  await insights({ method: 'GET', query: {}, headers: { cookie: validCookie } }, r);
  t('each account reads its own pixel event', () => {
    assert.equal(r.body.pixelTotal.event, 'CompleteRegistration');
    assert.equal(r.body.pixelTotal.total, 9);
  });
}


/* ------------------------------------ the conversions a family misses ---- */
console.log('\nConversions Meta attributed under another event');

/* FROM THE LIVE ACCOUNT, 2026-09-11. act_4518527871759174, pixel
   1455782335534012, 2026-08-23 to 2026-09-11.

   Events Manager showed 5 Lead events. The dashboard showed 2. Four causes
   stacked, and the largest was a default ad set — see the Scope block below.
   This block covers the other one: the Sep 9 submission came back ONLY as
   offsite_conversion.fb_pixel_custom, with no lead action on that day at all, so
   the lead family could not see it and it vanished silently. */

{
  const row = (actions) => ({
    date_start: '2026-09-09', date_stop: '2026-09-09',
    spend: '28.98', impressions: '832', reach: '770', frequency: '1.08',
    clicks: '13', inline_link_clicks: '5', ctr: '1.56', cpc: '2.23', cpm: '34.83',
    actions,
  });
  globalThis.fetch = serve([
    row([
      { action_type: 'link_click', value: '5' },
      { action_type: 'offsite_conversion.fb_pixel_custom', value: '1' },
      { action_type: 'landing_page_view', value: '4' },
    ]),
  ]);
  const r = mockRes();
  await insights({ method: 'GET', query: { view: 'sybago' }, headers: { cookie: masterCookie } }, r);

  t('a conversion outside the family is reported rather than dropped', () =>
    assert.deepEqual(r.body.totals.otherConversions,
      [{ actionType: 'offsite_conversion.fb_pixel_custom', count: 1 }]));

  t('and is NOT added to the lead count', () =>
    /* A custom conversion can be a rule built ON the same event, so summing
       the two would count one submission twice — the mistake that turned
       Dave's 17 registrations into 33. */
    assert.equal(r.body.totals.registrations, 0));
}

{
  // A lead AND a custom conversion on the same day stay two separate figures.
  globalThis.fetch = serve([
    rowWith([
      { action_type: 'lead', value: '1' },
      { action_type: 'offsite_conversion.fb_pixel_lead', value: '1' },
      { action_type: 'offsite_conversion.fb_pixel_custom', value: '1' },
    ]),
  ]);
  const r = mockRes();
  await insights({ method: 'GET', query: { view: 'sybago' }, headers: { cookie: masterCookie } }, r);

  t('the lead count stays the lead count', () =>
    assert.equal(r.body.totals.registrations, 1));
  t('the custom conversion is carried alongside, not merged in', () =>
    assert.equal(r.body.totals.otherConversions[0].count, 1));
  t('and never appears as two leads', () =>
    assert.notEqual(r.body.totals.registrations, 2));
}

{
  // Nothing outside the family: an empty list, not a missing key the client
  // then has to guard.
  globalThis.fetch = serve([rowWith([{ action_type: 'lead', value: '3' }])]);
  const r = mockRes();
  await insights({ method: 'GET', query: { view: 'sybago' }, headers: { cookie: masterCookie } }, r);
  t('no stray conversions reports an empty list', () =>
    assert.deepEqual(r.body.totals.otherConversions, []));
}

/* --------------------------------------------- scope must be visible ---- */
console.log('\nA scoped figure must not read as a total');

{
  /* THE ROOT CAUSE. The Montara Forge campaign runs three ad sets and the
     leads split 0 / 1 / 2 across them:

       Montara Forge Ad Set 1 .............. 0
       CONTACT - Montara Forge Ad Set 1 .... 1
       LEAD - Montara Forge Ad Set 1 ....... 2

     VIEW_DEFAULTS.sybago named 'Lead Montara Forge Ad Set 1', and findByName
     normalises punctuation, so it resolved exactly onto the LEAD ad set. The
     page opened showing 2 of the campaign's 3 leads and nothing beside the
     number said it was filtered.

     The dashboard's defaults are client-side, so what is asserted here is the
     server half: an ad set scope REACHES Meta as a filter, and the response
     states the scope it answered under. */
  const seen = [];
  globalThis.fetch = async (u) => {
    seen.push(String(u));
    return /\/campaigns\b/.test(String(u))
      ? { ok: true, headers: { get: () => null }, json: async () => ({ data: [] }) }
      : { ok: true, headers: { get: () => null }, json: async () => ({ data: DAILY }) };
  };
  const r = mockRes();
  await insights(
    { method: 'GET', query: { view: 'sybago', adsetIds: '120256163870610583' },
      headers: { cookie: masterCookie } },
    r,
  );

  t('an ad set scope reaches Meta as a filter', () => {
    const f = decodeURIComponent(seen.find((u) => u.includes('time_increment=1')));
    assert.match(f, /adset\.id/);
    assert.match(f, /120256163870610583/);
  });

  t('the response names the scope it answered under', () =>
    // The client needs this to say WHAT the figure was filtered to. Without
    // it, a third of a campaign is indistinguishable from all of it.
    assert.deepEqual(r.body.scope.adsetIds, ['120256163870610583']));

  t('the aggregate row is filtered by the same scope', () =>
    // Otherwise the tiles would report the whole account while the charts
    // reported one ad set — the two halves of the page disagreeing.
    assert.ok(seen.some((u) =>
      u.includes('level=account') && !u.includes('time_increment') && u.includes('filtering'))));
}


/* ------------------------------------------------- rolling date windows -- */
console.log('\nRolling windows belong to Meta, not to the caller');

/* The dashboard read "Showing 2026-09-06 to 2026-09-12" on the evening of the
   11th — a day that had not happened. iso() was toISOString().slice(0,10),
   which is UTC, so after 20:00 Eastern it already reported tomorrow. Every
   computed window shifted forward a day: "last 7 days" dropped a real day of
   delivery off the start and added a nonexistent one to the end. */

{
  const seen = [];
  globalThis.fetch = async (u) => {
    seen.push(String(u));
    return /\/campaigns\b/.test(String(u))
      ? { ok: true, headers: { get: () => null }, json: async () => ({ data: [] }) }
      : { ok: true, headers: { get: () => null }, json: async () => ({ data: DAILY }) };
  };
  const r = mockRes();
  await insights({ method: 'GET', query: { preset: 'last_7d' }, headers: { cookie: validCookie } }, r);

  t('a rolling preset reaches Meta as a preset, not as computed dates', () => {
    const series = seen.find((u) => u.includes('time_increment=1'));
    assert.match(series, /date_preset=last_7d/);
    assert.ok(!/time_range/.test(series), 'time_range must not also be sent');
  });

  t('the window reported back is the one Meta answered for', () =>
    // Read off the returned rows, never echoed from the request — otherwise
    // the x-axis is drawn against dates the data does not belong to.
    assert.equal(r.body.range.since, DAILY[0].date_start));
}

{
  // Only the known presets. Anything else is a caller trying its luck, and a
  // date_preset Meta does not recognise fails the whole request.
  const seen = [];
  globalThis.fetch = async (u) => {
    seen.push(String(u));
    return /\/campaigns\b/.test(String(u))
      ? { ok: true, headers: { get: () => null }, json: async () => ({ data: [] }) }
      : { ok: true, headers: { get: () => null }, json: async () => ({ data: DAILY }) };
  };
  const r = mockRes();
  await insights(
    { method: 'GET', query: { preset: 'last_3d; DROP', since: '2026-09-01', until: '2026-09-07' },
      headers: { cookie: validCookie } },
    r,
  );
  t('an unknown preset is ignored and the explicit dates are used', () => {
    const series = decodeURIComponent(seen.find((u) => u.includes('time_increment=1')));
    assert.ok(!/date_preset/.test(series), 'no date_preset should be sent');
    assert.match(series, /2026-09-01/);
  });
}

{
  /* The anchor: what the filtered tiles are a subset of. "Leads 1" gives no way
     to tell a quiet day apart from a broken page unless the whole-account
     figure is beside it. */
  globalThis.fetch = async (u) => {
    const url = String(u);
    const ok = (data) => ({ ok: true, headers: { get: () => null }, json: async () => ({ data }) });
    if (/\/campaigns\b/.test(url)) return ok([]);
    if (/date_preset=maximum/.test(url) && !/filtering/.test(url)) {
      // Unfiltered lifetime: three leads across everything.
      return ok([{ ...DAILY[0], spend: '221.92',
        actions: [{ action_type: 'lead', value: '3' }] }]);
    }
    return ok(DAILY);
  };
  const r = mockRes();
  await insights(
    { method: 'GET', query: { view: 'sybago', adsetIds: '120256163870610583' },
      headers: { cookie: masterCookie } },
    r,
  );

  t('a filtered request also fetches the unfiltered lifetime anchor', () => {
    assert.ok(r.body.lifetime, 'lifetime anchor missing');
    assert.equal(r.body.lifetime.registrations, 3);
  });

  t('the anchor is NOT filtered by the current scope', () =>
    // If it were, it would report the same number as the tiles and explain
    // nothing at all.
    assert.notEqual(r.body.lifetime.registrations, r.body.totals.registrations));
}

{
  // Already unfiltered lifetime: the anchor would be the identical request, so
  // it is not made.
  let maximumCalls = 0;
  globalThis.fetch = async (u) => {
    const url = String(u);
    if (/date_preset=maximum/.test(url) && !/time_increment/.test(url)) maximumCalls++;
    return /\/campaigns\b/.test(url)
      ? { ok: true, headers: { get: () => null }, json: async () => ({ data: [] }) }
      : { ok: true, headers: { get: () => null }, json: async () => ({ data: DAILY }) };
  };
  const r = mockRes();
  await insights({ method: 'GET', query: { preset: 'maximum' }, headers: { cookie: validCookie } }, r);
  t('an unfiltered lifetime view does not fetch a duplicate anchor', () =>
    assert.equal(r.body.lifetime, null));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
