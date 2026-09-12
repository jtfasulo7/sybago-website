/**
 * Tests for the AI analysis panels.
 *
 * No credentials and no network: the Anthropic API and the blob store are both
 * stubbed, so this is safe to run any time.
 *
 *     node test/analysis.test.mjs
 *
 * The point of these is the same as the dashboard's own: the security boundary
 * and the money. An unauthenticated request must never reach Anthropic, a
 * narrow session must never read the agency account, the API key must never
 * appear in a response, and a page load must never cost a model call.
 */

import assert from 'node:assert';

process.env.DASHBOARD_SESSION_SECRET = 's'.repeat(40);
process.env.DASHBOARD_PASSWORD = 'daves-standard-password';
process.env.DASHBOARD_MASTER_PASSWORD = 'the-master-password';
process.env.ANTHROPIC_API_KEY = 'sk-ant-FAKE-should-never-appear-in-output-0123456789';

const auth = await import('../lib/auth.js');
const prompts = await import('../lib/analysis-prompts.js');
const { default: analysis } = await import('../api/ads-analysis.js');

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
const cookieOf = (c) => c.split(';')[0];
const daveCookie = cookieOf(auth.createSessionCookie(SECRET, auth.ROLE_DAVE));
const masterCookie = cookieOf(auth.createSessionCookie(SECRET, auth.ROLE_MASTER));

function mockRes() {
  const r = { code: 200, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}

/* A believable model reply. */
const REPLY = {
  verdict: 'concerning',
  headline: 'Spend is converting below breakeven.',
  finding: 'CTR is 0.62%, under the 1% floor.\n\nCPM is healthy at $12, so the ad is being shown and not tapped.',
  recommendation: 'Replace the opening frame on the winning concept.',
  flag: { level: 'critical', text: 'Ad 3 has spent $52 with no signups.' },
};

const anthropicOk = (payload) => async () => ({
  ok: true,
  json: async () => ({ content: [{ type: 'text', text: JSON.stringify(payload ?? REPLY) }] }),
});

const KPI_BODY = {
  panel: 'kpi',
  view: 'dave',
  range: { since: '2026-09-01', until: '2026-09-11' },
  totals: { spend: 120, impressions: 40000, ctr: 0.62, cpm: 12, registrations: 2, costPerRegistration: 60 },
  rows: [{ name: 'Ad 3', level: 'ad', spend: 52, registrations: 0 }],
};

/* ------------------------------------------------------------- security -- */
console.log('\nThe boundary');

let reached = false;
globalThis.fetch = async () => { reached = true; throw new Error('unreachable'); };

let res = mockRes();
await analysis({ method: 'POST', query: {}, body: KPI_BODY, headers: {} }, res);
t('an unauthenticated request is refused', () => assert.equal(res.code, 401));
t('and Anthropic is never contacted for it', () => assert.equal(reached, false));

res = mockRes();
await analysis(
  { method: 'POST', query: {}, body: { ...KPI_BODY, view: 'sybago' }, headers: { cookie: daveCookie } },
  res,
);
t('the narrow role is refused the agency view', () => assert.equal(res.code, 403));
t('and that refusal costs no model call either', () => assert.equal(reached, false));

res = mockRes();
await analysis({ method: 'POST', query: {}, body: { ...KPI_BODY, panel: 'everything' }, headers: { cookie: masterCookie } }, res);
t('an unknown panel is rejected', () => assert.equal(res.code, 400));

res = mockRes();
await analysis({ method: 'POST', query: {}, body: { ...KPI_BODY, view: 'not-an-account' }, headers: { cookie: masterCookie } }, res);
t('an unknown view is rejected', () => assert.equal(res.code, 400));

/* ------------------------------------------------------ generate vs read -- */
console.log('\nA page load must not cost a model call');

{
  let calls = 0;
  globalThis.fetch = async (...a) => { calls++; return anthropicOk()(...a); };
  const r = mockRes();
  await analysis({ method: 'GET', query: { panel: 'kpi', view: 'dave' }, headers: { cookie: daveCookie } }, r);
  t('GET never generates', () => assert.equal(calls, 0));
  t('GET answers with the cache, empty or not', () =>
    assert.ok(Object.prototype.hasOwnProperty.call(r.body, 'analysis')));
}

{
  globalThis.fetch = anthropicOk();
  const r = mockRes();
  await analysis({ method: 'POST', query: {}, body: KPI_BODY, headers: { cookie: daveCookie } }, r);

  t('POST returns the parsed analysis', () => {
    assert.equal(r.code, 200);
    assert.equal(r.body.analysis.headline, REPLY.headline);
    assert.equal(r.body.analysis.verdict, 'concerning');
  });
  t('the flag survives with its level', () => {
    assert.equal(r.body.analysis.flag.level, 'critical');
    assert.match(r.body.analysis.flag.text, /\$52/);
  });
  t('paragraph breaks in the finding are preserved', () =>
    // The panel splits on a blank line to render separate <p>s. A sanitiser
    // that stripped \n would collapse every analysis into one block.
    assert.ok(r.body.analysis.finding.includes('\n\n')));
  t('a timestamp comes back', () => assert.ok(!isNaN(Date.parse(r.body.generatedAt))));
}

/* --------------------------------------------------------------- secrets -- */
console.log('\nThe key never leaves the server');

{
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    // An upstream that echoes the key back is exactly what the scrubber is for.
    json: async () => ({ error: { message: `bad key ${process.env.ANTHROPIC_API_KEY}` } }),
  });
  const r = mockRes();
  await analysis({ method: 'POST', query: {}, body: KPI_BODY, headers: { cookie: daveCookie } }, r);
  t('an upstream error never carries the key', () =>
    assert.ok(!JSON.stringify(r.body).includes(process.env.ANTHROPIC_API_KEY)));
  t('and it is reported as a failure, not as an analysis', () => assert.equal(r.code, 502));
}

