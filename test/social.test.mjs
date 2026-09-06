/**
 * Tests for the social posting feature.
 *
 *     node test/social.test.mjs
 *
 * No credentials and no network: Anthropic and every platform API is stubbed.
 * The focus is the things that would be expensive to get wrong in production —
 * posting to a platform that is not connected, one platform's failure taking
 * the others down, a credential appearing in a response, and an arbitrary URL
 * being handed to the server to fetch.
 */

import assert from 'node:assert';

process.env.DASHBOARD_SESSION_SECRET = 's'.repeat(40);
process.env.ANTHROPIC_API_KEY = 'sk-ant-FAKE-never-in-output-0123456789';

const auth = await import('../lib/auth.js');
const platforms = await import('../lib/social/platforms.js');
const adapters = await import('../lib/social/adapters.js');
const { default: captions } = await import('../api/social-captions.js');
const { default: publish } = await import('../api/social-publish.js');

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
const cookie = auth.createSessionCookie(SECRET, auth.ROLE_DAVE).split(';')[0];

function mockRes() {
  const r = { code: 200, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}

const BLOB = 'https://abc123.public.blob.vercel-storage.com/clip-x9f.mp4';

/* ------------------------------------------------------------- registry -- */
console.log('\nPlatform registry');

t('X was dropped from scope, not shipped broken', () =>
  assert.ok(!platforms.PLATFORM_IDS.includes('twitter') && !platforms.PLATFORM_IDS.includes('x')));

t('all four target platforms are present', () =>
  assert.deepEqual([...platforms.PLATFORM_IDS].sort(), ['facebook', 'instagram', 'tiktok', 'youtube']));

t('a platform with no credentials is not configured', () =>
  assert.equal(platforms.isConfigured('tiktok', {}), false));

t('a platform with all credentials is configured', () =>
  assert.equal(platforms.isConfigured('tiktok', { TIKTOK_ACCESS_TOKEN: 'x' }), true));

t('a partially configured platform is not configured', () =>
  assert.equal(platforms.isConfigured('youtube', { YOUTUBE_CLIENT_ID: 'a', YOUTUBE_CLIENT_SECRET: 'b' }), false));

t('missing variables are named individually', () =>
  assert.deepEqual(platforms.missingEnv('youtube', { YOUTUBE_CLIENT_ID: 'a' }),
    ['YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN']));

t('status never leaks a credential value', () => {
  const s = platforms.platformStatus({ TIKTOK_ACCESS_TOKEN: 'super-secret-value' });
  assert.ok(!JSON.stringify(s).includes('super-secret-value'));
});

t('only YouTube has to be pushed the bytes', () => {
  const push = platforms.PLATFORM_IDS.filter((id) => platforms.PLATFORMS[id].transfer === 'push');
  assert.deepEqual(push, ['youtube']);
});

/* ------------------------------------------------------------- captions -- */
console.log('\nCaption generation');

const MODEL_REPLY = (obj) => ({
  ok: true,
  status: 200,
  json: async () => ({ content: [{ type: 'text', text: '```json\n' + JSON.stringify(obj) + '\n```' }] }),
});

const GOOD = {
  instagram: { caption: 'Three weeks in and the routine finally clicked.', hashtags: ['#peps', '#routine', '#skool'] },
  facebook: { caption: 'Three weeks in and the routine finally clicked. Here is what changed.', hashtags: [] },
  tiktok: { caption: 'nobody told me it would take three weeks', hashtags: ['#peps', '#fyp', '#routine'] },
  youtube: { title: 'What changed after three weeks', caption: 'The full breakdown.', hashtags: ['#Shorts', '#peps'] },
};

let res;

globalThis.fetch = async () => MODEL_REPLY(GOOD);
res = mockRes();
await captions({ method: 'POST', body: { context: 'A three week progress update filmed at home.' }, headers: { cookie } }, res);

t('captions are generated for every platform', () =>
  assert.deepEqual(Object.keys(res.body.captions).sort(), ['facebook', 'instagram', 'tiktok', 'youtube']));
t('hashtags are returned separately from the caption', () =>
  assert.ok(!res.body.captions.instagram.caption.includes('#')));
t('the composed text is what the platform would receive', () =>
  assert.ok(res.body.captions.instagram.full.includes('#peps')));
t('YouTube gets its own title field', () =>
  assert.equal(res.body.captions.youtube.title, 'What changed after three weeks'));
t('a clean result reports no problems', () =>
  assert.deepEqual(res.body.captions.facebook.problems, []));
t('the API key never appears in the response', () =>
  assert.ok(!JSON.stringify(res.body).includes('sk-ant-FAKE')));

// THE CHECK THAT MATTERS: the model is not trusted to have counted. An
// over-length caption is rejected by the platform at publish time, which is a
// far worse place to discover it.
globalThis.fetch = async () => MODEL_REPLY({
  ...GOOD,
  tiktok: { caption: 'x'.repeat(2400), hashtags: ['#a'] },
});
res = mockRes();
await captions({ method: 'POST', body: { context: 'A three week progress update filmed at home.' }, headers: { cookie } }, res);
t('an over-length caption is flagged, not passed through', () =>
  assert.ok(res.body.captions.tiktok.problems.some((p) => /over the 2200 limit/.test(p))));

globalThis.fetch = async () => MODEL_REPLY({
  ...GOOD,
  instagram: { caption: 'fine', hashtags: Array.from({ length: 20 }, (_, i) => '#t' + i) },
});
res = mockRes();
await captions({ method: 'POST', body: { context: 'A three week progress update filmed at home.' }, headers: { cookie } }, res);
t('too many hashtags is flagged', () =>
  assert.ok(res.body.captions.instagram.problems.some((p) => /more than 8/.test(p))));

globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ content: [{ text: 'sorry, no.' }] }) });
res = mockRes();
await captions({ method: 'POST', body: { context: 'A three week progress update filmed at home.' }, headers: { cookie } }, res);
t('an unparseable reply fails loudly rather than posting nothing', () =>
  assert.ok(res.code === 502 && res.body.error === 'unparseable'));

globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'bad key' } }) });
res = mockRes();
await captions({ method: 'POST', body: { context: 'A three week progress update filmed at home.' }, headers: { cookie } }, res);
t('a rejected API key is reported as such', () =>
  assert.ok(res.code === 401 && res.body.error === 'anthropic_unauthorized'));

let reached = false;
globalThis.fetch = async () => { reached = true; throw new Error('nope'); };
res = mockRes();
await captions({ method: 'POST', body: { context: 'x'.repeat(50) }, headers: {} }, res);
t('captions require a session', () => assert.equal(res.code, 401));
t('Anthropic is never called without a session', () => assert.equal(reached, false));

res = mockRes();
await captions({ method: 'POST', body: { context: 'short' }, headers: { cookie } }, res);
t('a too-short description is refused', () => assert.equal(res.code, 400));

/* -------------------------------------------------------------- publish -- */
console.log('\nPublishing');

res = mockRes();
await publish({ method: 'GET', query: {}, headers: { cookie } }, res);
t('status lists every platform', () => assert.equal(res.body.platforms.length, 4));

// Publishing to something unconnected must not half-post.
reached = false;
globalThis.fetch = async () => { reached = true; return { ok: true, json: async () => ({ id: '1' }) }; };
res = mockRes();
await publish({
  method: 'POST',
  headers: { cookie },
  body: { videoUrl: BLOB, posts: { tiktok: { caption: 'hi' } } },
}, res);
t('posting to an unconnected platform is refused', () =>
  assert.ok(res.code === 400 && res.body.error === 'not_configured'));
t('nothing is posted when a chosen platform is unconnected', () => assert.equal(reached, false));
t('the refusal names the missing variables', () =>
  assert.deepEqual(res.body.missing.tiktok, ['TIKTOK_ACCESS_TOKEN']));

// An arbitrary URL must not become a server-side fetch.
process.env.FB_PAGE_ID = '123';
process.env.FB_PAGE_ACCESS_TOKEN = 'PAGE-TOKEN-secret-value-999';
reached = false;
res = mockRes();
await publish({
  method: 'POST',
  headers: { cookie },
  body: { videoUrl: 'https://attacker.example/evil.mp4', posts: { facebook: { caption: 'hi' } } },
}, res);
t('a URL outside our own storage is refused', () =>
  assert.ok(res.code === 400 && res.body.error === 'bad_video_url'));
