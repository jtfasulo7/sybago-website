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

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
