'use strict';

/**
 * Stateless JSON API used by the web UI, both on Vercel (api/*.js) and by the
 * local server (src/server.js). No database and no disk: Apify keeps the run,
 * and the browser keeps the results (and can download them as a ZIP).
 *
 *   GET  /api/config                      UI settings (+ whether the access code is accepted)
 *   POST /api/start   {pageUrl, count}    validate the page, start the Apify run
 *   GET  /api/status  ?runId&pageUrl&count&ticket   long-poll the run status
 *   POST /api/result  {runId, pageUrl, count, ticket}   dataset -> normalised posts + content hashes
 *   GET  /api/image   ?u&s                proxy one Facebook CDN image (signed URL only)
 *
 * Security:
 *   - The Apify token never leaves the server and is scrubbed from every response.
 *   - Optional DEMO_ACCESS_CODE, sent by the browser in the X-Access-Code header.
 *   - Run tickets and image URLs are HMAC-signed with a key derived from the token,
 *     so the API can only read runs it started and can't be used as an open proxy.
 *   - POST needs a same-origin Origin header and JSON (blocks CSRF).
 *   - Every run is started with an Apify cost cap matching the requested post count.
 */

const crypto = require('node:crypto');
const { loadConfig } = require('../config');
const apify = require('../apify');
const store = require('../store');
const errors = require('../errors');
const { normaliseItems } = require('../normalise');
const { contentHash, CONTENT_SCHEME, CONTENT_FIELDS } = require('../hash');

const STEPS = ['validate', 'start', 'scrape', 'fetch', 'save', 'hash', 'verify'];
const ROUTES = new Set(['config', 'start', 'status', 'result', 'image']);
const MAX_BODY = 8 * 1024;
const MAX_PROXY_IMAGE_BYTES = 4 * 1024 * 1024; // Vercel's response limit is 4.5 MB
const SCHEMA_VERSION = 1;

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

let sharedConfig = null;

/**
 * @param {object} [opts]
 * @param {object} [opts.config]  config from loadConfig() (default: loaded from env once)
 * @param {number} [opts.pollWaitSecs=10]  how long /api/status waits for the run to finish
 */
