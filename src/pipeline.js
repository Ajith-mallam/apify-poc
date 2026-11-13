'use strict';

/**
 * End-to-end collection pipeline, shared by the CLI and the UI server.
 *
 * Progress is reported through onEvent(event):
 *   { type: 'step', step, status: 'active'|'done'|'error', detail? }
 *   { type: 'log',  level: 'info'|'warn'|'error', message }
 *   { type: 'apify', runId, status, statusMessage }        live Apify run status
 *   { type: 'summary', ...partial tile values }
 *   { type: 'done', runDir, postsFile, verified } | { type: 'failed', error, reason }
 *
 * reason (see errors.js) explains exactly why a run could not collect posts.
 *
 * Steps (UI stepper order): validate, start, scrape, fetch, save, hash, verify.
 */

const path = require('node:path');
const apify = require('./apify');
const store = require('./store');
const { normaliseItems } = require('./normalise');
const { hashRun, verifyRun } = require('./hash');
const errors = require('./errors');

const STEPS = ['validate', 'start', 'scrape', 'fetch', 'save', 'hash', 'verify'];
const SCHEMA_VERSION = 1;

/**
 * @param {object} p
 * @param {object} p.config        from loadConfig()
 * @param {string} p.pageInput     URL or username (validated here)
 * @param {number} p.count         requested posts (clamped to MAX_POSTS here, if set)
 * @param {function} [p.onEvent]
 */