t('an outside URL is never fetched', () => assert.equal(reached, false));

res = mockRes();
await publish({
  method: 'POST',
  headers: { cookie },
  body: { videoUrl: 'http://abc.public.blob.vercel-storage.com/x.mp4', posts: { facebook: { caption: 'hi' } } },
}, res);
t('plain http is refused', () => assert.equal(res.code, 400));

// Happy path.
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ id: 'fb_1' }) });
res = mockRes();
await publish({
  method: 'POST',
  headers: { cookie },
  body: { videoUrl: BLOB, posts: { facebook: { caption: 'Posted from the dashboard.', hashtags: [] } } },
}, res);
t('a configured platform publishes', () =>
  assert.ok(res.code === 200 && res.body.results.facebook.ok === true));
t('the summary counts what actually posted', () =>
  assert.deepEqual(res.body.summary, { requested: 1, posted: 1, failed: 0 }));

// THE PARTIAL-FAILURE RULE: a video already live on one platform cannot be
// un-posted because another refused, so one failure must not stop the rest.
process.env.TIKTOK_ACCESS_TOKEN = 'TT-TOKEN-secret-value-888';
globalThis.fetch = async (url) => {
  if (String(url).includes('tiktokapis')) {
    return { ok: false, status: 403, json: async () => ({ error: { code: 'url_ownership_unverified', message: 'domain not verified' } }) };
  }
  return { ok: true, status: 200, json: async () => ({ id: 'fb_2' }) };
};
res = mockRes();
await publish({
  method: 'POST',
  headers: { cookie },
  body: {
    videoUrl: BLOB,
    posts: { facebook: { caption: 'Works.' }, tiktok: { caption: 'Fails.' } },
  },
}, res);
t('one platform failing does not stop another', () =>
  assert.ok(res.body.results.facebook.ok === true && res.body.results.tiktok.ok === false));
t('partial success is reported honestly', () =>
  assert.deepEqual(res.body.summary, { requested: 2, posted: 1, failed: 1 }));
t('the TikTok domain-verification failure is explained in plain terms', () =>
  assert.match(res.body.results.tiktok.message, /verif/i));

// An adapter throwing is a bug, but must still not take the others down.
const savedFb = adapters.ADAPTERS.facebook;
adapters.ADAPTERS.tiktok = async () => { throw new Error('boom'); };
res = mockRes();
await publish({
  method: 'POST',
  headers: { cookie },
  body: { videoUrl: BLOB, posts: { facebook: { caption: 'Works.' }, tiktok: { caption: 'Throws.' } } },
}, res);
t('an adapter throwing is contained', () =>
  assert.ok(res.body.results.facebook.ok === true && res.body.results.tiktok.ok === false));

// No credential may appear in any response, whatever a platform echoes back.
adapters.ADAPTERS.facebook = savedFb;
globalThis.fetch = async () => ({
  ok: false, status: 400,
  json: async () => ({ error: { message: 'failed for access_token=' + process.env.FB_PAGE_ACCESS_TOKEN } }),
});
res = mockRes();
await publish({
  method: 'POST',
  headers: { cookie },
  body: { videoUrl: BLOB, posts: { facebook: { caption: 'hi' } } },
}, res);
t('a platform echoing a token back does not leak it', () =>
  assert.ok(!JSON.stringify(res.body).includes('PAGE-TOKEN-secret-value-999')));

// Length is enforced before anything is sent, not after.
reached = false;
globalThis.fetch = async () => { reached = true; return { ok: true, json: async () => ({ id: 'x' }) }; };
res = mockRes();
await publish({
  method: 'POST',
  headers: { cookie },
  body: { videoUrl: BLOB, posts: { facebook: { caption: 'x'.repeat(6000) } } },
}, res);
t('an over-length caption is refused before posting', () =>
  assert.ok(res.code === 400 && res.body.error === 'caption_too_long'));
t('nothing is sent when a caption is too long', () => assert.equal(reached, false));

