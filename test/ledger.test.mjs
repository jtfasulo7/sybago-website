/**
 * Tests for the ledger endpoint and its storage.
 *
 *     node test/ledger.test.mjs
 *
 * No credentials and no network: Blob is stubbed. What matters here is that a
 * document from a browser is treated as untrusted, that the ledger is encrypted
 * before it reaches a PUBLIC blob store, and that two people saving cannot
 * silently destroy each other's work.
 */

import assert from 'node:assert';

process.env.DASHBOARD_SESSION_SECRET = 's'.repeat(40);
process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_FAKE_never_in_output_0123456789';

const auth = await import('../lib/auth.js');
const store = await import('../lib/finance/store.js');
const blobToken = await import('../lib/blob-token.js');
const { default: ledger, seedDocument, sanitise } = await import('../api/finance-ledger.js');

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

const call = async (req) => {
  const res = mockRes();
  await ledger(req, res);
  return res;
};
const GET = (headers = { cookie: validCookie }) => ({ method: 'GET', headers });
const PUT = (body, headers = { cookie: validCookie }) => ({ method: 'PUT', headers, body });

/* ------------------------------------------------------------- token ----- */
console.log('\nFinding the Blob token');

t('the documented name is used when it holds a real token', () =>
  assert.equal(blobToken.findBlobToken({ BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_abc' }).name,
    'BLOB_READ_WRITE_TOKEN'));
{
  // THE BUG THIS GUARDS: Vercel's connect dialog lets the variable be created
  // with a custom prefix, and a name-only match then looks exactly like "Blob
  // is not connected" — a silent failure with a misleading cause.
  t('a renamed variable is found by the shape of its value', () => {
    const found = blobToken.findBlobToken({ PEPS_BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_xyz' });
    assert.equal(found.name, 'PEPS_BLOB_READ_WRITE_TOKEN');
    assert.equal(found.token, 'vercel_blob_rw_xyz');
  });
  t('an OIDC-only connection is correctly reported as no token', () =>
    assert.equal(blobToken.findBlobToken({ BLOB_STORE_ID: 'store_123', VERCEL_OIDC_TOKEN: 'ey...' }), null));
  t('a token that is set but malformed is distinguished from a missing one', () => {
    const found = blobToken.findBlobToken({ BLOB_READ_WRITE_TOKEN: 'not-a-blob-token' });
    assert.equal(found.unrecognised, true);
  });
  t('the setup hint names the checkbox that is off by default', () =>
    assert.match(blobToken.blobSetupHint(), /read-write token env var/i));
}

/* -------------------------------------------------------- encryption ----- */
console.log('\nThe ledger is encrypted before it is stored');

{
  /* A Vercel Blob store is PUBLIC: every object in it is served at a URL with
     no authentication in front of it. This document is a business's revenue and
     costs, so what lands in the store must be ciphertext. */
  const doc = { cells: { C6: { v: 1450 } }, secretish: 'MRR is 1450' };
  const blob = store.encrypt(JSON.stringify(doc), SECRET);

  t('the stored payload does not contain the figures', () => {
    assert.equal(blob.includes('1450'), false);
    assert.equal(blob.includes('MRR'), false);
  });
  t('it round-trips back to exactly what went in', () =>
    assert.deepEqual(JSON.parse(store.decrypt(blob, SECRET)), doc));
  t('two encryptions of the same document differ', () =>
    assert.notEqual(blob, store.encrypt(JSON.stringify(doc), SECRET)));
  t('a different secret cannot read it', () =>
    assert.throws(() => store.decrypt(blob, 'a'.repeat(40))));
  t('a tampered payload fails rather than returning a wrong ledger', () => {
    const parts = blob.split('.');
    const body = Buffer.from(parts[3], 'base64');
    body[0] ^= 0xff;
    parts[3] = body.toString('base64');
    assert.throws(() => store.decrypt(parts.join('.'), SECRET));
  });
  t('a secret too short to derive a key from is refused, not padded', () =>
    assert.throws(() => store.encrypt('x', 'short'), /too short/i));
}

/* ---------------------------------------------------------- sanitise ----- */
console.log('\nA document from a browser is untrusted');

t('a cell reference that is not one is dropped', () => {
  const out = sanitise({ cells: { A1: { v: 1 }, '__proto__': { v: 2 }, 'A1; DROP': { v: 3 }, 'ZZZ9999': { v: 4 } } });
  assert.deepEqual(Object.keys(out.cells).sort(), ['A1', 'ZZZ9999']);
});
t('an unknown format is dropped rather than written into the page', () => {
  const out = sanitise({ cells: { A1: { v: 1, fmt: 'onerror=alert(1)' } } });
  assert.equal(out.cells.A1.fmt, undefined);
});
t('a known format survives', () =>
  assert.equal(sanitise({ cells: { A1: { v: 1, fmt: 'currency' } } }).cells.A1.fmt, 'currency'));
t('a formula is kept as typed', () =>
  assert.equal(sanitise({ cells: { A1: { f: '=SUM(B1:B9)' } } }).cells.A1.f, '=SUM(B1:B9)'));
t('a cell with neither value nor formula nor format is dropped', () =>
  assert.deepEqual(sanitise({ cells: { A1: {} } }).cells, {}));
t('a non-object cell does not throw', () =>
  assert.deepEqual(sanitise({ cells: { A1: 'hello', B1: null } }).cells, {}));

{
  // Unbounded input is how a small internal tool becomes a way to fill someone
  // else's storage bill.
  t('an enormous formula is refused', () =>
    assert.throws(() => sanitise({ cells: { A1: { f: '='.padEnd(3000, 'x') } } }), /too long/));
  t('enormous text is refused', () =>
    assert.throws(() => sanitise({ cells: { A1: { v: 'x'.repeat(6000) } } }), /too long/));
  t('an enormous sheet is refused', () => {
    const cells = {};
    for (let i = 1; i <= 20001; i++) cells['A' + i] = { v: 1 };
    assert.throws(() => sanitise({ cells }), /too large/);
  });
  t('row and column counts are clamped, not trusted', () => {
    const out = sanitise({ rows: 999999, cols: -4, cells: {} });
    assert.equal(out.rows, 500);
    assert.equal(out.cols, 1);
  });
  t('column widths are clamped and non-columns dropped', () => {
    const out = sanitise({ cells: {}, colWidths: { A: 99999, B: -10, 'not-a-col': 100 } });
    assert.deepEqual(out.colWidths, { A: 600, B: 48 });
  });
}

t('nothing sensible at all is refused outright', () =>
  assert.throws(() => sanitise(null), /Not a ledger/));

/* ------------------------------------------------------------- seed ------ */
console.log('\nThe starting sheet');

{
  const seed = seedDocument();
  t('it has a Skool row to type MRR into', () => {
    const label = Object.values(seed.cells).find((c) => c.v === 'Skool community');
    assert.ok(label, 'no Skool row');
  });
  t('it shows how to reference a live figure, rather than documenting it elsewhere', () => {
    const live = Object.values(seed.cells).filter((c) => c.f && c.f.includes('META('));
    assert.ok(live.length >= 2, 'found ' + live.length);
  });
  t('Higgsfield is on it at $99', () => {
    const amounts = Object.values(seed.cells).map((c) => c.v);
    assert.ok(amounts.includes(99));
  });
  t('it survives the same sanitising a browser document gets', () => {
    const clean = sanitise(seed);
    assert.equal(Object.keys(clean.cells).length, Object.keys(seed.cells).length);
  });
}

/* ------------------------------------------------------------ access ----- */
console.log('\nAccess');

{
  const res = await call(GET({}));
  t('an unauthenticated request is rejected', () => assert.equal(res.code, 401));
}
{
  const res = await call({ method: 'DELETE', headers: { cookie: validCookie } });
  t('an unsupported method is refused', () => assert.equal(res.code, 405));
}
{
  const res = await call(GET());
  t('responses are no-store — this is a P&L behind a login', () =>
    assert.match(String(res.headers['Cache-Control'] || ''), /no-store/));
}

/* ------------------------------------------------------- round trip ------ */
console.log('\nSaving and loading');

/* A stubbed Blob store: `put` keeps the ciphertext, `list` reports it, and the
   fetch of the blob URL hands it back — the same shape the real one has. */
let STORED = null;
const blobUrl = 'https://example.public.blob.vercel-storage.com/finance/ledger.enc';

function stubBlob() {
  globalThis.fetch = async (u) => {
    if (String(u) === blobUrl) {
      return { ok: true, status: 200, text: async () => STORED };
    }
    throw new Error('unexpected fetch: ' + u);
  };
}
stubBlob();

// An ES module namespace is frozen, so the store exposes a seam instead.
store.useBlobClient({
  put: async (pathname, body) => { STORED = body; return { url: blobUrl, pathname }; },
  list: async () => ({ blobs: STORED ? [{ url: blobUrl, pathname: 'finance/ledger.enc' }] : [] }),
  del: async () => { STORED = null; },
});

{
  const res = await call(GET());
  t('the first load returns the seed and says it is not saved yet', () => {
    assert.equal(res.code, 200);
    assert.equal(res.body.saved, false);
    assert.ok(res.body.doc.cells.A1);
  });
}

{
  const res = await call(PUT({ doc: { rows: 40, cols: 6, cells: { C6: { v: 1450, fmt: 'currency' } }, colWidths: {} }, baseVersion: 0 }));
  t('a save succeeds and increments the version', () => {
    assert.equal(res.code, 200);
    assert.equal(res.body.doc.version, 1);
  });
  t('what lands in the public store is ciphertext', () => {
    assert.ok(STORED, 'nothing was stored');
    assert.equal(String(STORED).includes('1450'), false);
  });
  t('and it carries a timestamp', () => assert.ok(res.body.doc.updatedAt));
}

{
  const res = await call(GET());
  t('the saved sheet comes back', () => {
    assert.equal(res.body.saved, true);
    assert.equal(res.body.doc.cells.C6.v, 1450);
  });
  t('only what was typed was stored — no computed values', () => {
    const cell = res.body.doc.cells.C6;
    assert.deepEqual(Object.keys(cell).sort(), ['fmt', 'v']);
  });
}

{
  // THE BUG THIS GUARDS: two people with the page open, last write wins, and
  // the first person's work vanishes with nothing to recover it from.
  const stale = await call(PUT({ doc: { rows: 40, cols: 6, cells: { C6: { v: 1 } } }, baseVersion: 0 }));
  t('a save from a stale copy is refused, not applied', () => {
    assert.equal(stale.code, 409);
    assert.match(stale.body.message, /saved somewhere else/i);
  });
  t('and the refusal hands back the version that won, so nothing is lost', () =>
    assert.equal(stale.body.doc.cells.C6.v, 1450));
  t('the stored ledger is untouched by the refused save', async () => {
    assert.equal(JSON.parse(store.decrypt(STORED, SECRET)).cells.C6.v, 1450);
  });
}

{
  const ok = await call(PUT({ doc: { rows: 40, cols: 6, cells: { C6: { v: 1600 } } }, baseVersion: 1 }));
  t('a save from the current version succeeds', () => {
    assert.equal(ok.code, 200);
    assert.equal(ok.body.doc.version, 2);
  });
}

{
  const res = await call(PUT({ doc: { cells: { A1: { f: 'x'.repeat(3000) } } }, baseVersion: 2 }));
  t('an oversized document is a 400 that says what is wrong', () => {
    assert.equal(res.code, 400);
    assert.match(res.body.message, /too long/);
  });
}

{
  const res = await call(PUT(null));
  t('an empty body is a 400, not a crash', () => assert.equal(res.code, 400));
}

/* --------------------------------------------------------- no store ------ */
console.log('\nWith no Blob store connected');

{
  const saved = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const get = await call(GET());
  t('loading still works and returns the seed', () => {
    assert.equal(get.code, 200);
    assert.equal(get.body.store.configured, false);
    assert.ok(get.body.doc.cells.A1);
  });
  t('and it says how to connect one rather than just failing', () =>
    assert.match(get.body.store.hint, /Connect Project/i));

  const put = await call(PUT({ doc: { cells: {} }, baseVersion: 0 }));
  t('saving is refused clearly rather than pretending to succeed', () => {
    assert.equal(put.code, 503);
    assert.match(put.body.message, /read-write token/i);
  });

  process.env.BLOB_READ_WRITE_TOKEN = saved;
}

/* ----------------------------------------------------------- secrets ----- */
console.log('\nThe Blob token never leaves the server');

{
  const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
  const get = await call(GET());
  t('the token appears nowhere in a response', () =>
    assert.equal(JSON.stringify(get.body).includes(TOKEN), false));
  t('only its variable NAME is reported', () =>
    assert.equal(get.body.store.tokenSource, 'BLOB_READ_WRITE_TOKEN'));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
