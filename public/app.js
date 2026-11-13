'use strict';

/*
 * Post Collector web UI.
 *
 * Flow: /api/start -> poll /api/status -> /api/result -> download images via
 * /api/image -> SHA-256 in the browser -> verify -> results + ZIP download.
 * Results live only in this tab (no database, nothing stored on the server).
 *
 * All untrusted text (post text, page names, log lines) is rendered with
 * text nodes via h(), never innerHTML.
 */

const STEP_LABELS = {
  validate: 'Validate page',
  start: 'Start Apify run',
  scrape: 'Scraping',
  fetch: 'Fetch results',
  save: 'Download images',
  hash: 'SHA-256 hashing',
  verify: 'Verify integrity',
};
const IMAGE_CONCURRENCY = 4;

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Create an element. children: strings become text nodes (never parsed as HTML). */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Inline SVG icon from path data (constant strings in this file only). */
function icon(...paths) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}
const ICONS = {
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  x: ['M6 6l12 12M18 6L6 18'],
  dash: ['M6 12h12'],
  disk: ['M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z', 'M7 3v5h8V3', 'M7 21v-7h10v7'],
  shield: ['M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6z', 'M9 12l2 2 4-4'],
  alert: ['M12 3l9.5 17h-19z', 'M12 10v4', 'M12 17.5v.01'],
  like: ['M7 10v11H3V10z', 'M7 10l4-7c1.7 0 3 1.3 3 3v3h5.5a2 2 0 0 1 2 2.3l-1.3 8A2 2 0 0 1 18.2 21H7'],
  comment: ['M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z'],
  share: ['M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7', 'M16 6l-4-4-4 4', 'M12 2v13'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  file: ['M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z', 'M14 3v6h6'],
  sun: ['M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z', 'M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4'],
  moon: ['M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z'],
};

const fmtInt = (n) => (typeof n === 'number' ? n.toLocaleString() : '–');
const fmtUsd = (n) => (typeof n === 'number' ? `$${n.toFixed(3)}` : '–');
const shortHash = (hx) => (hx ? `${hx.slice(0, 10)}…${hx.slice(-6)}` : '–');
const fmtBytes = (b) => (typeof b !== 'number' ? '–' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(2)} MB`);
function fmtDate(iso) {
  if (!iso) return 'Date unknown';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Date unknown';
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- Storage helpers (never required to work) ---------------- */
function storageGet(store, k) { try { return window[store].getItem(k); } catch { return null; } }
function storageSet(store, k, v) { try { if (v == null) window[store].removeItem(k); else window[store].setItem(k, v); } catch { /* unavailable */ } }

/* ---------------- Theme ---------------- */
function currentTheme() {
  const set = document.documentElement.dataset.theme;
  if (set) return set;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('theme-toggle').replaceChildren(icon(...(theme === 'dark' ? ICONS.sun : ICONS.moon)));
  storageSet('localStorage', 'theme', theme);
}
(function initTheme() {
  const saved = storageGet('localStorage', 'theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
})();

/* ---------------- State ---------------- */
const state = {
  config: null, accessCode: storageGet('sessionStorage', 'accessCode') || '',
  running: false, steps: {}, logStart: null, bundle: null, dialogPostId: null, blobUrls: [],
};

/* ---------------- API ---------------- */
class ApiError extends Error {
  constructor(status, data) {
    super(data?.reason?.title || data?.error || `HTTP ${status}`);
    this.status = status;
    this.data = data || {};
  }
}
async function api(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (state.accessCode) headers['X-Access-Code'] = state.accessCode;
  if (body) headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (err) {
    throw new ApiError(0, { reason: { code: 'network', title: 'Could not reach the server', message: String(err.message || err), hint: 'Check your internet connection and try again.', source: 'app' } });
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/* ---------------- Stepper ---------------- */
function renderStepper(steps) {
  const ol = $('stepper');
  ol.replaceChildren();
  steps.forEach((name, i) => {
    const dot = h('span', { class: 'step-dot' }, String(i + 1));
    const detail = h('span', { class: 'step-detail' }, ' ');
    const li = h('li', { class: 'step', 'data-step': name }, dot, h('span', { class: 'step-label' }, STEP_LABELS[name] || name), detail);
    state.steps[name] = { li, dot, detail, index: i + 1, status: '' };
  });
  ol.append(...steps.map((s) => state.steps[s].li));
}
function setStep(name, status, detail) {
  const s = state.steps[name];
  if (!s) return;
  s.status = status;
  s.li.className = `step ${status}`;
  if (status === 'done') s.dot.replaceChildren(icon(...ICONS.check));
  else if (status === 'error') s.dot.replaceChildren(icon(...ICONS.x));
  else s.dot.replaceChildren(String(s.index));
  if (detail != null) { s.detail.textContent = detail; s.detail.title = detail; }
  else if (status === 'active') { s.detail.textContent = 'In progress…'; s.detail.title = ''; }
  if (status === 'active') logLine(`▶ ${STEP_LABELS[name] || name}`, 'step');
}
function resetSteps() {
  for (const name of Object.keys(state.steps)) {
    setStep(name, '', null);
    state.steps[name].detail.textContent = ' ';
  }
}

/* ---------------- Apify status pill ---------------- */
function setApifyStatus(status, message, runId) {
  const el = $('apify-status');
  el.hidden = false;
  const cls = status === 'SUCCEEDED' ? 'succeeded' : ['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status) ? 'failed' : 'running';
  el.className = `apify-status ${cls}`;
  el.replaceChildren(h('span', { class: 'dot' }), h('span', {}, `Apify run ${runId || ''}: ${status}${message ? ` — ${message}` : ''}`));
  if (state.steps.scrape?.status === 'active') state.steps.scrape.detail.textContent = message ? `${status} · ${message}` : status;
}

/* ---------------- Log ---------------- */
function logLine(message, level = 'info') {
  const box = $('log');
  box.querySelector('.log-empty')?.remove();
  const secs = (Date.now() - (state.logStart || Date.now())) / 1000;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.append(h('div', { class: `log-line lvl-${level}` },
    h('span', { class: 'log-time' }, `${secs.toFixed(1).padStart(5, ' ')}s`),
    h('span', { class: 'log-msg' }, message)));
  if (atBottom) box.scrollTop = box.scrollHeight;
}

/* ---------------- Tiles ---------------- */
const tileState = {};
function resetTiles() {
  for (const k of Object.keys(tileState)) delete tileState[k];
  for (const id of ['posts', 'images', 'hashes', 'integrity', 'cost']) {
    $(`tile-${id}`).textContent = '–';
    $(`tile-${id}-sub`).textContent = ' ';
  }
  $('tile-integrity-box').className = 'tile';
}
function updateTiles(e) {
  Object.assign(tileState, e);
  const s = tileState;
  if (s.posts != null) { $('tile-posts').textContent = fmtInt(s.posts); $('tile-posts-sub').textContent = 'normalised records'; }
  if (s.images != null) {
    $('tile-images').textContent = `${fmtInt(s.imagesSaved)}/${fmtInt(s.images)}`;
    $('tile-images-sub').textContent = s.imagesFailed ? `${s.imagesFailed} failed (recorded)` : 'downloaded + hashed';
  }
  if (s.hashes != null) { $('tile-hashes').textContent = fmtInt(s.hashes); $('tile-hashes-sub').textContent = 'posts + images + manifest'; }
  if (s.integrity) {
    const ok = s.integrity === 'verified';
    $('tile-integrity').textContent = ok ? 'Verified' : 'Failed';
    $('tile-integrity-sub').textContent = s.checks ? `${s.checks.passed}/${s.checks.checks} checks passed` : '';
    $('tile-integrity-box').className = `tile ${ok ? 'ok' : 'bad'}`;
  }
  if (s.costUsd != null) {
    $('tile-cost').textContent = fmtUsd(s.costUsd);
    $('tile-cost-sub').textContent = s.costCapUsd != null ? `cap $${s.costCapUsd}` : 'reported by Apify';
  } else if (s.costCapUsd != null) {
    $('tile-cost').textContent = '…';
    $('tile-cost-sub').textContent = `cap $${s.costCapUsd}`;
  }
}
function costFrom(c) {
  if (!c) return null;
  return typeof c.usageTotalUsd === 'number' ? c.usageTotalUsd : typeof c.computedCostUsd === 'number' ? c.computedCostUsd : null;
}

/* ---------------- Hashing (Web Crypto) ---------------- */
const enc = new TextEncoder();
async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}
/** Same canonical form as the server (src/hash.js). */
function canonicalContent(post, scheme, fields) {
  const v = (x) => (typeof x === 'string' ? x.normalize('NFC') : x ?? null);
  return JSON.stringify([scheme, ...fields.map((f) => v(post?.[f]))]);
}

/* ---------------- Run a job ---------------- */
function resetRun() {
  resetSteps();
  resetTiles();
  $('apify-status').hidden = true;
  $('results').hidden = true;
  $('empty-state').hidden = true;
  $('tiles').hidden = false;
  $('failure').hidden = true;
  $('failure').replaceChildren();
  $('cards').replaceChildren();
  $('log').replaceChildren();
  for (const u of state.blobUrls) URL.revokeObjectURL(u);
  state.blobUrls = [];
  state.bundle = null;
  state.logStart = Date.now();
}

async function startJob(ev) {
  ev.preventDefault();
  if (state.running) return;
  const pageUrl = $('page-url').value.trim();
  const count = Number($('post-count').value);
  if (!Number.isInteger(count) || count < 1) {
    showFailure({ title: 'Invalid post count', message: 'The number of posts must be a whole number of at least 1.', source: 'input' });
    return;
  }
  state.running = true;
  const btn = $('start-btn');
  btn.disabled = true;
  btn.querySelector('span').textContent = 'Running…';
  resetRun();
  logLine(`Requested ${count} post(s) from ${pageUrl}`, 'step');
  try {
    await runPipeline(pageUrl, count);
  } catch (err) {
    handleFailure(err);
  } finally {
    state.running = false;
    btn.disabled = false;
    btn.querySelector('span').textContent = 'Start';
  }
}

async function runPipeline(pageUrl, count) {
  // 1+2. Validate and start (one server call).
  setStep('validate', 'active');
  const started = await api('/api/start', { method: 'POST', body: { pageUrl, count } });
  logLine(`Page URL: ${started.page.url}`);
  if (started.postCount < started.requested) logLine(`Requested ${started.requested} posts; limited to ${started.postCount} (MAX_POSTS).`, 'warn');
  setStep('validate', 'done', `${started.postCount} post${started.postCount === 1 ? '' : 's'}`);
  setStep('start', 'active');
  if (started.prices) logLine(`Pricing (${started.prices.tier} plan): $${started.prices.startUsd}/run + $${started.prices.perPostUsd}/post. Cost cap $${started.capUsd}.`);
  logLine(`Apify run ${started.runId} started (actor ${started.actorId}, default settings).`);
  updateTiles({ costCapUsd: started.capUsd });
  setApifyStatus(started.status, null, started.runId);
  setStep('start', 'done', started.runId);
  const ref = { runId: started.runId, pageUrl: started.page.url, count: started.postCount, ticket: started.ticket };

  // 3. Poll until the run finishes (the server long-polls ~10 s per call).
  setStep('scrape', 'active');
  let last = null;
  let netErrors = 0;
  for (;;) {
    let st;
    try {
      st = await api(`/api/status?${new URLSearchParams(ref)}`);
      netErrors = 0;
    } catch (err) {
      if (err.status === 0 && ++netErrors <= 3) { logLine('Connection hiccup while checking status; retrying…', 'warn'); await sleep(2000); continue; }
      throw err;
    }
    if (st.status !== last || !st.finished) setApifyStatus(st.status, st.statusMessage, st.runId);
    if (st.status !== last) logLine(`Apify: ${st.status}${st.statusMessage ? ` - ${st.statusMessage}` : ''}`);
    last = st.status;
    if (st.finished) break;
  }
  if (last === 'SUCCEEDED') setStep('scrape', 'done', last);

  // 4. Fetch normalised posts (the server explains failures and reports cost).
  if (last === 'SUCCEEDED') setStep('fetch', 'active');
  const { doc } = await api('/api/result', { method: 'POST', body: ref });
  const posts = doc.posts;
  for (const s of doc.skipped || []) logLine(`Skipped item ${s.index}: ${s.reason}`, 'warn');
  if (posts.length < doc.requestedPosts) logLine(`Asked for ${doc.requestedPosts} posts; the page returned ${posts.length} public post(s).`, 'warn');
  const cost = costFrom(doc.apify);
  if (cost != null) logLine(`Apify run cost: $${cost.toFixed(3)}${doc.apify.costSettled ? '' : ' (not finalised yet)'}`);
  updateTiles({ posts: posts.length, costUsd: cost });
  setStep('fetch', 'done', `${posts.length} post${posts.length === 1 ? '' : 's'}`);

  // 5. Download images through the server proxy and hash each one.
  setStep('save', 'active');
  const files = new Map(); // zip path -> { bytes, type }
  const jobs = [];
  posts.forEach((p) => p.images.forEach((img) => jobs.push({ p, img })));
  let next = 0;
  let saved = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { img } = jobs[next++];
      try {
        const r = await downloadImage(img);
        Object.assign(img, { localPath: `${img.fileStem}.${r.ext}`, bytes: r.bytes.length, contentType: r.type, sha256: r.sha256, downloadedAt: new Date().toISOString(), error: null });
        files.set(img.localPath, { bytes: r.bytes, type: r.type });
        saved++;
        logLine(`Downloaded ${img.localPath} (${fmtBytes(r.bytes.length)}), SHA-256 ${r.sha256.slice(0, 16)}… matches the server`);
      } catch (err) {
        Object.assign(img, { localPath: null, bytes: null, contentType: null, sha256: null, downloadedAt: null, error: String(err.message || err).slice(0, 200) });
        logLine(`Image ${img.index} could not be downloaded: ${img.error}`, 'warn');
      }
      delete img.proxyUrl;
      delete img.fileStem;
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, jobs.length) }, worker));
  for (const p of posts) {
    const ok = p.images.filter((i) => i.localPath).length;
    p.imageDownload = p.images.length === 0 ? 'no-images' : ok === p.images.length ? 'all-saved' : ok === 0 ? 'all-failed' : 'partial';
  }
  doc.counts = { ...doc.counts, images: jobs.length, imagesSaved: saved, imagesFailed: jobs.length - saved };
  updateTiles({ images: jobs.length, imagesSaved: saved, imagesFailed: jobs.length - saved });
  setStep('save', 'done', `${saved}/${jobs.length} images`);

  // 6. Hashing: content hashes (checked against the server's) + posts.json manifest.
  setStep('hash', 'active');
  const { contentScheme, contentFields } = doc.hashing;
  for (const p of posts) {
    const mine = await sha256Hex(enc.encode(canonicalContent(p, contentScheme, contentFields)));
    if (mine !== p.contentSha256) throw new Error(`Content hash for post ${p.postId} differs between server and browser.`);
    logLine(`Content SHA-256 ${p.postId}: ${mine.slice(0, 16)}… (server and browser agree)`);
  }
  const postsJsonText = JSON.stringify(doc, null, 2) + '\n';
  const postsJsonBytes = enc.encode(postsJsonText);
  const manifestHash = await sha256Hex(postsJsonBytes);
  const manifestText = `${manifestHash}  posts.json\n`;
  files.set('posts.json', { bytes: postsJsonBytes, type: 'application/json' });
  files.set('posts.json.sha256', { bytes: enc.encode(manifestText), type: 'text/plain' });
  logLine(`posts.json SHA-256: ${manifestHash.slice(0, 16)}… (written to posts.json.sha256)`);
  const hashes = posts.length + saved + 1;
  updateTiles({ hashes });
  setStep('hash', 'done', `${hashes} hashes`);

  const stamp = new Date(doc.collectedAt).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  state.bundle = { doc, files, folder: `${doc.page.key}-${stamp}` };

  // 7. Verify everything again from the stored bytes.
  setStep('verify', 'active');
  const report = await verifyBundle();
  for (const p of report.problems) logLine(p, 'error');
  logLine(report.ok ? `Integrity verified: ${report.totals.passed}/${report.totals.checks} checks passed.` : `Integrity check FAILED: ${report.totals.failed} problem(s).`, report.ok ? 'info' : 'error');
  updateTiles({ integrity: report.ok ? 'verified' : 'failed', checks: report.totals });
  setStep('verify', report.ok ? 'done' : 'error', `${report.totals.passed}/${report.totals.checks} checks`);

  renderResults(report);
  logLine(report.ok ? '✔ Finished. Data verified. Use "Download ZIP" to keep it.' : 'Finished with verification problems.', report.ok ? 'step' : 'error');
}

async function downloadImage(img) {
  const headers = state.accessCode ? { 'X-Access-Code': state.accessCode } : {};
  const res = await fetch(img.proxyUrl, { headers });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const hash = await sha256Hex(bytes);
  const serverHash = res.headers.get('X-Content-SHA256');
  if (serverHash && serverHash !== hash) throw new Error('image changed in transit (SHA-256 mismatch)');
  return { bytes, sha256: hash, type: res.headers.get('Content-Type') || 'application/octet-stream', ext: res.headers.get('X-Image-Ext') || 'bin' };
}

/* ---------------- Verification (re-hash stored bytes) ---------------- */
async function verifyBundle() {
  const { files } = state.bundle;
  const problems = [];
  let checks = 0;
  let passed = 0;
  const tally = (ok) => { checks++; if (ok) passed++; return ok; };

  const pj = files.get('posts.json');
  const expected = new TextDecoder().decode(files.get('posts.json.sha256').bytes).trim().split(/\s+/)[0];
  const actual = await sha256Hex(pj.bytes);
  const manifest = { expected, actual, ok: tally(expected === actual) };
  if (!manifest.ok) problems.push('posts.json does not match posts.json.sha256');

  const stored = JSON.parse(new TextDecoder().decode(pj.bytes)); // what is actually stored
  const { contentScheme, contentFields } = stored.hashing;
  const posts = [];
  for (const p of stored.posts) {
    const cActual = await sha256Hex(enc.encode(canonicalContent(p, contentScheme, contentFields)));
    const content = { expected: p.contentSha256, actual: cActual, ok: tally(cActual === p.contentSha256) };
    if (!content.ok) problems.push(`Post ${p.postId}: content hash mismatch`);
    const images = [];
    for (const img of p.images) {
      if (!img.localPath) { images.push({ index: img.index, status: 'not-downloaded', note: img.error || '' }); continue; }
      const f = files.get(img.localPath);
      if (!f) { tally(false); images.push({ index: img.index, localPath: img.localPath, status: 'missing', ok: false }); problems.push(`Post ${p.postId}: ${img.localPath} missing`); continue; }
      const a = await sha256Hex(f.bytes);
      const ok = tally(a === img.sha256);
      if (!ok) problems.push(`Post ${p.postId}: ${img.localPath} hash mismatch`);
      images.push({ index: img.index, localPath: img.localPath, bytes: f.bytes.length, expected: img.sha256, actual: a, ok, status: ok ? 'ok' : 'mismatch' });
    }
    posts.push({ postId: p.postId, content, images, ok: content.ok && images.every((i) => i.ok !== false) });
  }
  return { ok: problems.length === 0, checkedAt: new Date().toISOString(), manifest, posts, problems, totals: { checks, passed, failed: checks - passed } };
}

/* ---------------- Results / cards ---------------- */
function blobUrl(bytes, type) {
  const u = URL.createObjectURL(new Blob([bytes], { type }));
  state.blobUrls.push(u);
  return u;
}

function renderResults(report) {
  const { doc, files } = state.bundle;
  const urls = new Map();
  for (const [name, f] of files) urls.set(name, blobUrl(f.bytes, f.type));
  state.bundle.urls = urls;
  $('open-posts-json').href = urls.get('posts.json');
  $('open-manifest').href = urls.get('posts.json.sha256');
  const okById = new Map(report.posts.map((p) => [p.postId, p.ok]));
  $('cards').replaceChildren(...doc.posts.map((p) => postCard(p, okById.get(p.postId), urls)));
  $('results-count').textContent = `· ${doc.posts.length} from ${doc.posts[0]?.pageName || doc.page.url}`;
  $('results').hidden = false;
  // On narrow screens the results are below the controls; bring them into view.
  if (!matchMedia('(min-width: 1200px)').matches) $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function postCard(p, verified, urls) {
  const saved = (p.images || []).filter((i) => i.localPath && urls.has(i.localPath));
  const first = saved[0];
  const media = h('div', { class: 'card-media' });
  if (first) {
    media.append(h('img', { src: urls.get(first.localPath), alt: `Image from post ${p.postId || ''}`, loading: 'lazy' }));
    media.append(h('span', { class: 'badge badge-overlay' }, icon(...ICONS.disk), 'Downloaded'));
    if (saved.length > 1) media.append(h('span', { class: 'badge badge-count' }, `+${saved.length - 1}`));
  } else {
    media.append(h('div', { class: 'no-image' }, (p.images || []).length ? 'Image could not be downloaded' : 'No image in this post'));
  }
  const verifiedBadge = verified
    ? h('span', { class: 'badge badge-ok' }, icon(...ICONS.shield), 'Verified')
    : h('span', { class: 'badge badge-bad' }, icon(...ICONS.alert), 'Not verified');
  const text = typeof p.text === 'string' && p.text.trim()
    ? h('p', { class: 'card-text', title: p.text }, p.text)
    : h('p', { class: 'card-text empty' }, p.text === '' ? '(no text)' : '(text not available)');
  const stat = (ic, n, label) => h('span', { class: 'stat', title: label }, icon(...ic), h('b', {}, fmtInt(n)), ` ${label}`);
  const hashes = h('div', { class: 'hashes' },
    h('div', { class: 'hash-row' }, h('span', {}, 'Content SHA-256'), h('code', { title: p.contentSha256 || '' }, shortHash(p.contentSha256))),
    h('div', { class: 'hash-row' }, h('span', {}, first ? `Image SHA-256${saved.length > 1 ? ` (1 of ${saved.length})` : ''}` : 'Image SHA-256'),
      h('code', { title: first?.sha256 || '' }, first ? shortHash(first.sha256) : 'n/a')));
  const fbLink = p.postUrl
    ? h('a', { class: 'link', href: p.postUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Original on Facebook', icon(...ICONS.external))
    : h('span', { class: 'muted small' }, 'No post URL');
  return h('article', { class: 'card' },
    media,
    h('div', { class: 'card-body' },
      h('div', { class: 'card-meta' }, h('span', { class: 'card-date' }, fmtDate(p.postedAt)), verifiedBadge),
      text,
      h('div', { class: 'stats' },
        stat(ICONS.like, p.likes, 'reactions'), stat(ICONS.comment, p.comments, 'comments'), stat(ICONS.share, p.shares, 'shares')),
      hashes),
    h('div', { class: 'card-foot' },
      fbLink,
      h('button', { class: 'btn-secondary', type: 'button', onclick: () => openRecord(p.postId) }, icon(...ICONS.file), 'View stored record')));
}

function downloadZip() {
  const b = state.bundle;
  if (!b || typeof window.makeZip !== 'function') return;
  const order = ['posts.json', 'posts.json.sha256', ...[...b.files.keys()].filter((k) => k.startsWith('images/')).sort()];
  const zip = window.makeZip(order.map((name) => ({ name: `${b.folder}/${name}`, data: b.files.get(name).bytes })), new Date(b.doc.collectedAt));
  const url = URL.createObjectURL(zip);
  const a = h('a', { href: url, download: `${b.folder}.zip` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  logLine(`Downloaded ${b.folder}.zip (${fmtBytes(zip.size)})`);
}

/* ---------------- Stored-record dialog ---------------- */
function storedDoc() {
  return JSON.parse(new TextDecoder().decode(state.bundle.files.get('posts.json').bytes));
}

function openRecord(postId) {
  if (!state.bundle) return;
  const dlg = $('record-dialog');
  state.dialogPostId = postId;
  $('record-verify-status').textContent = '';
  const doc = storedDoc();
  const idx = doc.posts.findIndex((p) => p.postId === postId);
  const p = doc.posts[idx];
  $('record-subtitle').textContent = `Post ${postId} · record #${idx + 1} in posts.json · read back from the stored file`;
  const { files, urls, folder } = state.bundle;

  const fileRow = (label, name) => {
    const f = files.get(name);
    return h('div', { class: 'file-row' },
      h('div', {}, h('div', { class: 'small muted' }, label), h('code', {}, `${folder}/${name}`)),
      h('span', { class: 'size' }, f ? fmtBytes(f.bytes.length) : 'missing'),
      f ? h('a', { class: 'link', href: urls.get(name), target: '_blank', rel: 'noopener' }, 'Open', icon(...ICONS.external)) : h('span'));
  };
  const filesBox = h('div', { class: 'files' },
    fileRow('posts.json', 'posts.json'),
    fileRow('Manifest', 'posts.json.sha256'),
    ...(p.images || []).map((i) => (i.localPath ? fileRow(`Image ${i.index}`, i.localPath)
      : h('div', { class: 'file-row' }, h('span', {}, `Image ${i.index}: not downloaded`), h('span', { class: 'size' }, i.error || ''), h('span')))));
  const thumbs = h('div', { class: 'thumbs' }, ...(p.images || []).filter((i) => i.localPath && urls.has(i.localPath))
    .map((i) => h('img', { src: urls.get(i.localPath), alt: `Stored image ${i.index}` })));

  const rows = [
    ['postId', p.postId], ['pageName', p.pageName], ['pageUrl', p.pageUrl], ['postUrl', p.postUrl],
    ['postedAt', p.postedAt], ['text', p.text], ['likes', p.likes], ['comments', p.comments], ['shares', p.shares],
    ['mediaType', p.mediaType], ['images', `${(p.images || []).length} (${p.imageDownload || 'n/a'})`], ['collectedAt', p.collectedAt],
    ['Apify run', doc.apify?.runId], ['Apify dataset', doc.apify?.datasetId],
  ];
  const kv = (list, monoValues) => h('table', { class: 'kv' }, h('tbody', {}, ...list.map(([k, v]) =>
    h('tr', {}, h('th', {}, k), h('td', { class: v == null ? 'null' : monoValues ? 'mono' : '' }, v == null ? 'null' : String(v))))));
  const manifestHash = new TextDecoder().decode(files.get('posts.json.sha256').bytes).trim().split(/\s+/)[0];
  const hashRows = [
    ['Content SHA-256', p.contentSha256],
    ...(p.images || []).map((i) => [`Image ${i.index} SHA-256`, i.sha256 ?? (i.error ? `not downloaded (${i.error})` : null)]),
    ['posts.json SHA-256', manifestHash],
  ];
  const hs = doc.hashing;
  const section = (title, ...content) => h('section', {}, h('h3', { class: 'section-title' }, title), ...content);

  $('record-body').replaceChildren(
    thumbs.childElementCount ? section('Images', thumbs) : null,
    section('Files in the ZIP', filesBox),
    section('Fields', kv(rows, false)),
    section('Hashes', kv(hashRows, true),
      h('p', { class: 'muted small' }, `Content hash = SHA-256 of ["${hs.contentScheme}", ${hs.contentFields.join(', ')}] as UTF-8 JSON, strings ${hs.stringNormalization}-normalised. Image hash = SHA-256 of the file bytes.`)),
    h('section', { id: 'verify-section', hidden: true }),
    section('Raw JSON (as stored in posts.json)', h('pre', { class: 'raw-json' }, JSON.stringify(p, null, 2))),
  );
  if (!dlg.open) dlg.showModal();
}