{
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'x' } }) });
  const r = mockRes();
  await analysis({ method: 'POST', query: {}, body: KPI_BODY, headers: { cookie: daveCookie } }, r);
  t('a rejected key is named as such', () => assert.equal(r.body.error, 'anthropic_unauthorized'));
}

{
  globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'slow down' } }) });
  const r = mockRes();
  await analysis({ method: 'POST', query: {}, body: KPI_BODY, headers: { cookie: daveCookie } }, r);
  t('rate limiting is distinguishable from a real failure', () =>
    assert.equal(r.body.error, 'anthropic_rate_limited'));
}

/* ---------------------------------------------------------------- parsing -- */
console.log('\nReading the model');

{
  // Models fence JSON given half a chance. A fence is a formatting slip, not a
  // reason to show the reader an error.
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ content: [{ text: '```json\n' + JSON.stringify(REPLY) + '\n```' }] }),
  });
  const r = mockRes();
  await analysis({ method: 'POST', query: {}, body: KPI_BODY, headers: { cookie: daveCookie } }, r);
  t('a fenced reply is still read', () => assert.equal(r.body.analysis.headline, REPLY.headline));
}

{
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ content: [{ text: JSON.stringify({ ...REPLY, verdict: 'catastrophic', flag: { level: 'nuclear', text: 'x' } }) }] }),
  });
  const r = mockRes();
  await analysis({ method: 'POST', query: {}, body: KPI_BODY, headers: { cookie: daveCookie } }, r);
  t('an invented verdict falls back rather than reaching the CSS', () =>
    // data-verdict drives a colour; an unknown value would style nothing and
    // look like a rendering bug.
    assert.equal(r.body.analysis.verdict, 'mixed'));
  t('an invented flag level falls back too', () =>
    assert.equal(r.body.analysis.flag.level, 'warning'));
}

{
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ content: [{ text: 'I am afraid I cannot do that.' }] }) });
  const r = mockRes();
  await analysis({ method: 'POST', query: {}, body: KPI_BODY, headers: { cookie: daveCookie } }, r);
  t('an unparseable reply is an error, never an empty panel', () => assert.equal(r.code, 502));
}

/* ------------------------------------------------------------- no data --- */
console.log('\nNothing to analyse is not a model call');

{
  let calls = 0;
  globalThis.fetch = async (...a) => { calls++; return anthropicOk()(...a); };
  const r = mockRes();
  await analysis(
    { method: 'POST', query: {},
      body: { panel: 'kpi', view: 'dave', range: { since: '2026-09-01', until: '2026-09-02' }, totals: { impressions: 0 } },
      headers: { cookie: daveCookie } },
    r,
  );
  t('an empty range is answered without paying for it', () => {
    assert.equal(calls, 0);
    assert.equal(r.body.skipped, 'no_data');
  });
  t('and the reader is told what to do about it', () =>
    assert.match(r.body.analysis.recommendation, /range|filter/i));
}