async function collect({ config, pageInput, count, onEvent = () => {} }) {
  const emit = onEvent;
  const log = (message, level = 'info') => emit({ type: 'log', level, message });
  let current = null;
  const step = (name, status, detail) => {
    if (status === 'active') current = name;
    emit({ type: 'step', step: name, status, ...(detail ? { detail } : {}) });
  };
  const rel = (p) => path.relative(config.projectRoot, p).split(path.sep).join('/');

  try {
    // 1. Validate the page URL format and clamp the post count.
    step('validate', 'active');
    let page, postCount;
    try {
      page = config.resolvePage(pageInput);
      postCount = config.clampPostCount(count);
    } catch (e) {
      throw new errors.CollectError(errors.inputReason(e), { cause: e });
    }
    if (postCount < Number(count)) log(`Requested ${count} posts; capped at MAX_POSTS=${config.maxPosts}.`, 'warn');
    log(`Page URL: ${page.url}`);
    step('validate', 'done', `${postCount} posts`);

    const client = apify.createClient(config);

    // 2. Start the Apify run with a cost cap.
    step('start', 'active');
    const { run, capUsd, prices } = await apiCall(() => apify.startRun(client, { pageUrl: page.url, postCount }));
    if (prices) log(`Pricing (${prices.tier} plan): $${prices.startUsd}/run + $${prices.perPostUsd}/post. Cost cap $${capUsd}.`);
    log(`Apify run ${run.id} started (actor ${apify.ACTOR_ID}, default settings).`);
    emit({ type: 'apify', runId: run.id, status: run.status, statusMessage: run.statusMessage ?? null });
    emit({ type: 'summary', costCapUsd: capUsd });
    step('start', 'done', run.id);

    // 3. Wait for the run, streaming its status.
    step('scrape', 'active');
    const final = await apiCall(() => apify.waitForRun(client, run.id, {
      timeoutSecs: 600 + 3 * postCount, // bigger runs take longer
      onStatus: (r) => emit({ type: 'apify', runId: r.id, status: r.status, statusMessage: r.statusMessage ?? null }),
    }));
    if (final.status !== 'SUCCEEDED') {
      await reportCost(client, final, 0, prices);
      throw new errors.CollectError(errors.runStatusReason(final));
    }
    log(`Apify run finished: ${final.statusMessage || final.status}`);
    step('scrape', 'done', final.status);

    // 4. Fetch dataset items.
    step('fetch', 'active');
    const items = await apiCall(() => apify.fetchItems(client, final.defaultDatasetId, postCount));
    log(`Fetched ${items.length} item(s) from dataset ${final.defaultDatasetId}.`);
    const collectedAt = new Date().toISOString();
    const { posts, skipped } = normaliseItems(items, { collectedAt });
    if (posts.length === 0) {
      // Nothing usable: explain exactly why (Facebook's own message where available).
      const reason = errors.noPostsReason(items, skipped);
      log(`Apify returned no posts for ${page.url}.`, 'warn');
      await reportCost(client, final, 0, prices);
      throw new errors.CollectError({ ...reason, runId: final.id });
    }
    for (const s of skipped) log(`Skipped item ${s.index}: ${s.reason}`, 'warn');
    step('fetch', 'done', `${posts.length} post${posts.length === 1 ? '' : 's'}`);
    if (posts.length < postCount) {
      log(`Asked for ${postCount} posts; the page only returned ${posts.length} public post(s).`, 'warn');
    }

    // Apify finalises charges a few seconds after the run; let that happen in
    // the background while images download, and await it before writing.
    const costPromise = apify.settleRun(client, final.id, posts.length, prices).then(({ run: settledRun, settled }) => {
      const cost = apify.runCost(settledRun, prices, settled);
      if (!settled) log('Apify had not finalised the cost yet; the saved figure may be lower than the final charge.', 'warn');
      if (cost.usageTotalUsd != null) log(`Apify run cost: $${cost.usageTotalUsd.toFixed(3)}`);
      emit({ type: 'summary', costUsd: cost.usageTotalUsd, costSettled: settled });
      return {
        actorId: apify.ACTOR_ID,
        runId: final.id,
        datasetId: final.defaultDatasetId,
        status: final.status,
        statusMessage: final.statusMessage ?? null,
        startedAt: toIso(final.startedAt),
        finishedAt: toIso(final.finishedAt),
        ...cost,
        consoleUrl: `https://console.apify.com/view/runs/${final.id}`,
      };
    });
    costPromise.catch(() => {}); // handled when awaited below

    // 5. Normalise, download images, write posts.json atomically.
    step('save', 'active');
    const runDir = store.createRunFolder(config.outputDir, page.key);
    log(`Run folder: ${rel(runDir)}`);

    const dl = await store.downloadPostImages(posts, runDir, {
      onProgress: ({ ok, image, error }) => {
        if (ok) log(`Saved ${image.localPath} (${Math.round(image.bytes / 1024)} KB)`);
        else log(`Image ${image.index} of a post could not be downloaded: ${error}`, 'warn');
      },
    });
    for (const p of posts) p.imageDownload = summariseDownload(p.images);
    emit({ type: 'summary', posts: posts.length, images: dl.total, imagesSaved: dl.saved, imagesFailed: dl.failed });

    log('Waiting for Apify to finalise the run cost…');
    const apifyInfo = await costPromise;

    const doc = {
      schemaVersion: SCHEMA_VERSION,
      page: { key: page.key, url: page.url },
      requestedPosts: postCount,
      collectedAt,
      apify: apifyInfo,
      counts: { items: items.length, posts: posts.length, skipped: skipped.length, images: dl.total, imagesSaved: dl.saved, imagesFailed: dl.failed },
      skipped,
      posts,
    };
    const postsFile = path.join(runDir, 'posts.json');
    await store.writeJsonAtomic(postsFile, doc);
    log(`Wrote ${rel(postsFile)} (${posts.length} posts, ${dl.saved}/${dl.total} images saved).`);
    step('save', 'done', `${posts.length} posts · ${dl.saved}/${dl.total} images`);

    // 6. SHA-256 hashing (content hash per post, file hash per image, manifest).
    step('hash', 'active');
    const hr = await hashRun(runDir, {
      onProgress: (e) => {
        if (e.kind === 'content') log(`Content SHA-256 ${e.post.postId}: ${e.hash.slice(0, 16)}…`);
        else log(`Image SHA-256 ${e.image.localPath}: ${e.hash.slice(0, 16)}…`);
      },
    });
    log(`Wrote posts.json.sha256: ${hr.postsJsonSha256.slice(0, 16)}…`);
    emit({ type: 'summary', hashes: hr.posts + hr.images + 1 });
    step('hash', 'done', `${hr.posts + hr.images + 1} hashes`);

    // 7. Verify everything again from disk.
    step('verify', 'active');
    const report = await verifyRun(runDir);
    for (const p of report.problems) log(p, 'error');
    log(report.ok
      ? `Integrity verified from disk: ${report.totals.passed}/${report.totals.checks} checks passed.`
      : `Integrity check FAILED: ${report.totals.failed} problem(s).`, report.ok ? 'info' : 'error');
    emit({ type: 'summary', integrity: report.ok ? 'verified' : 'failed', checks: report.totals });
    step('verify', report.ok ? 'done' : 'error', `${report.totals.passed}/${report.totals.checks} checks`);

    emit({ type: 'done', runDir: rel(runDir), postsFile: rel(postsFile), verified: report.ok });
    return { runDir, postsFile, report };
  } catch (err) {
    const reason = errors.toReason(err);
    const message = reason.details && reason.source !== 'input' ? `${reason.title}: ${reason.details}` : `${reason.title}: ${reason.message}`;
    if (current) step(current, 'error', reason.title.length > 80 ? reason.title.slice(0, 77) + '…' : reason.title);
    log(message, 'error');
    if (reason.hint) log(`What to do: ${reason.hint}`, 'warn');
    emit({ type: 'failed', error: message, reason });
    throw err;
  }

  /** Report what a failed run cost (Apify still charges the run start). Never throws. */
  async function reportCost(client, run, posts, prices) {
    try {
      log('Checking what Apify charged for this run…');
      const { run: r, settled } = await apify.settleRun(client, run.id, posts, prices, { maxWaitMs: 15000, minUsd: prices?.startUsd ?? 0 });
      const cost = apify.runCost(r, prices, settled);
      const usd = cost.usageTotalUsd ?? cost.computedCostUsd;
      if (usd != null) log(`Apify charged $${usd.toFixed(3)} for this run${settled ? '' : ' so far (not finalised yet)'}.`);
      emit({ type: 'summary', costUsd: usd ?? null, costSettled: settled, posts: 0 });
    } catch { /* cost is informational only */ }
  }
}

/** Run an Apify API call and convert its errors into an explained CollectError. */
async function apiCall(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof errors.CollectError) throw e;
    throw new errors.CollectError(errors.apifyApiReason(e), { cause: e });
  }
}

function summariseDownload(images) {
  if (images.length === 0) return 'no-images';
  const ok = images.filter((i) => i.localPath).length;
  if (ok === images.length) return 'all-saved';
  return ok === 0 ? 'all-failed' : 'partial';
}

function toIso(d) {
  if (!d) return null;
  const x = d instanceof Date ? d : new Date(d);
  return Number.isNaN(x.getTime()) ? null : x.toISOString();
}

module.exports = { collect, STEPS, SCHEMA_VERSION };
