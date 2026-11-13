'use strict';

/**
 * CLI: collect posts for one public Facebook page.
 *
 *   npm run collect -- [pageUrl] [count]     (defaults: DEFAULT_PAGE_URL, 3)
 */

const { loadConfig, ConfigError } = require('./config');
const { collect } = require('./pipeline');

async function main() {
  const config = loadConfig();
  const [pageArg, countArg] = process.argv.slice(2);
  const t0 = Date.now();
  const secs = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
  await collect({
    config,
    pageInput: pageArg || config.defaultPageUrl,
    count: countArg ?? 3,
    onEvent: (e) => {
      if (e.type === 'step') console.log(`${secs()}s  [${e.step}] ${e.status}${e.detail ? ' - ' + e.detail : ''}`);
      else if (e.type === 'log') console.log(`${secs()}s    ${e.level === 'info' ? '' : e.level.toUpperCase() + ': '}${e.message}`);
      else if (e.type === 'apify') console.log(`${secs()}s    Apify: ${e.status}${e.statusMessage ? ' - ' + e.statusMessage : ''}`);
      else if (e.type === 'done') console.log(`\n${e.verified ? 'Done and verified.' : 'Done, but verification FAILED.'} ${e.postsFile}`);
    },
  });
}

main().catch((err) => {
  if (err instanceof ConfigError) console.error(err.message);
  process.exitCode = 1;
});