/* ---------------------------------------------------------- the payload -- */
console.log('\nWhat reaches the model');

{
  let sent = null;
  globalThis.fetch = async (_url, opts) => {
    sent = JSON.parse(opts.body);
    return anthropicOk()();
  };
  const r = mockRes();
  await analysis(
    { method: 'POST', query: {},
      body: {
        panel: 'trend', view: 'dave',
        range: { since: '2026-08-20', until: '2026-09-11' },
        daily: Array.from({ length: 30 }, (_, i) => ({
          date: `2026-09-${String((i % 28) + 1).padStart(2, '0')}`,
          spend: 10 + i, ctr: 1.2, cpm: 14,
        })),
      },
      headers: { cookie: daveCookie } },
    r,
  );

  t('the trend panel sends at most 14 days', () => {
    const body = JSON.parse(sent.messages[0].content.slice(sent.messages[0].content.indexOf('{')));
    assert.ok(body.spend.length <= 14, `sent ${body.spend.length} points`);
  });

  t('the business context is in the SYSTEM prompt, not the message', () => {
    assert.match(sent.system, /\$9\/month/);
    assert.ok(!/\$9\/month/.test(sent.messages[0].content));
  });

  t('the diagnostic framework reaches the model', () =>
    assert.match(sent.system, /creative fatigue/i));

  t('Sonnet is the tier used', () => assert.match(sent.model, /sonnet/i));
}

{
  // Campaign and ad names are typed by whoever built the campaign, so they are
  // data. The prompt says so; this checks it still does.
  t('the model is told names are untrusted', () =>
    assert.match(prompts.kpiSystemPrompt(prompts.ACCOUNTS.dave), /ignore it/i));
}

{
  let sent = null;
  globalThis.fetch = async (_url, opts) => { sent = JSON.parse(opts.body); return anthropicOk()(); };
  const r = mockRes();
  await analysis(
    { method: 'POST', query: {},
      body: { ...KPI_BODY, rows: [{ name: 'Ad  with control chars', spend: 10 }] },
      headers: { cookie: daveCookie } },
    r,
  );
  t('control characters are stripped from names before they reach the prompt', () =>
    assert.ok(!/[ -]/.test(sent.messages[0].content.replace(/\n/g, ''))));
}

/* ------------------------------------------------------------- accounts -- */
console.log('\nEach account gets its own economics');

t('Dave carries the stated thresholds', () => {
  const p = prompts.kpiSystemPrompt(prompts.ACCOUNTS.dave);
  assert.match(p, /\$18/);
  assert.match(p, /\$40[–-]50/);
});

t('Dave is not marked provisional', () =>
  assert.equal(prompts.ACCOUNTS.dave.provisional, false));

t('Montara Forge IS marked provisional', () =>
  // Its figures are researched benchmarks, not the owner's. The panel says so
  // rather than presenting inferred thresholds as agreed ones.
  assert.equal(prompts.ACCOUNTS.sybago.provisional, true));

t('the two accounts do not share a conversion word', () =>
  assert.notEqual(prompts.ACCOUNTS.dave.conversion, prompts.ACCOUNTS.sybago.conversion));

t('the lead account is told not to assert profitability', () =>
  // A lead is not a sale; close rate and job value are not in this data.
  assert.match(prompts.kpiSystemPrompt(prompts.ACCOUNTS.sybago), /[Dd]o not assert profitability/));

/* ---------------------------------------------------------------- format -- */
console.log('\nThe output contract');

{
  const p = prompts.kpiSystemPrompt(prompts.ACCOUNTS.dave);
  t('the model is told to open with the verdict, not a preamble', () =>
    assert.match(p, /Never with a preamble/));
  t('generic marketing advice is named and forbidden', () =>
    assert.match(p, /Consider optimising your ad creative/));
  t('the length target is stated', () => assert.match(p, /150[–-]250 words/));
  t('reasoning is kept out of the output', () =>
    assert.match(p, /Do not show your reasoning/));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
