'use strict';

/**
 * Turns every way a collection can fail into a clear, specific explanation
 * for the person running the demo:
 *
 *   { code, title, message, hint, source, details? }
 *
 *   code     stable machine-readable id (e.g. 'page-not-available')
 *   title    one-line headline shown in the UI
 *   message  what happened, in plain language
 *   hint     what the user can do about it
 *   source   who reported it: 'input' | 'apify' | 'facebook' | 'app'
 *   details  optional exact text from Facebook / Apify (shown verbatim)
 */

class CollectError extends Error {
  constructor(reason, { cause } = {}) {
    super(reason.message);
    this.name = 'CollectError';
    this.reason = reason;
    if (cause) this.cause = cause;
  }
}

/** Error codes the actor puts in dataset items, mapped to explanations. */
const ACTOR_ERRORS = {
  not_available: {
    code: 'page-not-available',
    title: 'Facebook says this page is not available',
    message: 'Facebook did not show any public content for this URL. The page may not exist, may have been deleted ' +
      'or renamed, or its owner limits who can see it (private profile, private group, or an age/country-restricted page).',
    hint: 'Open the URL in a private/incognito browser window without logging in. If you cannot see posts there, ' +
      'it cannot be collected. Check the spelling of the page name.',
  },
  no_items: {
    code: 'no-posts',
    title: 'The page has no public posts',
    message: 'The page was found, but Facebook returned no public posts for it.',
    hint: 'Try a page that posts publicly, or check the page in a logged-out browser window.',
  },
};

/** Explanation for the input step (bad URL format etc.). */
function inputReason(err) {
  return {
    code: 'invalid-page-url',
    title: 'This is not a Facebook page URL we can collect',
    message: err.message,
    hint: 'Enter a public Facebook page, e.g. https://www.facebook.com/IndianCricketTeam or just the page name.',
    source: 'input',
  };
}

/** Explanation for an error thrown by apify-client (starting/polling the run). */
function apifyApiReason(err) {
  const type = err?.type || '';
  const status = err?.statusCode;
  const raw = err?.message || String(err);
  const base = { source: 'apify', details: raw };
  if (status === 401 || type === 'user-or-token-not-found' || type === 'token-not-valid') {
    return { ...base, code: 'apify-token-invalid', title: 'The Apify API token was rejected',
      message: 'Apify did not accept the APIFY_TOKEN configured on the server.',
      hint: 'Create a new token in Apify Console → Settings → API & Integrations and update .env.' };
  }
  if (/usage|credit|limit|insufficient|payment/i.test(type + ' ' + raw) && (status === 402 || status === 403 || /usage|credit/i.test(type))) {
    return { ...base, code: 'apify-out-of-credit', title: 'The Apify account has run out of credit',
      message: 'Apify refused to start the run because the account has reached its usage limit.',
      hint: 'Add credit or upgrade the plan in Apify Console → Billing, or wait for the monthly limit to reset.' };
  }
  if (status === 429 || type === 'rate-limit-exceeded') {
    return { ...base, code: 'apify-rate-limited', title: 'Apify is rate-limiting requests',
      message: 'Too many requests were sent to Apify in a short time.',
      hint: 'Wait a minute and try again.' };
  }
  if (!status && /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|network/i.test(raw + ' ' + (err?.cause?.code || ''))) {
    return { ...base, code: 'apify-unreachable', title: 'Could not reach Apify',
      message: 'The server could not connect to api.apify.com.',
      hint: 'Check the server\'s internet connection and try again.' };
  }
  return { ...base, code: 'apify-error', title: 'Apify returned an error',
    message: `Apify reported: ${raw}`,
    hint: 'Try again. If it keeps failing, check the run in the Apify Console.' };
}

/** Explanation for a run that finished with a non-success status. */
function runStatusReason(run) {
  const msg = run.statusMessage || null;
  const map = {
    'TIMED-OUT': { code: 'apify-run-timed-out', title: 'The Apify run timed out',
      message: 'The scraper did not finish within its time limit.', hint: 'Try again with fewer posts.' },
    ABORTED: { code: 'apify-run-aborted', title: 'The Apify run was aborted',
      message: 'The run was stopped before it finished (manually, or because the cost cap was reached).', hint: 'Try again.' },
    FAILED: { code: 'apify-run-failed', title: 'The Apify scraper failed',
      message: 'The scraper crashed or could not load Facebook.', hint: 'Try again in a few minutes. Facebook sometimes blocks requests temporarily.' },
  };
  const r = map[run.status] || { code: 'apify-run-failed', title: `The Apify run ended with status ${run.status}`, message: 'The run did not succeed.', hint: 'Try again.' };
  return { ...r, source: 'apify', details: msg, runId: run.id };
}

/**
 * Explanation when the run succeeded but produced no usable posts.
 * items: raw dataset items; skipped: from normaliseItems().
 */
function noPostsReason(items, skipped) {
  const errorItems = items.filter((i) => i && typeof i === 'object' && (i.error || i.errorDescription));
  if (errorItems.length) {
    const first = errorItems[0];
    const known = ACTOR_ERRORS[first.error];
    const details = first.errorDescription || first.error;
    if (known) return { ...known, source: 'facebook', details, actorError: first.error };
    return {
      code: 'scraper-error',
      title: 'The scraper could not read this page',
      message: `The scraper reported "${first.error || 'error'}" for this URL.`,
      hint: 'Check the page in a logged-out browser window, then try again.',
      source: 'facebook', details, actorError: first.error || null,
    };
  }
  if (items.length === 0) return { ...ACTOR_ERRORS.no_items, source: 'facebook' };
  return {
    code: 'no-usable-posts',
    title: 'No usable posts in the result',
    message: `Apify returned ${items.length} item(s), but none of them were posts with an ID or URL.`,
    hint: 'This may be a profile or page type the scraper does not support. Try another page.',
    source: 'app',
    details: skipped.map((s) => s.reason).slice(0, 3).join('; ') || null,
  };
}

/** Best-effort explanation for anything else. */
function toReason(err) {
  if (err instanceof CollectError) return err.reason;
  if (err?.name === 'ConfigError') return inputReason(err);
  if (err?.name === 'ApifyApiError' || typeof err?.statusCode === 'number' || err?.type) return apifyApiReason(err);
  return { code: 'app-error', title: 'Something went wrong', message: err?.message || String(err), hint: 'Try again.', source: 'app' };
}

module.exports = { CollectError, ACTOR_ERRORS, inputReason, apifyApiReason, runStatusReason, noPostsReason, toReason };
