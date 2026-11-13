'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../src/store');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
let server, base, tmp;

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fbpoc-store-'));
  server = http.createServer((req, res) => {
    if (req.url === '/ok.jpg') { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(JPEG); }
    if (req.url === '/ok.png') { res.writeHead(200, { 'content-type': 'image/png; charset=binary' }); return res.end(JPEG); }
    if (req.url === '/404') { res.writeHead(404); return res.end(); }
    if (req.url === '/html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>'); }
    if (req.url === '/empty') { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(); }
    if (req.url === '/big') { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(Buffer.alloc(2048)); }
    if (req.url === '/slow') { res.writeHead(200, { 'content-type': 'image/jpeg' }); return setTimeout(() => res.end(JPEG), 2000); }
    if (req.url === '/redirect-in') { res.writeHead(301, { location: '/ok.jpg' }); return res.end(); }
    if (req.url === '/redirect-out') { res.writeHead(302, { location: 'http://127.0.0.2:' + server.address().port + '/ok.jpg' }); return res.end(); }
    res.writeHead(500); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// Tests allow plain http to 127.0.0.1 only; production allows https *.fbcdn.net only.
const local = { allowHttp: true, allowHost: (h) => h === '127.0.0.1', timeoutMs: 500, maxBytes: 1024 };

test('host allowlist: only fbcdn.net', () => {
  assert.ok(store.isAllowedImageHost('scontent-hou1-1.xx.fbcdn.net'));
  assert.ok(store.isAllowedImageHost('FBCDN.NET'));
  for (const h of ['evil.com', 'fbcdn.net.evil.com', 'notfbcdn.net', 'facebook.com', '127.0.0.1']) {
    assert.ok(!store.isAllowedImageHost(h), h);
  }
});

test('production rules reject http and non-fbcdn hosts', async () => {
  await assert.rejects(store.downloadImage('http://scontent.xx.fbcdn.net/a.jpg', tmp, 'x'), /not https/);
  await assert.rejects(store.downloadImage('https://evil.com/a.jpg', tmp, 'x'), /host not allowed/);
  await assert.rejects(store.downloadImage('not a url', tmp, 'x'), /invalid URL/);
});

test('downloads image, picks extension from content-type', async () => {
  fs.mkdirSync(path.join(tmp, 'images'), { recursive: true });
  const r = await store.downloadImage(`${base}/ok.jpg`, tmp, 'a', local);
  assert.equal(r.localPath, 'images/a.jpg');
  assert.equal(r.bytes, JPEG.length);
  assert.deepEqual(fs.readFileSync(path.join(tmp, 'images', 'a.jpg')), JPEG);
  const p = await store.downloadImage(`${base}/ok.png`, tmp, 'b', local);
  assert.equal(p.localPath, 'images/b.png');
  const red = await store.downloadImage(`${base}/redirect-in`, tmp, 'c', local);
  assert.equal(red.localPath, 'images/c.jpg');
});

test('download failures give short reasons', async () => {
  await assert.rejects(store.downloadImage(`${base}/404`, tmp, 'x', local), /HTTP 404/);
  await assert.rejects(store.downloadImage(`${base}/html`, tmp, 'x', local), /not an image/);
  await assert.rejects(store.downloadImage(`${base}/empty`, tmp, 'x', local), /empty/);
  await assert.rejects(store.downloadImage(`${base}/big`, tmp, 'x', local), /too large/);
  await assert.rejects(store.downloadImage(`${base}/slow`, tmp, 'x', local), { name: 'TimeoutError' });
  await assert.rejects(store.downloadImage(`${base}/redirect-out`, tmp, 'x', local), /disallowed host/);
});

test('downloadPostImages records failures on the post and does not throw', async () => {
  const posts = [
    { postId: '1', images: [{ index: 0, remoteUrl: `${base}/ok.jpg` }, { index: 1, remoteUrl: `${base}/404` }] },
    { postId: '2/../x', images: [{ index: 0, remoteUrl: `${base}/slow` }] },
    { postId: null, images: [] },
  ];
  const events = [];
  const r = await store.downloadPostImages(posts, tmp, { ...local, onProgress: (e) => events.push(e.ok) });
  assert.deepEqual(r, { total: 3, saved: 1, failed: 2 });
  assert.equal(posts[0].images[0].localPath, 'images/01_1_0.jpg');
  assert.equal(posts[0].images[0].error, null);
  assert.equal(posts[0].images[1].localPath, null);
  assert.equal(posts[0].images[1].error, 'HTTP 404');
  assert.equal(posts[1].images[0].error, 'timed out');
  assert.equal(events.length, 3);
});

test('imageBaseName is filesystem-safe', () => {
  assert.equal(store.imageBaseName({ postId: '../../etc/passwd' }, 0, 2), '01_______etc_passwd_2');
  assert.equal(store.imageBaseName({ postId: null }, 4, 0), '05_post4_0');
});

test('createRunFolder: safe keys only, unique folders', () => {
  const d = new Date(2026, 10, 11, 9, 5, 7);
  const a = store.createRunFolder(tmp, 'acme', d);
  const b = store.createRunFolder(tmp, 'acme', d);
  assert.equal(path.basename(a), '20261111-090507');
  assert.equal(path.basename(b), '20261111-090507-2');
  assert.ok(fs.existsSync(path.join(a, 'images')));
  for (const bad of ['../x', '..', 'a/b', 'A', '', 'a\\b']) assert.throws(() => store.createRunFolder(tmp, bad, d), /Unsafe/, bad);
});

test('writeJsonAtomic replaces file and leaves no temp files', async () => {
  const f = path.join(tmp, 'atomic.json');
  await store.writeJsonAtomic(f, { v: 1 });
  await store.writeJsonAtomic(f, { v: 2, text: 'héllo 👋' });
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { v: 2, text: 'héllo 👋' });
  assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.endsWith('.tmp')), []);
});
