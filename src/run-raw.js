'use strict';

/**
 * Step 4 exploration script: run the actor for one authorised page with a small
 * limit and print the raw dataset items, so we can see the real fields.
 *
 *   npm run raw -- [pageUrl] [count]     (defaults: DEFAULT_PAGE_URL, 3)
 *
 * Raw items are also saved to output/_raw/ (git-ignored) so later steps can be
 * developed without paying for another run.
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, ConfigError } = require('./config');
const apify = require('./apify');

async function main() {
  const config = loadConfig();
  const [pageArg, countArg] = process.argv.slice(2);
  const page = config.resolvePage(pageArg || config.defaultPageUrl);
  const count = config.clampPostCount(countArg ?? 3);

  const client = apify.createClient(config);
  console.log(`Page   : ${page.url}`);
  console.log(`Posts  : ${count} (MAX_POSTS cap ${config.maxPosts ?? 'none'})`);

  const { run, capUsd, prices } = await apify.startRun(client, { pageUrl: page.url, postCount: count });
  if (prices) console.log(`Pricing: ${prices.tier} tier, $${prices.startUsd}/start + $${prices.perPostUsd}/post`);
  console.log(`Cost cap (maxTotalChargeUsd): ${capUsd != null ? '$' + capUsd : 'n/a'}`);
  console.log(`Run    : ${run.id} (dataset ${run.defaultDatasetId}) started`);

  const t0 = Date.now();
  const final = await apify.waitForRun(client, run.id, {
    onStatus: (r) => console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] status ${r.status}${r.statusMessage ? ' - ' + r.statusMessage : ''}`),
  });
  if (final.status !== 'SUCCEEDED') {
    console.error(`Run ended with status ${final.status}${final.statusMessage ? ': ' + final.statusMessage : ''}`);
  }

  const items = await apify.fetchItems(client, final.defaultDatasetId, count);
  console.log(`\nCost/usage: ${JSON.stringify(apify.runCost(final))}`);
  console.log(`\n=== ${items.length} raw dataset item(s) ===`);
  console.log(JSON.stringify(items, null, 2));

  const dir = path.join(config.outputDir, '_raw');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${page.key}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ runId: final.id, datasetId: final.defaultDatasetId, run: {
    status: final.status, startedAt: final.startedAt, finishedAt: final.finishedAt, ...apify.runCost(final),
  }, items }, null, 2));
  console.log(`\nSaved raw items to ${path.relative(config.projectRoot, file)}`);
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? err.message : `Failed: ${err?.message ?? err}`);
  process.exitCode = 1;
});