function createApi({ config: givenConfig, pollWaitSecs = 10 } = {}) {
  const cfg = () => givenConfig || (sharedConfig ||= loadConfig());
  let signingKey = null;
  const key = () => (signingKey ||= crypto.createHmac('sha256', cfg().getApifyToken()).update('fbpoc-signing-v1').digest());
  const sign = (s) => crypto.createHmac('sha256', key()).update(s).digest('base64url');
  const signatureOk = (s, sig) => { // full-length signature check (run tickets)
    const a = Buffer.from(sign(s));
    const b = Buffer.from(String(sig || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const ticketFor = (runId, page, postCount) => sign(`run|${runId}|${page.key}|${postCount}`);
  const imageSig = (url) => sign(`img|${url}`).slice(0, 32);

  let pricing = null; // cached actor prices
  const getPricing = () => {
    if (!pricing) {
      pricing = apify.getEventPrices(apify.createClient(cfg())).catch(() => null);
      pricing.then((p) => { if (!p) pricing = null; });
    }
    return pricing;
  };

  function scrub(s) {
    const token = cfg().getApifyToken();
    return token && s.includes(token) ? s.split(token).join('[REDACTED]') : s;
  }
  function json(res, status, body) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(scrub(JSON.stringify(body)));
  }
  /** Explained failure: { error, reason, step }. */
  function fail(res, status, reason, step, extra = {}) {
    json(res, status, { error: reason.title, reason, step, ...extra });
  }

  async function readJson(req) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Expected application/json');
    // Vercel pre-parses JSON bodies into req.body; the local server streams them.
    if (req.body !== undefined && req.body !== null && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      if (JSON.stringify(req.body).length > MAX_BODY) throw new HttpError(413, 'Request body too large');
      return req.body;
    }
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
      chunks.push(c);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'Invalid JSON'); }
  }

  function query(req) {
    return Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  }

  function checkSameOrigin(req) {
    const origin = String(req.headers.origin || '');
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
    let ok = false;
    try { ok = Boolean(origin) && new URL(origin).host === host; } catch { ok = false; }
    if (!ok) throw new HttpError(403, 'Cross-origin request blocked');
  }

  async function checkAccess(req) {
    if (cfg().checkAccessCode(req.headers['x-access-code'])) return;
    await new Promise((r) => setTimeout(r, 400)); // slow down guessing
    throw new HttpError(401, 'Access code required', {
      reason: { code: 'access-code', title: 'Access code needed', message: 'This demo is protected with an access code.', hint: 'Enter the access code you were given.', source: 'app' },
    });
  }

  /** Verify a run ticket from the browser; returns { runId, page, postCount }. */
  function checkTicket(input) {
    const c = cfg();
    let page, postCount;
    try {
      page = c.resolvePage(input.pageUrl);
      postCount = c.clampPostCount(input.count);
    } catch { throw new HttpError(400, 'Invalid run reference'); }
    const runId = String(input.runId || '');
    if (!/^[A-Za-z0-9]{6,40}$/.test(runId) || !signatureOk(`run|${runId}|${page.key}|${postCount}`, input.ticket)) {
      throw new HttpError(403, 'Invalid run ticket');
    }
    return { runId, page, postCount };
  }

  /* ----------------------------- routes ----------------------------- */

  async function getConfig(req, res) {
    const c = cfg();
    const max = c.maxPosts;
    const opts = [1, 3, 5, 10, 20, 50, 100].filter((n) => !max || n < max);
    const granted = c.checkAccessCode(req.headers['x-access-code']);
    const p = granted ? await getPricing() : null;
    json(res, 200, {
      mode: 'live',
      hosted: Boolean(process.env.VERCEL),
      accessCodeRequired: c.accessCodeRequired,
      accessGranted: granted,
      defaultPageUrl: c.defaultPageUrl,
      defaultCount: max ? Math.min(3, max) : 3,
      examplePages: c.examplePages,
      maxPosts: max,
      postCountOptions: max ? [...opts, max] : opts,
      pricing: p ? { tier: p.tier, startUsd: p.startUsd, perPostUsd: p.perPostUsd } : null,
      steps: STEPS,
    });
  }

  async function start(req, res) {
    const body = await readJson(req);
    const c = cfg();
    let page, postCount;
    try {
      page = c.resolvePage(body.pageUrl);
      postCount = c.clampPostCount(body.count);
    } catch (e) {
      return fail(res, 400, errors.inputReason(e), 'validate');
    }
    let started;
    try {
      started = await apify.startRun(apify.createClient(c), { pageUrl: page.url, postCount });
    } catch (e) {
      return fail(res, 502, errors.apifyApiReason(e), 'start');
    }
    const { run, capUsd, prices } = started;
    json(res, 200, {
      runId: run.id,
      status: run.status,
      ticket: ticketFor(run.id, page, postCount),
      page,
      postCount,
      requested: Number(body.count),
      capUsd,
      prices: prices ? { tier: prices.tier, startUsd: prices.startUsd, perPostUsd: prices.perPostUsd } : null,
      actorId: apify.ACTOR_ID,
    });
  }

  async function status(req, res) {
    const { runId } = checkTicket(query(req));
    let run;
    try {
      run = await apify.pollRun(apify.createClient(cfg()), runId, pollWaitSecs);
    } catch (e) {
      return fail(res, 502, errors.apifyApiReason(e), 'scrape');
    }
    json(res, 200, { runId, status: run.status, statusMessage: run.statusMessage ?? null, finished: apify.isTerminal(run.status) });
  }

  async function result(req, res) {
    const body = await readJson(req);
    const { runId, page, postCount } = checkTicket(body);
    const client = apify.createClient(cfg());
    let run;
    try {
      run = await apify.pollRun(client, runId, 0);
    } catch (e) {
      return fail(res, 502, errors.apifyApiReason(e), 'fetch');
    }
    if (!apify.isTerminal(run.status)) throw new HttpError(409, 'The Apify run is still running');
    const prices = await getPricing();

    if (run.status !== 'SUCCEEDED') {
      const cost = await costOf(client, run, 0, prices);
      return fail(res, 422, errors.runStatusReason(run), 'scrape', { cost });
    }

    let items;
    try {
      items = await apify.fetchItems(client, run.defaultDatasetId, postCount);
    } catch (e) {
      return fail(res, 502, errors.apifyApiReason(e), 'fetch');
    }
    const collectedAt = new Date().toISOString();
    const { posts, skipped } = normaliseItems(items, { collectedAt });
    if (posts.length === 0) {
      const cost = await costOf(client, run, 0, prices);
      return fail(res, 422, { ...errors.noPostsReason(items, skipped), runId }, 'fetch', { cost, items: items.length });
    }

    posts.forEach((post, pi) => {
      post.contentSha256 = contentHash(post);
      for (const img of post.images) {
        img.fileStem = `images/${store.imageBaseName(post, pi, img.index)}`;
        img.proxyUrl = `/api/image?u=${encodeURIComponent(img.remoteUrl)}&s=${imageSig(img.remoteUrl)}`;
      }
    });
    const cost = await costOf(client, run, posts.length, prices);
    const doc = {
      schemaVersion: SCHEMA_VERSION,
      page: { key: page.key, url: page.url },
      requestedPosts: postCount,
      collectedAt,
      apify: {
        actorId: apify.ACTOR_ID,
        runId: run.id,
        datasetId: run.defaultDatasetId,
        status: run.status,
        statusMessage: run.statusMessage ?? null,
        startedAt: toIso(run.startedAt),
        finishedAt: toIso(run.finishedAt),
        ...cost,
      },
      hashing: {
        contentScheme: CONTENT_SCHEME,
        contentFields: CONTENT_FIELDS,
        stringNormalization: 'NFC',
        contentHash: 'SHA-256 of UTF-8 JSON [scheme, ...contentFields]',
        imageHash: 'SHA-256 of the image file bytes',
      },
      counts: { items: items.length, posts: posts.length, skipped: skipped.length },
      skipped,
      posts,
    };
    json(res, 200, { doc });
  }

  async function costOf(client, run, posts, prices) {
    try {
      const { run: r, settled } = await apify.settleRun(client, run.id, posts, prices, {
        maxWaitMs: 20_000, minUsd: prices?.startUsd ?? 0,
      });
      return apify.runCost(r, prices, settled);
    } catch {
      return { usageTotalUsd: null, computedCostUsd: null, costSettled: false, chargedEventCounts: null, maxTotalChargeUsd: null };
    }
  }

  async function image(req, res) {
    const { u, s } = query(req);
    const expected = u ? Buffer.from(imageSig(u)) : Buffer.alloc(0);
    const given = Buffer.from(String(s || ''));
    if (!u || expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
      throw new HttpError(403, 'Invalid image signature');
    }
    let img;
    try {
      img = await store.fetchImage(u, { maxBytes: MAX_PROXY_IMAGE_BYTES });
    } catch (e) {
      const reason = e?.name === 'TimeoutError' ? 'timed out' : String(e?.message || e).slice(0, 200);
      throw new HttpError(502, `Image could not be downloaded: ${reason}`);
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', img.contentType);
    res.setHeader('Content-Length', String(img.buffer.length));
    res.setHeader('X-Content-SHA256', crypto.createHash('sha256').update(img.buffer).digest('hex'));
    res.setHeader('X-Image-Ext', img.ext);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(img.buffer);
  }

  /** Entry point: handle(route, req, res). */
  return async function handle(route, req, res) {
    try {
      if (!ROUTES.has(route)) throw new HttpError(404, 'Not found');
      const method = req.method;
      const post = route === 'start' || route === 'result';
      if (post ? method !== 'POST' : method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      if (post) checkSameOrigin(req);
      if (route === 'config') return await getConfig(req, res);
      await checkAccess(req);
      if (route === 'start') return await start(req, res);
      if (route === 'status') return await status(req, res);
      if (route === 'result') return await result(req, res);
      return await image(req, res);
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      if (err instanceof HttpError) return json(res, err.status, { error: err.message, ...err.extra });
      if (err?.name === 'ConfigError') {
        // Server misconfiguration (e.g. missing APIFY_TOKEN on Vercel). Messages never contain the token.
        return json(res, 500, { error: 'Server configuration problem', reason: { code: 'server-config', title: 'The server is not configured correctly', message: err.message, hint: 'Set the environment variables (APIFY_TOKEN etc.) in the Vercel project settings and redeploy.', source: 'app' } });
      }
      console.error(`[api:${route}] ${scrub(err?.stack || String(err))}`);
      return json(res, 500, { error: 'Internal error' });
    }
  };
}

function toIso(d) {
  if (!d) return null;
  const x = d instanceof Date ? d : new Date(d);
  return Number.isNaN(x.getTime()) ? null : x.toISOString();
}

module.exports = { createApi, ROUTES, STEPS };