async function reverify() {
  if (!state.bundle) return;
  const btn = $('record-reverify');
  btn.disabled = true;
  $('record-verify-status').textContent = 'Re-hashing stored files…';
  try {
    const r = await verifyBundle();
    const post = r.posts.find((p) => p.postId === state.dialogPostId);
    renderVerify(r, post);
    $('record-verify-status').textContent = `${post?.ok && r.manifest.ok ? 'Verified' : 'Verification FAILED'} at ${new Date(r.checkedAt).toLocaleTimeString()} · all posts: ${r.totals.passed}/${r.totals.checks} checks passed`;
  } catch (err) {
    $('record-verify-status').textContent = `Verification error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

function renderVerify(r, post) {
  const sec = document.getElementById('verify-section');
  if (!sec) return;
  const check = (ok, title, detail) => h('div', { class: `check ${ok === true ? 'ok' : ok === false ? 'bad' : 'skip'}` },
    h('span', { class: 'check-icon' }, icon(...(ok === true ? ICONS.check : ok === false ? ICONS.x : ICONS.dash))),
    h('div', { class: 'check-main' }, h('div', {}, title), detail ? h('code', {}, detail) : null));
  const items = [check(r.manifest.ok, 'posts.json matches posts.json.sha256', `expected ${r.manifest.expected}\nactual   ${r.manifest.actual}`)];
  if (post) {
    items.push(check(post.content.ok, 'Content hash (postId, postUrl, postedAt, text)', `expected ${post.content.expected || 'none'}\nactual   ${post.content.actual}`));
    for (const i of post.images) {
      if (i.status === 'not-downloaded') items.push(check(null, `Image ${i.index}: not downloaded`, i.note || ''));
      else items.push(check(i.ok, `Image ${i.index}: ${i.localPath}${i.bytes ? ` (${fmtBytes(i.bytes)})` : ''}`, `expected ${i.expected || 'none'}\nactual   ${i.actual || i.status}`));
    }
  } else {
    items.push(check(false, 'Post not found in posts.json'));
  }
  sec.hidden = false;
  sec.replaceChildren(h('h3', { class: 'section-title' }, `Verification · ${new Date(r.checkedAt).toLocaleTimeString()}`), h('div', { class: 'checks' }, ...items));
  sec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ---------------- Failures ---------------- */
const SOURCE_LABELS = { input: 'Checked before contacting Apify', apify: 'Reported by Apify', facebook: 'Reported by Facebook (via the Apify scraper)', app: 'Reported by this app' };

function handleFailure(err) {
  const data = err instanceof ApiError ? err.data : {};
  if (err instanceof ApiError && err.status === 401) {
    storageSet('sessionStorage', 'accessCode', null);
    state.accessCode = '';
    showGate('Your access code was not accepted. Please enter it again.');
  }
  const reason = data.reason || { title: 'Something went wrong', message: err.message || String(err), hint: 'Try again.', source: 'app' };
  // Mark the failing step: the server says which; otherwise the step in progress.
  const active = Object.keys(state.steps).find((k) => state.steps[k].status === 'active');
  const step = data.step || active;
  for (const k of Object.keys(state.steps)) {
    if (k === step) break;
    if (state.steps[k].status === 'active') setStep(k, 'done');
  }
  if (step) setStep(step, 'error', reason.title);
  const cost = costFrom(data.cost);
  if (cost != null) {
    logLine(`Apify charged $${cost.toFixed(3)} for this run.`);
    updateTiles({ costUsd: cost });
  }
  logLine(`${reason.title}: ${reason.details && reason.source !== 'input' ? reason.details : reason.message}`, 'error');
  if (reason.hint) logLine(`What to do: ${reason.hint}`, 'warn');
  showFailure(reason);
}

function showFailure(r) {
  const box = $('failure');
  const rows = [
    h('div', { class: 'failure-head' },
      icon(...ICONS.x),
      h('div', {},
        h('h2', { class: 'failure-title' }, r.title || 'Collection failed'),
        h('p', { class: 'failure-source muted small' }, SOURCE_LABELS[r.source] || '', r.code ? ` · ${r.code}` : ''))),
    h('p', { class: 'failure-message' }, r.message || ''),
  ];
  if (r.details) {
    rows.push(h('div', { class: 'failure-details' },
      h('span', { class: 'failure-label' }, r.source === 'facebook' ? 'Exact message from Facebook' : 'Exact message'),
      h('blockquote', {}, r.details)));
  }
  if (r.hint) rows.push(h('p', { class: 'failure-hint' }, h('strong', {}, 'What to do: '), r.hint));
  if (r.runId) rows.push(h('p', { class: 'muted small' }, `Apify run ID: ${r.runId}`));
  box.replaceChildren(...rows);
  box.hidden = false;
  $('empty-state').hidden = true;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ---------------- Cost estimate ---------------- */
function updateCostEstimate() {
  const cfg = state.config || {};
  const out = $('cost-estimate');
  const n = Number($('post-count').value);
  if (!cfg.pricing || !Number.isInteger(n) || n < 1) { out.textContent = cfg.maxPosts ? `max ${cfg.maxPosts}` : ''; return; }
  const usd = cfg.pricing.startUsd + cfg.pricing.perPostUsd * n;
  out.textContent = `max ≈ $${usd.toFixed(usd < 1 ? 3 : 2)}${cfg.maxPosts ? ` · limit ${cfg.maxPosts}` : ''}`;
  out.title = `Apify ${cfg.pricing.tier} plan: $${cfg.pricing.startUsd} per run + $${cfg.pricing.perPostUsd} per post. Apify is given this amount as a hard cost cap.`;
}

/* ---------------- Access gate ---------------- */
function showGate(message) {
  $('app').hidden = true;
  $('gate').hidden = false;
  const err = $('gate-error');
  err.hidden = !message;
  err.textContent = message || '';
  $('gate-code').value = '';
  $('gate-code').focus();
}

async function submitGate(ev) {
  ev.preventDefault();
  state.accessCode = $('gate-code').value.trim();
  const cfg = await api('/api/config');
  if (!cfg.accessGranted) {
    state.accessCode = '';
    showGate('That access code is not correct.');
    return;
  }
  storageSet('sessionStorage', 'accessCode', state.accessCode);
  $('gate').hidden = true;
  showApp(cfg);
}

/* ---------------- Init ---------------- */
function showApp(cfg) {
  state.config = cfg;
  $('app').hidden = false;
  if (!$('page-url').value) $('page-url').value = cfg.defaultPageUrl || '';
  const countInput = $('post-count');
  if (!countInput.value) countInput.value = String(cfg.defaultCount);
  if (cfg.maxPosts) countInput.max = String(cfg.maxPosts);
  $('post-count-options').replaceChildren(...cfg.postCountOptions.map((n) => h('option', { value: n })));
  updateCostEstimate();
  $('allowlist-chips').replaceChildren(...(cfg.examplePages || []).map((u) =>
    h('button', { class: 'chip', type: 'button', title: 'Use this page', onclick: () => { $('page-url').value = u; } }, u.replace(/^https:\/\/www\.facebook\.com\//, ''))));
  $('allowlist-chips').parentElement.hidden = !(cfg.examplePages || []).length;
  const badge = $('mode-badge');
  badge.hidden = false;
  badge.textContent = 'LIVE';
  badge.className = 'mode-badge live';
  badge.title = 'Live: every run calls Apify and is charged to the Apify account';
  renderStepper(cfg.steps);
}

async function init() {
  applyTheme(currentTheme());
  $('theme-toggle').addEventListener('click', () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
  $('collect-form').addEventListener('submit', startJob);
  $('gate-form').addEventListener('submit', (e) => submitGate(e).catch((err) => showGate(err.message)));
  $('post-count').addEventListener('input', updateCostEstimate);
  $('download-zip').addEventListener('click', downloadZip);
  $('record-close').addEventListener('click', () => $('record-dialog').close());
  $('record-reverify').addEventListener('click', reverify);
  $('record-dialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

  const cfg = await api('/api/config');
  if (cfg.accessCodeRequired && !cfg.accessGranted) {
    storageSet('sessionStorage', 'accessCode', null);
    state.accessCode = '';
    showGate(null);
    return;
  }
  showApp(cfg);
}

init().catch((err) => {
  $('app').hidden = false;
  const reason = err?.data?.reason;
  showFailure(reason || { title: 'Could not load the app', message: err.message, hint: 'Reload the page. If it keeps failing, the server may be misconfigured.', source: 'app' });
});
