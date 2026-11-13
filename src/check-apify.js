'use strict';

/**
 * Apify connectivity test: confirms the token works and prints only
 * non-secret account details (username, plan, usage, remaining credit).
 * Read-only; does not start any actor runs or consume credits.
 *
 * Note: the user object returned by the API also contains secrets
 * (e.g. proxy password), so fields are picked explicitly - never dump it.
 */

const { ApifyClient } = require('apify-client');
const { loadConfig, ConfigError } = require('./config');

function usd(n) {
  return typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(2)}` : 'n/a';
}

async function getAccountSummary(client) {
  const me = await client.user('me').get();
  let limits = null;
  try {
    limits = await client.user('me').limits();
  } catch {
    // Not available for every token scope / plan; treat as optional.
  }
  const maxUsd = limits?.limits?.maxMonthlyUsageUsd;
  const usedUsd = limits?.current?.monthlyUsageUsd;
  return {
    username: me?.username ?? null,
    plan: me?.plan?.id ?? null,
    usageCycleStart: limits?.monthlyUsageCycle?.startAt ?? null,
    usageCycleEnd: limits?.monthlyUsageCycle?.endAt ?? null,
    monthlyLimitUsd: typeof maxUsd === 'number' ? maxUsd : null,
    monthlyUsedUsd: typeof usedUsd === 'number' ? usedUsd : null,
    remainingUsd: typeof maxUsd === 'number' && typeof usedUsd === 'number' ? maxUsd - usedUsd : null,
  };
}

async function main() {
  const config = loadConfig();
  const client = new ApifyClient({ token: config.getApifyToken() });
  const a = await getAccountSummary(client);
  console.log('Apify connection OK');
  console.log(`  Username        : ${a.username ?? 'n/a'}`);
  console.log(`  Plan            : ${a.plan ?? 'n/a'}`);
  if (a.usageCycleStart) {
    console.log(`  Usage cycle     : ${a.usageCycleStart.toISOString?.() ?? a.usageCycleStart} -> ${a.usageCycleEnd?.toISOString?.() ?? a.usageCycleEnd}`);
  }
  console.log(`  Monthly limit   : ${usd(a.monthlyLimitUsd)}`);
  console.log(`  Used this cycle : ${usd(a.monthlyUsedUsd)}`);
  console.log(`  Remaining credit: ${usd(a.remainingUsd)}`);
}

module.exports = { getAccountSummary };

if (require.main === module) {
  main().catch((err) => {
    if (err instanceof ConfigError) {
      console.error(err.message);
    } else if (err?.statusCode === 401 || err?.type === 'user-or-token-not-found') {
      console.error('Apify rejected the token (401). Check APIFY_TOKEN in .env.');
    } else {
      // Error messages from apify-client do not include the token; print message only.
      console.error('Apify connectivity test failed:', err?.message ?? err);
    }
    process.exitCode = 1;
  });
}
