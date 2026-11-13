'use strict';
// Local server + stateless API (same code that runs on Vercel), with Apify stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const apify = require('../src/apify');
const store = require('../src/store');
const { loadConfig } = require('../src/config');
const { createServer } = require('../src/server');

const SECRET = 'apify_api_SERVERTESTSECRET999';
const CODE = 'letmein123';
const FB_TEXT = "This content isn't available because the owner only shared it with a small group of people or changed who can see it, or it's been deleted.";
const original = { ...apify };
const originalFetchImage = store.fetchImage;
let server, port, items, runStatus;

const RAW_POST = {
  postId: '111', url: 'https://www.facebook.com/acme/posts/111', time: '2026-11-11T08:00:00.000Z',
  text: '<img src=x onerror=alert(1)> hello', likes: 1, comments: 2, shares: 3, user: { name: 'Acme' },
  facebookUrl: 'https://www.facebook.com/acme',
  media: [{ __typename: 'Photo', photo_image: { uri: 'https://scontent.xx.fbcdn.net/a.jpg', width: 10, height: 10 } }],
};

test.before(async () => {
  Object.assign(apify, {
    createClient: () => ({}),
    getEventPrices: async () => ({ tier: 'FREE', startUsd: 0.001, perPostUsd: 0.005, minimalMaxTotalChargeUsd: 0 }),
    startRun: async (_c, { postCount }) => ({ run: { id: 'RUNabc123', status: 'READY' }, capUsd: 0.001 + 0.005 * postCount, prices: { tier: 'FREE', startUsd: 0.001, perPostUsd: 0.005 } }),
    pollRun: async () => ({ id: 'RUNabc123', status: runStatus, statusMessage: 'msg', defaultDatasetId: 'DS1', startedAt: new Date(), finishedAt: new Date() }),
    fetchItems: async () => items,
    settleRun: async () => ({ run: { usageTotalUsd: 0.006, chargedEventCounts: { 'actor-start': 1, post: 1 } }, settled: true }),
  });
  store.fetchImage = async (url) => {
    if (!url.includes('fbcdn.net')) throw new Error('host not allowed');
    return { buffer: Buffer.from([0xff, 0xd8, 0xff, 1, 2]), contentType: 'image/jpeg', ext: 'jpg' };
  };
  const config = loadConfig({ env: { APIFY_TOKEN: SECRET, EXAMPLE_PAGES: 'acme', DEMO_ACCESS_CODE: CODE, UI_PORT: '4321' } });
  server = createServer({ config, pollWaitSecs: 0 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
test.after(() => { Object.assign(apify, original); store.fetchImage = originalFetchImage; server.close(); });
test.beforeEach(() => { items = [RAW_POST]; runStatus = 'SUCCEEDED'; });

function req(method, p, { headers = {}, body, noHost = false } = {}) {
  return new Promise((resolve, reject) => {
    const hdrs = noHost ? headers : { host: `127.0.0.1:${port}`, ...headers };
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: hdrs, setHost: !noHost }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, body: buf.toString('utf8'), buf, json });
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const origin = () => `http://127.0.0.1:${port}`;
const auth = { 'x-access-code': CODE };
const post = (p, obj, extra = {}) => req('POST', p, { headers: { 'content-type': 'application/json', origin: origin(), ...auth, ...extra }, body: JSON.stringify(obj) });
const get = (p, extra = {}) => req('GET', p, { headers: { ...auth, ...extra } });

test('serves the UI with security headers; only listed static files', async () => {
  const r = await req('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.body, /<title>Post Collector<\/title>/);
  assert.match(r.headers['content-security-policy'], /script-src 'self'/);
  assert.match(r.headers['content-security-policy'], /img-src 'self' blob:/);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal((await req('GET', '/zip.js')).status, 200);
  for (const p of ['/.env', '/src/config.js', '/../package.json', '/public/app.js', '/api/../.env']) {
    assert.notEqual((await req('GET', p)).status, 200, p);
  }
});

test('rejects unexpected Host header (DNS rebinding)', async () => {
  for (const host of ['evil.com', `evil.com:${port}`, '127.0.0.1:1', `127.0.0.1.evil.com:${port}`]) {
    assert.equal((await req('GET', '/api/config', { headers: { host } })).status, 421, host);
  }
  assert.ok([400, 421].includes((await req('GET', '/api/config', { noHost: true })).status));
  assert.equal((await req('GET', '/api/config', { headers: { host: `localhost:${port}` } })).status, 200);
});

test('config never exposes the token or access code; reports whether access is granted', async () => {
  const anon = await req('GET', '/api/config');
  assert.equal(anon.status, 200);
  assert.ok(!anon.body.includes(SECRET) && !anon.body.includes(CODE));
  assert.equal(anon.json.accessCodeRequired, true);
  assert.equal(anon.json.accessGranted, false);
  assert.equal(anon.json.pricing, null, 'no pricing before access');
  assert.equal(anon.json.maxPosts, null, 'no post limit by default');
  const ok = await get('/api/config');
  assert.equal(ok.json.accessGranted, true);
  assert.equal(ok.json.pricing.perPostUsd, 0.005);
  assert.deepEqual(ok.json.steps, ['validate', 'start', 'scrape', 'fetch', 'save', 'hash', 'verify']);
});

test('access code is required for everything except config', async () => {
  const r = await post('/api/start', { pageUrl: 'acme', count: 1 }, { 'x-access-code': 'wrong-code' });
  assert.equal(r.status, 401);
  assert.equal(r.json.reason.code, 'access-code');
  assert.equal((await req('GET', '/api/status?runId=x')).status, 401);
});

test('POST requires same Origin and JSON (CSRF)', async () => {
  assert.equal((await post('/api/start', { pageUrl: 'acme', count: 1 }, { origin: 'https://evil.com' })).status, 403);
  assert.equal((await req('POST', '/api/start', { headers: { 'content-type': 'application/json', ...auth }, body: '{}' })).status, 403);
  assert.equal((await req('POST', '/api/start', { headers: { 'content-type': 'text/plain', origin: origin(), ...auth }, body: '{}' })).status, 415);
  assert.equal((await req('POST', '/api/start', { headers: { 'content-type': 'application/json', origin: origin(), ...auth }, body: 'x'.repeat(9000) })).status, 413);
  assert.equal((await req('GET', '/api/start', { headers: auth })).status, 405);
});

test('invalid page URL is explained at the Validate step', async () => {
  const r = await post('/api/start', { pageUrl: 'https://www.facebook.com/groups/123', count: 3 });
  assert.equal(r.status, 400);
  assert.equal(r.json.step, 'validate');
  assert.equal(r.json.reason.code, 'invalid-page-url');
  assert.ok(r.json.reason.hint);
});

async function startRun(pageUrl = 'https://m.facebook.com/someotherpage', count = 1) {
  const s = await post('/api/start', { pageUrl, count });
  assert.equal(s.status, 200, s.body);
  return { runId: s.json.runId, pageUrl: s.json.page.url, count: s.json.postCount, ticket: s.json.ticket };
}

test('full flow: start -> status -> result -> signed image proxy', async () => {
  const ref = await startRun();
  assert.equal(ref.pageUrl, 'https://www.facebook.com/someotherpage', 'any page, canonicalised');
  const st = await get(`/api/status?${new URLSearchParams(ref)}`);
  assert.equal(st.json.finished, true);
  assert.equal(st.json.status, 'SUCCEEDED');

  const r = await post('/api/result', ref);
  assert.equal(r.status, 200, r.body);
  assert.ok(!r.body.includes(SECRET));
  const p = r.json.doc.posts[0];
  assert.equal(p.text, RAW_POST.text);
  assert.match(p.contentSha256, /^[0-9a-f]{64}$/);
  assert.equal(r.json.doc.apify.usageTotalUsd, 0.006);
  assert.equal(r.json.doc.hashing.contentScheme, 'fbpoc-post-v1');
  const img = p.images[0];
  assert.match(img.proxyUrl, /^\/api\/image\?u=/);
  assert.match(img.fileStem, /^images\/01_111_0$/);

  const im = await get(img.proxyUrl);
  assert.equal(im.status, 200);
  assert.equal(im.headers['content-type'], 'image/jpeg');
  assert.equal(im.headers['x-image-ext'], 'jpg');
  assert.equal(im.headers['x-content-sha256'], require('node:crypto').createHash('sha256').update(im.buf).digest('hex'));
});

test('image proxy refuses unsigned or tampered URLs (not an open proxy)', async () => {
  const u = encodeURIComponent('https://scontent.xx.fbcdn.net/other.jpg');
  assert.equal((await get(`/api/image?u=${u}&s=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`)).status, 403);
  assert.equal((await get(`/api/image?u=${u}`)).status, 403);
});

test('tickets: forged or mismatched run references are refused', async () => {
  const ref = await startRun();
  assert.equal((await get(`/api/status?${new URLSearchParams({ ...ref, runId: 'OTHERrun99' })}`)).status, 403);
  assert.equal((await get(`/api/status?${new URLSearchParams({ ...ref, count: 50 })}`)).status, 403);
  assert.equal((await post('/api/result', { ...ref, ticket: 'x' })).status, 403);
});

test('Facebook "not available" is explained with its exact message and the cost', async () => {
  items = [{ url: 'x', error: 'not_available', errorDescription: FB_TEXT }];
  const ref = await startRun('nopage');
  const r = await post('/api/result', ref);
  assert.equal(r.status, 422);
  assert.equal(r.json.step, 'fetch');
  assert.equal(r.json.reason.code, 'page-not-available');
  assert.equal(r.json.reason.details, FB_TEXT);
  assert.equal(r.json.cost.usageTotalUsd, 0.006);
});

test('failed Apify run is explained at the Scrape step; running run gives 409', async () => {
  const ref = await startRun();
  runStatus = 'RUNNING';
  assert.equal((await post('/api/result', ref)).status, 409);
  runStatus = 'FAILED';
  const r = await post('/api/result', ref);
  assert.equal(r.status, 422);
  assert.equal(r.json.step, 'scrape');
  assert.equal(r.json.reason.code, 'apify-run-failed');
});