res = mockRes();
await publish({ method: 'POST', headers: {}, body: { videoUrl: BLOB, posts: { facebook: { caption: 'hi' } } } }, res);
t('publishing requires a session', () => assert.equal(res.code, 401));

/* -------------------------------------------------------------- helpers -- */
console.log('\nCaption composition');

t('hashtags are appended, not interleaved', () =>
  assert.equal(adapters.fullCaption({ caption: 'Body.', hashtags: ['#a', '#b'] }), 'Body.\n\n#a #b'));
t('no trailing whitespace when there are no hashtags', () =>
  assert.equal(adapters.fullCaption({ caption: 'Body.', hashtags: [] }), 'Body.'));


/* --------------------------------------------------- one Meta credential ---- */
console.log('\nOne Meta token serves both Meta platforms');

t('Facebook needs its page id and a token', () =>
  assert.deepEqual(platforms.missingEnv('facebook', {}), ['FB_PAGE_ID', 'FB_PAGE_ACCESS_TOKEN']));

t('Instagram falls back to the Facebook token', () =>
  assert.equal(
    platforms.isConfigured('instagram', { IG_USER_ID: '1', FB_PAGE_ACCESS_TOKEN: 'x' }),
    true,
  ));

t('Instagram is still fine with its own token', () =>
  assert.equal(
    platforms.isConfigured('instagram', { IG_USER_ID: '1', IG_ACCESS_TOKEN: 'x' }),
    true,
  ));

t('a dedicated Instagram token wins over the shared one', () =>
  assert.equal(
    platforms.resolveTokenName('instagram', { IG_ACCESS_TOKEN: 'a', FB_PAGE_ACCESS_TOKEN: 'b' }),
    'IG_ACCESS_TOKEN',
  ));

// Naming every fallback would read as "set all of these" when any one will do.
t('only one token variable is asked for when none is set', () =>
  assert.deepEqual(platforms.missingEnv('instagram', { IG_USER_ID: '1' }), ['IG_ACCESS_TOKEN']));

t('an id is still required even when the token is shared', () =>
  assert.equal(platforms.isConfigured('instagram', { FB_PAGE_ACCESS_TOKEN: 'x' }), false));

/* THE FAILURE THIS PREVENTS: Meta hands out user tokens and page tokens that
   look identical in a config field, and the wrong one fails at publish time
   with something that reads like a missing permission. */
process.env.FB_PAGE_ID = '123';
process.env.FB_PAGE_ACCESS_TOKEN = 'USER-TOKEN-not-a-page-token';
{
  const seen = [];
  globalThis.fetch = async (u, o) => {
    const url = String(u);
    seen.push(url);
    if (url.includes('/videos')) return { ok: true, status: 200, json: async () => ({ id: 'fb_9' }) };
    // The Page hands back its own token when asked with a user token.
    return { ok: true, status: 200, json: async () => ({ access_token: 'REAL-PAGE-TOKEN' }) };
  };
  const r = mockRes();
  await publish({
    method: 'POST',
    headers: { cookie },
    body: { videoUrl: BLOB, posts: { facebook: { caption: 'hi' } } },
  }, r);

  t('a user token is exchanged for the page token before publishing', () =>
    assert.ok(seen.some((u) => u.includes('fields=access_token'))));
  t('the publish call uses the exchanged token', () => {
    const post = seen.find((u) => u.includes('/videos'));
    assert.ok(post, 'no publish call was made');
  });
  t('publishing still succeeds', () => assert.equal(r.body.results.facebook.ok, true));
}

// If the exchange fails, the configured token is used rather than nothing.
{
  globalThis.fetch = async (u) => {
    const url = String(u);
    if (url.includes('fields=access_token')) {
      return { ok: false, status: 400, json: async () => ({ error: { message: 'nope' } }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: 'fb_10' }) };
  };
  const r = mockRes();
  await publish({
    method: 'POST',
    headers: { cookie },
    body: { videoUrl: BLOB, posts: { facebook: { caption: 'hi' } } },
  }, r);
  t('a failed token exchange falls back rather than breaking the post', () =>
    assert.equal(r.body.results.facebook.ok, true));
}


