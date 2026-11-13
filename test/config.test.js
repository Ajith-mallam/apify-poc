'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const util = require('node:util');
const { loadConfig, normalisePage } = require('../src/config');

const SECRET = 'apify_api_DUMMYSECRET123';
const base = {
  APIFY_TOKEN: SECRET,
  EXAMPLE_PAGES: 'https://www.facebook.com/AcmeOfficial, othershop , facebook.com/profile.php?id=100064123456789',
  DEFAULT_PAGE_URL: 'https://m.facebook.com/acmeofficial/posts',
  MAX_POSTS: '10',
  UI_PORT: '4321',
};

test('normalises page URL variants', () => {
  const ok = {
    'acmeofficial': 'https://www.facebook.com/acmeofficial',
    '@acmeofficial': 'https://www.facebook.com/acmeofficial',
    'facebook.com/AcmeOfficial': 'https://www.facebook.com/AcmeOfficial',
    'https://www.facebook.com/AcmeOfficial/': 'https://www.facebook.com/AcmeOfficial',
    'https://m.facebook.com/AcmeOfficial/about?ref=x#y': 'https://www.facebook.com/AcmeOfficial',
    'https://www.facebook.com/profile.php?id=100064123456789': 'https://www.facebook.com/profile.php?id=100064123456789',
    'https://www.facebook.com/p/Acme-Shop-100064123456789/': 'https://www.facebook.com/p/Acme-Shop-100064123456789',
  };
  for (const [input, want] of Object.entries(ok)) assert.equal(normalisePage(input).url, want, input);
});

test('rejects non-page references', () => {
  const bad = [
    '', 'https://www.facebook.com/groups/12345', 'https://www.facebook.com/events/1',
    'https://www.facebook.com/acme/posts/pfbid0abc', 'https://www.facebook.com/permalink.php?story_fbid=1',
    'https://evil.com/acmeofficial', 'https://facebook.com.evil.com/acme', 'javascript:alert(1)',
    'https://user:pw@www.facebook.com/acme', 'https://www.facebook.com/', 'acme/../groups',
    'https://www.facebook.com/profile.php', 'https://www.facebook.com/profile.php?id=abc', '<script>',
  ];
  for (const b of bad) assert.throws(() => normalisePage(b), { name: 'ConfigError' }, JSON.stringify(b));
});

test('valid config loads with canonical default page', () => {
  const c = loadConfig({ env: base });
  assert.equal(c.examplePages.length, 3);
  assert.equal(c.defaultPageUrl, 'https://www.facebook.com/AcmeOfficial');
  assert.equal(c.maxPosts, 10);
  assert.equal(c.uiPort, 4321);
  assert.equal(c.getApifyToken(), SECRET);
});

test('token never appears in JSON / inspect / keys / String', () => {
  const c = loadConfig({ env: base });
  for (const s of [JSON.stringify(c), util.inspect(c, { depth: 5 }), Object.keys(c).join(), String(c), util.format('%o', c)]) {
    assert.ok(!s.includes(SECRET));
  }
  assert.ok(util.inspect(c).includes('[REDACTED]'));
});

test('config is frozen', () => {
  const c = loadConfig({ env: base });
  assert.throws(() => { c.maxPosts = 999; });
});

test('any valid page can be resolved; example pages are suggestions only', () => {
  const c = loadConfig({ env: base });
  assert.equal(c.resolvePage('https://m.facebook.com/somebodyelse').url, 'https://www.facebook.com/somebodyelse');
  assert.equal(c.resolvePage('OtherShop').url, 'https://www.facebook.com/OtherShop');
  assert.throws(() => c.resolvePage('https://www.facebook.com/groups/1'), /not a Facebook Page URL/);
  // No example pages and no default page is a valid configuration.
  const bare = loadConfig({ env: { APIFY_TOKEN: SECRET } });
  assert.deepEqual(bare.examplePages, []);
  assert.equal(bare.defaultPageUrl, null);
  // Legacy AUTHORIZED_PAGES still works as the example list.
  assert.equal(loadConfig({ env: { APIFY_TOKEN: SECRET, AUTHORIZED_PAGES: 'acme' } }).examplePages[0], 'https://www.facebook.com/acme');
});

test('clampPostCount enforces MAX_POSTS', () => {
  const c = loadConfig({ env: base });
  assert.equal(c.clampPostCount(3), 3);
  assert.equal(c.clampPostCount(500), 10);
  for (const bad of [0, 'abc', 2.5, -1]) assert.throws(() => c.clampPostCount(bad));
});

test('MAX_POSTS empty or 0 means no limit; UI_PORT defaults to 4321', () => {
  const c = loadConfig({ env: { ...base, MAX_POSTS: '', UI_PORT: undefined } });
  assert.equal(c.maxPosts, null);
  assert.equal(c.clampPostCount(500), 500);
  assert.equal(loadConfig({ env: { ...base, MAX_POSTS: '0' } }).maxPosts, null);
  assert.equal(loadConfig({ env: { APIFY_TOKEN: SECRET } }).maxPosts, null);
  assert.equal(c.uiPort, 4321);
});

test('clear errors that never contain the token', () => {
  const cases = [
    [{ APIFY_TOKEN: '' }, /APIFY_TOKEN is missing/],
    [{ APIFY_TOKEN: 'apify_api_replace_me' }, /placeholder/],
    [{ EXAMPLE_PAGES: 'https://facebook.com/groups/123' }, /not a Facebook Page URL/],
    [{ DEFAULT_PAGE_URL: 'https://evil.com/x' }, /DEFAULT_PAGE_URL: .*not a facebook.com URL/],
    [{ MAX_POSTS: 'ten' }, /MAX_POSTS must be a whole number/],
    [{ MAX_POSTS: '2000000' }, /between 0 and 1000000/],
    [{ UI_PORT: '80' }, /UI_PORT must be between/],
  ];
  for (const [over, re] of cases) {
    let msg = '';
    try { loadConfig({ env: { ...base, ...over } }); } catch (e) { msg = e.message; }
    assert.match(msg, re);
    assert.ok(!msg.includes(SECRET));
  }
});
