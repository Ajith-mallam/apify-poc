'use strict';
// Failure paths of the collection pipeline, with the Apify calls stubbed out.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const apify = require('../src/apify');
const { loadConfig } = require('../src/config');
const { collect } = require('../src/pipeline');
const { apifyApiReason } = require('../src/errors');

const FB_TEXT = "This content isn't available because the owner only shared it with a small group of people or changed who can see it, or it's been deleted.";
const original = { ...apify };
let root, config;

test.before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fbpoc-pipe-'));
  const base = loadConfig({ env: { APIFY_TOKEN: 'apify_api_PIPETEST', MAX_POSTS: '10' } });
  config = Object.create(base, { outputDir: { value: path.join(root, 'output') }, projectRoot: { value: root } });
});
test.after(() => { Object.assign(apify, original); fs.rmSync(root, { recursive: true, force: true }); });

/** Stub Apify so a run "finishes" with the given status and dataset items. */
function stub({ items = [], status = 'SUCCEEDED', statusMessage = 'Finished!', startError = null } = {}) {
  const calls = { start: 0 };
  Object.assign(apify, {
    createClient: () => ({}),
    startRun: async () => {
      calls.start++;
      if (startError) throw startError;
      return { run: { id: 'RUN1', status: 'READY' }, capUsd: 0.006, prices: { tier: 'FREE', startUsd: 0.001, perPostUsd: 0.005, minimalMaxTotalChargeUsd: 0 } };
    },
    waitForRun: async () => ({ id: 'RUN1', status, statusMessage, defaultDatasetId: 'DS1' }),
    fetchItems: async () => items,
    settleRun: async () => ({ run: { usageTotalUsd: 0.001, chargedEventCounts: { 'actor-start': 1 } }, settled: true }),
  });
  return calls;
}

async function run(pageInput) {
  const events = [];
  await assert.rejects(collect({ config, pageInput, count: 3, onEvent: (e) => events.push(e) }));
  return {
    events,
    reason: events.find((e) => e.type === 'failed').reason,
    errorStep: events.find((e) => e.type === 'step' && e.status === 'error')?.step,
  };
}

test('any page is accepted; Facebook "not available" is explained with its exact message', async () => {
  stub({ items: [{ url: 'https://www.facebook.com/nopage', error: 'not_available', errorDescription: FB_TEXT }] });
  const { reason, errorStep, events } = await run('https://www.facebook.com/nopage');
  assert.equal(errorStep, 'fetch');
  assert.equal(reason.code, 'page-not-available');
  assert.equal(reason.source, 'facebook');
  assert.equal(reason.details, FB_TEXT);
  assert.equal(reason.runId, 'RUN1');
  assert.ok(reason.hint);
  assert.ok(events.some((e) => e.type === 'summary' && e.costUsd === 0.001), 'reports the run-start charge');
  assert.ok(!fs.existsSync(config.outputDir), 'no run folder for a failed collection');
});

test('unknown actor error codes are shown verbatim', async () => {
  stub({ items: [{ url: 'x', error: 'login_required', errorDescription: 'You must log in to continue.' }] });
  const { reason } = await run('somepage');
  assert.equal(reason.code, 'scraper-error');
  assert.equal(reason.actorError, 'login_required');
  assert.equal(reason.details, 'You must log in to continue.');
});

test('empty dataset means no public posts', async () => {
  stub({ items: [] });
  const { reason } = await run('quietpage');
  assert.equal(reason.code, 'no-posts');
});

test('items that are not posts are explained', async () => {
  stub({ items: [{ foo: 1 }] });
  const { reason } = await run('oddpage');
  assert.equal(reason.code, 'no-usable-posts');
});

test('failed Apify run shows its status message', async () => {
  stub({ status: 'FAILED', statusMessage: 'Navigation timeout of 60000 ms exceeded' });
  const { reason, errorStep } = await run('somepage');
  assert.equal(errorStep, 'scrape');
  assert.equal(reason.code, 'apify-run-failed');
  assert.equal(reason.details, 'Navigation timeout of 60000 ms exceeded');
});

test('rejected token is explained at the Start step', async () => {
  const e = Object.assign(new Error('User was not found or authentication token is not valid'), { name: 'ApifyApiError', statusCode: 401, type: 'user-or-token-not-found' });
  stub({ startError: e });
  const { reason, errorStep } = await run('somepage');
  assert.equal(errorStep, 'start');
  assert.equal(reason.code, 'apify-token-invalid');
});

test('invalid URL fails in Validate without calling Apify', async () => {
  const calls = stub();
  const { reason, errorStep } = await run('https://www.facebook.com/groups/123');
  assert.equal(errorStep, 'validate');
  assert.equal(reason.code, 'invalid-page-url');
  assert.equal(calls.start, 0);
});

test('Apify API error classification', () => {
  assert.equal(apifyApiReason(Object.assign(new Error('By launching this job you will exceed the memory limit'), { statusCode: 402, type: 'not-enough-usage-to-run-paid-actor' })).code, 'apify-out-of-credit');
  assert.equal(apifyApiReason(Object.assign(new Error('Too many'), { statusCode: 429 })).code, 'apify-rate-limited');
  assert.equal(apifyApiReason(Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })).code, 'apify-unreachable');
  assert.equal(apifyApiReason(new Error('weird')).code, 'apify-error');
});