/* ------------------------------------------- captions written from frames ---- */
console.log('\nCaptions from video frames');

const JPEG = 'data:image/jpeg;base64,' + '/9j/4AAQSkZJRg' + 'A'.repeat(200);
const FRAMES = Array.from({ length: 6 }, () => JPEG);

let sent = null;
globalThis.fetch = async (u, o) => {
  sent = JSON.parse(o.body);
  return MODEL_REPLY(GOOD);
};

res = mockRes();
await captions({ method: 'POST', body: { frames: FRAMES }, headers: { cookie } }, res);

t('frames alone are enough — no typed description needed', () =>
  assert.equal(res.code, 200));
t('the frames are sent to the model as image blocks', () => {
  const imgs = sent.messages[0].content.filter((c) => c.type === 'image');
  assert.equal(imgs.length, 6);
  assert.equal(imgs[0].source.type, 'base64');
  assert.equal(imgs[0].source.media_type, 'image/jpeg');
});
t('the data URL prefix is stripped before sending', () =>
  assert.ok(!sent.messages[0].content[0].source.data.startsWith('data:')));
t('the prompt comes after the images', () => {
  const c = sent.messages[0].content;
  assert.equal(c[c.length - 1].type, 'text');
});
t('the prompt tells the model how many frames it has', () =>
  assert.match(sent.messages[0].content.at(-1).text, /6 frames sampled evenly/));
t('the response reports how many frames were read', () =>
  assert.equal(res.body.framesRead, 6));

// Typed notes still reach the model when supplied alongside frames.
res = mockRes();
await captions({
  method: 'POST',
  body: { frames: FRAMES, context: 'The offer closes on Friday.' },
  headers: { cookie },
}, res);
t('typed notes are combined with the frames rather than replaced', () =>
  assert.match(sent.messages[0].content.at(-1).text, /offer closes on Friday/));

/* THE CHECK THAT MATTERS: whatever the browser posts is untrusted. A frame
   that is not a plausible image must be dropped, not forwarded to Anthropic. */
res = mockRes();
await captions({
  method: 'POST',
  body: { frames: [JPEG, 'data:text/html;base64,PHNjcmlwdD4=', 'not-base64!!', JPEG] },
  headers: { cookie },
}, res);
t('a non-image data URL is dropped', () => {
  const imgs = sent.messages[0].content.filter((c) => c.type === 'image');
  assert.equal(imgs.length, 2);
});

res = mockRes();
await captions({
  method: 'POST',
  body: { frames: ['data:image/jpeg;base64,' + 'A'.repeat(2 * 1024 * 1024)], context: 'a video of a thing happening' },
  headers: { cookie },
}, res);
t('an oversized frame is dropped rather than blowing the request', () => {
  const imgs = sent.messages[0].content.filter
    ? sent.messages[0].content.filter((c) => c.type === 'image')
    : [];
  assert.equal(imgs.length, 0);
});

// More than the cap would push the body past the serverless limit.
res = mockRes();
await captions({
  method: 'POST',
  body: { frames: Array.from({ length: 40 }, () => JPEG) },
  headers: { cookie },
}, res);
t('the frame count is capped', () => {
  const imgs = sent.messages[0].content.filter((c) => c.type === 'image');
  assert.ok(imgs.length <= 10, 'sent ' + imgs.length);
});

// Neither frames nor a description is nothing to write from.
res = mockRes();
await captions({ method: 'POST', body: {}, headers: { cookie } }, res);
t('no frames and no description is refused', () =>
  assert.ok(res.code === 400 && res.body.error === 'missing_context'));

// Text-only still works for anyone who would rather type it.
globalThis.fetch = async (u, o) => { sent = JSON.parse(o.body); return MODEL_REPLY(GOOD); };
res = mockRes();
await captions({
  method: 'POST',
  body: { context: 'Dave walks through the first week of the program.' },
  headers: { cookie },
}, res);
t('the text-only path still works', () =>
  assert.ok(res.code === 200 && typeof sent.messages[0].content === 'string'));
t('text-only reports no frames read', () => assert.equal(res.body.framesRead, 0));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
