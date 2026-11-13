'use strict';

/**
 * SHA-256 fingerprinting and verification of a saved run.
 *
 * Chain of integrity:
 *   posts.json.sha256  --covers-->  posts.json  --contains-->  per-post content hashes
 *                                                             + per-image file hashes
 *
 * Content hash (scheme "fbpoc-post-v1"): SHA-256 over the UTF-8 JSON encoding of
 *   ["fbpoc-post-v1", postId, postUrl, postedAt, text]
 * Fixed field order; strings NFC-normalised; missing values encoded as null.
 * Only stable fields are included - engagement counts change over time and are
 * deliberately excluded, so the same post always gets the same content hash.
 *
 * Image hash: SHA-256 over the downloaded file's bytes.
 *
 * Note: this detects accidental or casual modification. It is not a signature -
 * someone who rewrites a post AND recomputes every hash would not be detected.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeJsonAtomic, writeFileAtomic } = require('./store');

const CONTENT_SCHEME = 'fbpoc-post-v1';
const CONTENT_FIELDS = ['postId', 'postUrl', 'postedAt', 'text'];
const MANIFEST = 'posts.json.sha256';
const HASH_RE = /^[0-9a-f]{64}$/;

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function canonicalContent(post) {
  const v = (x) => (typeof x === 'string' ? x.normalize('NFC') : x ?? null);
  return JSON.stringify([CONTENT_SCHEME, ...CONTENT_FIELDS.map((f) => v(post?.[f]))]);
}

function contentHash(post) {
  return sha256(Buffer.from(canonicalContent(post), 'utf8'));
}

async function fileHash(file) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

/** Resolve an image's localPath safely inside <runDir>/images, or return null. */
function safeImagePath(runDir, localPath) {
  if (typeof localPath !== 'string' || !/^images\/[A-Za-z0-9._-]+$/.test(localPath)) return null;
  const imagesDir = path.resolve(runDir, 'images');
  const abs = path.resolve(runDir, ...localPath.split('/'));
  return path.dirname(abs) === imagesDir ? abs : null;
}

function manifestLine(hex, name = 'posts.json') {
  return `${hex}  ${name}\n`; // sha256sum text-mode format
}

/**
 * Add content + image hashes to posts.json, rewrite it atomically, then write
 * posts.json.sha256. Returns { posts, images, postsJsonSha256 }.
 */
