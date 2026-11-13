'use strict';

/**
 * Thin wrapper around apify-client for apify/facebook-posts-scraper.
 *
 * Input schema (verified against build 0.0.415, 2026-11-10):
 *   startUrls       array<{url}>  required
 *   resultsLimit    integer >= 1  posts per page
 *   captionText     boolean       video transcripts (we leave it off)
 *   onlyPostsNewerThan / onlyPostsOlderThan  (date filter = extra paid add-on; not used)
 *
 * Pricing is pay-per-event (actor-start + per post). Every run is started with
 * a maxTotalChargeUsd cap derived from the actor's own pricing table, so the
 * cost can never exceed the expected amount for the requested post count.
 * Default actor settings are used otherwise (no custom proxies, no cookies).
 */

const { ApifyClient } = require('apify-client');

const ACTOR_ID = 'apify/facebook-posts-scraper';
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

function createClient(config) {
  return new ApifyClient({ token: config.getApifyToken() });
}

/** Look up per-event prices for the account's plan tier (falls back to the highest tier price). */
async function getEventPrices(client) {
  const [actor, me] = await Promise.all([client.actor(ACTOR_ID).get(), client.user('me').get()]);
  const infos = actor?.pricingInfos || [];
  const current = infos[infos.length - 1];
  const events = current?.pricingPerEvent?.actorChargeEvents;
  if (current?.pricingModel !== 'PAY_PER_EVENT' || !events) return null;
  const tier = me?.plan?.id || 'FREE';
  const price = (ev) => {
    if (!ev) return 0;
    if (typeof ev.eventPriceUsd === 'number') return ev.eventPriceUsd;
    const tiers = ev.eventTieredPricingUsd || {};
    if (tiers[tier]) return tiers[tier].tieredEventPriceUsd;
    return Math.max(0, ...Object.values(tiers).map((t) => t.tieredEventPriceUsd || 0));
  };
  return {
    tier,
    startUsd: price(events['actor-start']),
    perPostUsd: price(events.post),
    minimalMaxTotalChargeUsd: current.minimalMaxTotalChargeUsd ?? 0,
  };
}

/** Expected maximum cost for N posts, used as the hard run cap. */
function costCapUsd(prices, posts) {
  if (!prices) return null;
  const expected = prices.startUsd + prices.perPostUsd * posts;
  // Round up to the next 0.001 and respect the actor's minimum.
  return Math.max(prices.minimalMaxTotalChargeUsd, Math.ceil(expected * 1000 + 1e-9) / 1000);
}

/**
 * Start a run (does not wait). Returns { run, capUsd, prices }.
 * pageUrl must already be allowlist-checked; postCount already clamped.
 */
async function startRun(client, { pageUrl, postCount }) {
  const prices = await getEventPrices(client).catch(() => null);
  const capUsd = costCapUsd(prices, postCount);
  const input = { startUrls: [{ url: pageUrl }], resultsLimit: postCount };
  const options = {};
  if (capUsd != null) options.maxTotalChargeUsd = capUsd;
  const run = await client.actor(ACTOR_ID).start(input, options);
  return { run, capUsd, prices };
}

/**
 * Poll a run until it finishes, calling onStatus(run) whenever status changes
 * (and periodically). Returns the final run object.
 */
async function waitForRun(client, runId, { onStatus, pollSecs = 5, timeoutSecs = 600 } = {}) {
  const started = Date.now();
  let lastStatus = null;
  for (;;) {
    const run = await client.run(runId).waitForFinish({ waitSecs: pollSecs });
    if (onStatus && (run.status !== lastStatus || !TERMINAL.has(run.status))) onStatus(run);
    lastStatus = run.status;
    if (TERMINAL.has(run.status)) return run;
    if ((Date.now() - started) / 1000 > timeoutSecs) {
      throw new Error(`Run ${runId} did not finish within ${timeoutSecs}s (status ${run.status}).`);
    }
  }
}

/** One status check; waits up to waitSecs for the run to finish (long poll). */
async function pollRun(client, runId, waitSecs = 10) {
  const run = await client.run(runId).waitForFinish({ waitSecs });
  if (!run) throw Object.assign(new Error(`Apify run ${runId} not found`), { statusCode: 404 });
  return run;
}

const isTerminal = (status) => TERMINAL.has(status);

/** Fetch all items of the run's default dataset (capped at `limit`). */
async function fetchItems(client, datasetId, limit) {
  const { items } = await client.dataset(datasetId).listItems({ limit });
  return items;
}

/** Cost implied by the run's charged event counts and the actor's price table. */
function computedCostUsd(run, prices) {
  const c = run?.chargedEventCounts;
  if (!prices || !c) return null;
  const v = (c['actor-start'] ?? 0) * prices.startUsd + (c.post ?? 0) * prices.perPostUsd;
  return Math.round(v * 1e6) / 1e6;
}

/**
 * Charges are recorded after a run finishes, in two stages (observed):
 * chargedEventCounts settle first, usageTotalUsd a few seconds later.
 * Re-read the run until post charges reach `expectedPosts` AND usageTotalUsd
 * has caught up with the cost implied by those counts, or `maxWaitMs` passes.
 */
async function settleRun(client, runId, expectedPosts, prices, { maxWaitMs = 30_000, intervalMs = 2_000, minUsd = 0 } = {}) {
  const deadline = Date.now() + maxWaitMs;
  const settled = (run) => {
    if ((run?.chargedEventCounts?.post ?? 0) < expectedPosts) return false;
    // Also wait for a known minimum charge (e.g. the run-start fee) to appear.
    if (minUsd > 0 && !((run?.usageTotalUsd ?? 0) + 1e-6 >= minUsd)) return false;
    const expected = computedCostUsd(run, prices);
    if (expected == null) return typeof run?.usageTotalUsd === 'number' && run.usageTotalUsd > 0;
    return typeof run?.usageTotalUsd === 'number' && run.usageTotalUsd + 1e-6 >= expected;
  };
  let run = await client.run(runId).get();
  while (!settled(run) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    run = await client.run(runId).get();
  }
  return { run, settled: settled(run) };
}

/** Cost/usage fields from a finished run, when the API provides them. */
function runCost(run, prices, settled) {
  return {
    usageTotalUsd: typeof run?.usageTotalUsd === 'number' ? run.usageTotalUsd : null,
    computedCostUsd: computedCostUsd(run, prices),
    costSettled: settled ?? null,
    chargedEventCounts: run?.chargedEventCounts ?? null,
    maxTotalChargeUsd: run?.options?.maxTotalChargeUsd ?? null,
  };
}

module.exports = { ACTOR_ID, createClient, getEventPrices, costCapUsd, startRun, waitForRun, pollRun, isTerminal, fetchItems, settleRun, runCost };
