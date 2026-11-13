'use strict';

/**
 * Local storage: run folders, atomic JSON writes, safe image downloads.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 20_000;
const IMAGE_CONCURRENCY = 3;
const CONTENT_TYPES = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
  'image/webp': 'webp', 'image/gif': 'gif',
};

/** Only Facebook's CDN is allowed as an image source. */
function isAllowedImageHost(hostname) {
  const h = hostname.toLowerCase();
  return h === 'fbcdn.net' || h.endsWith('.fbcdn.net');
}

const SAFE_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,120}$/;

function pad(n) {
  return String(n).padStart(2, '0');
}

/** YYYYMMDD-HHMMSS in local time. */
function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Create output/<pageKey>/<stamp>/images and return its absolute path. */
function createRunFolder(outputDir, pageKey, date = new Date()) {
  if (!SAFE_KEY_RE.test(pageKey) || pageKey.includes('..')) {
    throw new Error(`Unsafe page key for folder name: ${JSON.stringify(pageKey)}`);
  }
  const base = path.join(outputDir, pageKey, stamp(date));
  let dir = base;
  for (let i = 2; fs.existsSync(dir); i++) dir = `${base}-${i}`;
  fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
  return dir;
}

/** Write a file atomically: temp file in the same folder, fsync, rename over the target. */
async function writeFileAtomic(file, data) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fh = await fsp.open(tmp, 'wx');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

function writeJsonAtomic(file, obj) {
  return writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n');
}

/**
 * Download one image to <runDir>/images/<baseName>.<ext>.
 * Returns { localPath, bytes, contentType, downloadedAt } or throws with a short reason.
 */
async function downloadImage(remoteUrl, runDir, baseName, opts = {}) {
  const { buffer, contentType, ext } = await fetchImage(remoteUrl, opts);
  const rel = `images/${baseName}.${ext}`;
  await writeFileAtomic(path.join(runDir, ...rel.split('/')), buffer);
  return { localPath: rel, bytes: buffer.length, contentType, downloadedAt: new Date().toISOString() };
}

/**
 * Fetch one image into memory (Facebook CDN hosts only, https, every redirect
 * hop checked, size and type limited). Returns { buffer, contentType, ext }.
 */
async function fetchImage(remoteUrl, opts = {}) {
  const allowHost = opts.allowHost || isAllowedImageHost;
  const timeoutMs = opts.timeoutMs ?? IMAGE_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_IMAGE_BYTES;

  const check = (href, hop) => {
    let u;
    try { u = new URL(href); } catch { throw new Error('invalid URL'); }
    if (u.protocol !== 'https:' && !opts.allowHttp) throw new Error(hop ? 'redirected to non-https URL' : 'not https');
    if (!allowHost(u.hostname)) throw new Error(hop ? `redirected to disallowed host (${u.hostname})` : `host not allowed (${u.hostname})`);
    return u;
  };

  // Follow redirects manually so every hop is checked BEFORE we connect to it.
  const signal = AbortSignal.timeout(timeoutMs);
  let u = check(remoteUrl, 0);
  let res;
  for (let hop = 0; ; hop++) {
    res = await fetch(u, { signal, redirect: 'manual' });
    if (res.status < 300 || res.status > 399) break;
    const loc = res.headers.get('location');
    await res.body?.cancel();
    if (!loc) throw new Error(`HTTP ${res.status} without Location`);
    if (hop >= 3) throw new Error('too many redirects');
    u = check(new URL(loc, u).href, hop + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ext = CONTENT_TYPES[contentType];
  if (!ext) throw new Error(`not an image (content-type "${contentType || 'none'}")`);
  const declared = Number(res.headers.get('content-length'));
  if (declared > maxBytes) throw new Error(`too large (${declared} bytes)`);

  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`too large (>${maxBytes} bytes)`);
    chunks.push(chunk);
  }
  if (total === 0) throw new Error('empty response');
  return { buffer: Buffer.concat(chunks), contentType, ext };
}

/** File-name-safe stem for a post's image. */
function imageBaseName(post, postIndex, imageIndex) {
  const id = (post.postId || `post${postIndex}`).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
  return `${String(postIndex + 1).padStart(2, '0')}_${id}_${imageIndex}`;
}

/**
 * Download every image of every post (limited concurrency). Mutates each image
 * entry, adding localPath/bytes/contentType/downloadedAt or an `error` string.
 * Failures are recorded, never thrown. onProgress({ ok, post, image, error }) per image.
 */
async function downloadPostImages(posts, runDir, { onProgress, ...opts } = {}) {
  const jobs = [];
  posts.forEach((post, pi) => post.images.forEach((img) => jobs.push({ post, pi, img })));
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const { post, pi, img } = jobs[next++];
      try {
        const r = await downloadImage(img.remoteUrl, runDir, imageBaseName(post, pi, img.index), opts);
        Object.assign(img, r, { error: null });
        onProgress?.({ ok: true, post, image: img });
      } catch (err) {
        const reason = err?.name === 'TimeoutError' ? 'timed out' : String(err?.message || err).slice(0, 200);
        Object.assign(img, { localPath: null, bytes: null, contentType: null, downloadedAt: null, error: reason });
        onProgress?.({ ok: false, post, image: img, error: reason });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, jobs.length) }, worker));
  return {
    total: jobs.length,
    saved: jobs.filter((j) => j.img.localPath).length,
    failed: jobs.filter((j) => j.img.error).length,
  };
}

module.exports = {
  createRunFolder, writeFileAtomic, writeJsonAtomic, downloadImage, fetchImage, downloadPostImages,
  isAllowedImageHost, imageBaseName, stamp, MAX_IMAGE_BYTES,
};