async function hashRun(runDir, { onProgress } = {}) {
  const postsFile = path.join(runDir, 'posts.json');
  const doc = JSON.parse(await fsp.readFile(postsFile, 'utf8'));
  let images = 0;
  for (const post of doc.posts) {
    post.contentSha256 = contentHash(post);
    onProgress?.({ kind: 'content', post, hash: post.contentSha256 });
    for (const img of post.images || []) {
      if (!img.localPath) { img.sha256 = null; continue; }
      const abs = safeImagePath(runDir, img.localPath);
      if (!abs) throw new Error(`Unsafe image path in posts.json: ${img.localPath}`);
      img.sha256 = await fileHash(abs);
      images++;
      onProgress?.({ kind: 'image', post, image: img, hash: img.sha256 });
    }
  }
  doc.hashing = {
    algorithm: 'SHA-256',
    contentScheme: CONTENT_SCHEME,
    contentFields: CONTENT_FIELDS,
    stringNormalization: 'NFC',
    imageHash: 'SHA-256 of the downloaded file bytes',
    manifest: MANIFEST,
    hashedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(postsFile, doc);
  const postsJsonSha256 = sha256(await fsp.readFile(postsFile));
  await writeFileAtomic(path.join(runDir, MANIFEST), manifestLine(postsJsonSha256));
  return { posts: doc.posts.length, images, postsJsonSha256 };
}

/**
 * Recompute every hash from disk and compare. Never throws for data problems;
 * returns a report: { ok, checkedAt, manifest, posts[], totals, problems[] }.
 */
async function verifyRun(runDir) {
  const problems = [];
  const report = { ok: false, checkedAt: new Date().toISOString(), manifest: null, posts: [], totals: null, problems };
  const postsFile = path.join(runDir, 'posts.json');
  const manifestFile = path.join(runDir, MANIFEST);
  let passed = 0;
  let failed = 0;
  const pass = () => passed++;
  const fail = (msg) => { failed++; problems.push(msg); };

  // 1. posts.json vs posts.json.sha256
  let postsBytes = null;
  try { postsBytes = await fsp.readFile(postsFile); } catch { fail('posts.json is missing'); }
  let expected = null;
  try {
    const line = (await fsp.readFile(manifestFile, 'utf8')).split(/\r?\n/).find((l) => l.trim());
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line || '');
    if (m && m[2] === 'posts.json') expected = m[1];
  } catch { /* handled below */ }
  const actual = postsBytes ? sha256(postsBytes) : null;
  report.manifest = { file: MANIFEST, expected, actual, ok: Boolean(expected && actual && expected === actual) };
  if (!expected) fail(`${MANIFEST} is missing or malformed`);
  else if (actual && expected !== actual) fail('posts.json does not match posts.json.sha256 (file was modified)');
  else if (actual) pass();

  // 2. Per-post content and image hashes
  let doc = null;
  if (postsBytes) {
    try { doc = JSON.parse(postsBytes.toString('utf8')); } catch { fail('posts.json is not valid JSON'); }
  }
  for (const post of doc?.posts || []) {
    const label = post.postId || post.postUrl || '(unknown post)';
    const exp = typeof post.contentSha256 === 'string' && HASH_RE.test(post.contentSha256) ? post.contentSha256 : null;
    const act = contentHash(post);
    const content = { expected: exp, actual: act, ok: exp === act };
    if (!exp) fail(`post ${label}: no content hash recorded`);
    else if (!content.ok) fail(`post ${label}: content hash mismatch (postId/postUrl/postedAt/text changed)`);
    else pass();

    const images = [];
    for (const img of post.images || []) {
      const r = { index: img.index, localPath: img.localPath ?? null, expected: img.sha256 ?? null, actual: null, bytes: null, ok: null, status: '' };
      if (!img.localPath) {
        r.status = 'not-downloaded';
        r.note = img.error || 'not downloaded';
      } else {
        const abs = safeImagePath(runDir, img.localPath);
        if (!abs) { r.ok = false; r.status = 'unsafe-path'; fail(`post ${label}: unsafe image path ${img.localPath}`); }
        else if (!fs.existsSync(abs)) { r.ok = false; r.status = 'missing'; fail(`post ${label}: image ${img.localPath} is missing`); }
        else {
          r.actual = await fileHash(abs);
          r.bytes = (await fsp.stat(abs)).size;
          r.ok = Boolean(r.expected) && r.expected === r.actual;
          r.status = r.ok ? 'ok' : r.expected ? 'mismatch' : 'not-hashed';
          if (r.ok) pass();
          else fail(`post ${label}: image ${img.localPath} ${r.expected ? 'hash mismatch (file was modified)' : 'has no hash recorded'}`);
        }
      }
      images.push(r);
    }
    report.posts.push({ postId: post.postId ?? null, content, images, ok: content.ok && images.every((i) => i.ok !== false) });
  }

  report.totals = { checks: passed + failed, passed, failed };
  report.ok = failed === 0 && Boolean(doc);
  return report;
}

/** All run folders (containing posts.json) under outputDir, newest first. */
function listRunDirs(outputDir) {
  const runs = [];
  if (!fs.existsSync(outputDir)) return runs;
  for (const page of fs.readdirSync(outputDir, { withFileTypes: true })) {
    if (!page.isDirectory() || page.name.startsWith('_')) continue;
    for (const run of fs.readdirSync(path.join(outputDir, page.name), { withFileTypes: true })) {
      const dir = path.join(outputDir, page.name, run.name);
      if (run.isDirectory() && fs.existsSync(path.join(dir, 'posts.json'))) runs.push(dir);
    }
  }
  return runs.sort().reverse();
}

module.exports = {
  CONTENT_SCHEME, CONTENT_FIELDS, MANIFEST,
  sha256, canonicalContent, contentHash, fileHash, safeImagePath, hashRun, verifyRun, listRunDirs,
};
