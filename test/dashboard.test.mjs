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

const auth = await import('../lib/auth.js');
const { default: insights } = await import('../api/meta-insights.js');

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
    { action_type: 'offsite_conversion.fb_pixel_complete_registration', value: '6' },
  ],
  cost_per_action_type: [{ action_type: 'offsite_conversion.fb_pixel_complete_registration', value: '7.02' }],
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
t('conversion is detected as the result', () => assert.equal(res.body.results.available, true));
t('cost per result is surfaced', () => assert.equal(res.body.rows[0].costPerResult, 7.02));
t('ROAS is computed from action_values', () =>
  assert.ok(Math.abs(res.body.rows[0].roas - 180 / 42.1) < 1e-9));
t('totals are summed from the daily series', () => assert.equal(res.body.totals.spend, 42.1));
t('response is marked no-store', () => assert.match(res.headers['Cache-Control'] || '', /no-store/));
t('token is absent from the response', () =>
  assert.ok(!JSON.stringify(res.body).includes('FAKE_TOKEN')));

// Clicks-only account must say so rather than imply conversions.
const NO_CONV = [{ ...DAILY[0], actions: [{ action_type: 'link_click', value: '71' }], cost_per_action_type: [], action_values: [] }];
globalThis.fetch = stubOk(() => NO_CONV);
res = mockRes();
await insights({ method: 'GET', query: {}, headers: { cookie: validCookie } }, res);
t('absence of conversion events is flagged', () => assert.equal(res.body.results.available, false));
t('the click proxy is explained in plain language', () =>
  assert.match(res.body.results.note || '', /proxy|link click/i));

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

// Bad input.
globalThis.fetch = stubOk(() => DAILY);
res = mockRes();
await insights(
  { method: 'GET', query: { since: '2026-09-10', until: '2026-09-01' }, headers: { cookie: validCookie } },
  res,
);
t('reversed date range is rejected', () => assert.equal(res.code, 400));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
