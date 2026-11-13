'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('../src/hash');

function makeRun() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbpoc-hash-'));
  fs.mkdirSync(path.join(dir, 'images'));
  fs.writeFileSync(path.join(dir, 'images', '01_1_0.jpg'), Buffer.from([0xff, 0xd8, 1, 2, 3]));
  fs.writeFileSync(path.join(dir, 'images', '02_2_0.jpg'), Buffer.from([0xff, 0xd8, 4, 5, 6]));
  const doc = {
    schemaVersion: 1,
    posts: [
      { postId: '1', postUrl: 'https://www.facebook.com/a/posts/1', postedAt: '2026-11-11T05:00:00.000Z', text: 'Café ☕', likes: 5,
        images: [{ index: 0, localPath: 'images/01_1_0.jpg' }] },
      { postId: '2', postUrl: null, postedAt: null, text: null, likes: null,
        images: [{ index: 0, localPath: 'images/02_2_0.jpg' }, { index: 1, localPath: null, error: 'HTTP 404' }] },
    ],
  };
  fs.writeFileSync(path.join(dir, 'posts.json'), JSON.stringify(doc, null, 2));
  return dir;
}
const read = (d) => JSON.parse(fs.readFileSync(path.join(d, 'posts.json'), 'utf8'));
const write = (d, doc) => fs.writeFileSync(path.join(d, 'posts.json'), JSON.stringify(doc, null, 2));

test('content hash: fixed scheme, NFC, only stable fields', () => {
  const p = { postId: '1', postUrl: 'u', postedAt: 't', text: 'Café' }; // decomposed é
  assert.equal(h.canonicalContent(p), '["fbpoc-post-v1","1","u","t","Café"]');
  assert.equal(h.contentHash(p), h.contentHash({ ...p, text: 'Café' }));     // NFC-equal
  assert.equal(h.contentHash(p), h.contentHash({ ...p, likes: 999, images: [] })); // non-content fields ignored
  assert.notEqual(h.contentHash(p), h.contentHash({ ...p, text: 'Café ' }));
  assert.equal(h.canonicalContent({}), '["fbpoc-post-v1",null,null,null,null]');
  // Known-answer test so the scheme can be re-implemented elsewhere.
  assert.equal(h.contentHash({ postId: '1', postUrl: 'u', postedAt: 't', text: 'x' }),
    h.sha256(Buffer.from('["fbpoc-post-v1","1","u","t","x"]', 'utf8')));
});

test('hashRun writes hashes and a sha256sum-format manifest', async () => {
  const d = makeRun();
  const r = await h.hashRun(d);
  assert.deepEqual([r.posts, r.images], [2, 2]);
  const doc = read(d);
  assert.match(doc.posts[0].contentSha256, /^[0-9a-f]{64}$/);
  assert.equal(doc.posts[0].images[0].sha256, h.sha256(Buffer.from([0xff, 0xd8, 1, 2, 3])));
  assert.equal(doc.posts[1].images[1].sha256, null);
  assert.equal(doc.hashing.contentScheme, 'fbpoc-post-v1');
  const manifest = fs.readFileSync(path.join(d, 'posts.json.sha256'), 'utf8');
  assert.equal(manifest, `${h.sha256(fs.readFileSync(path.join(d, 'posts.json')))}  posts.json\n`);
  const v = await h.verifyRun(d);
  assert.equal(v.ok, true, v.problems.join('; '));
  assert.deepEqual(v.totals, { checks: 5, passed: 5, failed: 0 }); // manifest + 2 content + 2 images
  assert.equal(v.posts[1].images[1].status, 'not-downloaded');
});

test('tamper: edit text only -> manifest and content mismatch', async () => {
  const d = makeRun(); await h.hashRun(d);
  const doc = read(d); doc.posts[0].text = 'Café ☕ (edited)'; write(d, doc);
  const v = await h.verifyRun(d);
  assert.equal(v.ok, false);
  assert.equal(v.manifest.ok, false);
  assert.equal(v.posts[0].content.ok, false);
  assert.equal(v.posts[1].content.ok, true);
});

test('tamper: edit text and recompute manifest -> content hash still catches it', async () => {
  const d = makeRun(); await h.hashRun(d);
  const doc = read(d); doc.posts[0].postedAt = '2020-01-01T00:00:00.000Z'; write(d, doc);
  fs.writeFileSync(path.join(d, 'posts.json.sha256'), `${h.sha256(fs.readFileSync(path.join(d, 'posts.json')))}  posts.json\n`);
  const v = await h.verifyRun(d);
  assert.equal(v.manifest.ok, true);
  assert.equal(v.ok, false);
  assert.match(v.problems.join(), /post 1: content hash mismatch/);
});

test('tamper: change likes only -> manifest catches it, content hash unaffected', async () => {
  const d = makeRun(); await h.hashRun(d);
  const doc = read(d); doc.posts[0].likes = 1_000_000; write(d, doc);
  const v = await h.verifyRun(d);
  assert.equal(v.manifest.ok, false);
  assert.equal(v.posts[0].content.ok, true);
  assert.equal(v.ok, false);
});

test('tamper: modify, delete image', async () => {
  const d = makeRun(); await h.hashRun(d);
  fs.appendFileSync(path.join(d, 'images', '01_1_0.jpg'), Buffer.from([0]));
  fs.rmSync(path.join(d, 'images', '02_2_0.jpg'));
  const v = await h.verifyRun(d);
  assert.equal(v.ok, false);
  assert.equal(v.manifest.ok, true);
  assert.equal(v.posts[0].images[0].status, 'mismatch');
  assert.equal(v.posts[1].images[0].status, 'missing');
});

test('missing/malformed manifest and unsafe paths fail', async () => {
  const d = makeRun(); await h.hashRun(d);
  fs.writeFileSync(path.join(d, 'posts.json.sha256'), 'garbage');
  assert.match((await h.verifyRun(d)).problems.join(), /missing or malformed/);
  fs.rmSync(path.join(d, 'posts.json.sha256'));
  assert.equal((await h.verifyRun(d)).ok, false);

  const doc = read(d); doc.posts[0].images[0].localPath = 'images/../../secret.txt'; write(d, doc);
  assert.match((await h.verifyRun(d)).problems.join(), /unsafe image path/);
  await assert.rejects(h.hashRun(d), /Unsafe image path/);
  for (const bad of ['../x.jpg', 'images/a/b.jpg', 'images/..', '/etc/passwd', 'images\\x.jpg', null]) {
    assert.equal(h.safeImagePath(d, bad), null, String(bad));
  }
});

test('unhashed run reports clearly instead of throwing', async () => {
  const d = makeRun();
  const v = await h.verifyRun(d);
  assert.equal(v.ok, false);
  assert.match(v.problems.join(), /no content hash recorded/);
});
