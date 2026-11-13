'use strict';

/**
 * Configuration loader.
 *
 * - Loads .env from the project root with Node's built-in process.loadEnvFile.
 * - Validates that APIFY_TOKEN is present. The token is never printed, never
 *   included in JSON.stringify / console.log / util.inspect output of the config.
 * - Normalises Facebook page URLs / usernames to a canonical form.
 * - Any valid public Facebook page URL can be collected. EXAMPLE_PAGES (optional,
 *   legacy name AUTHORIZED_PAGES) only provides suggestion chips in the UI.
 */

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const crypto = require('node:crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ENV_FILE = path.join(PROJECT_ROOT, '.env');

const DEFAULT_UI_PORT = 4321;

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

// Hosts we accept as Facebook.
const FACEBOOK_HOSTS = new Set([
  'facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com',
  'mbasic.facebook.com', 'business.facebook.com', 'fb.com', 'www.fb.com',
]);

// First path segments that are NOT pages (groups, personal-profile tools,
// individual posts, login, etc.). Anything here is rejected outright.
const NON_PAGE_SEGMENTS = new Set([
  'groups', 'events', 'watch', 'marketplace', 'gaming', 'login', 'login.php',
  'logout.php', 'share', 'sharer', 'sharer.php', 'story.php', 'photo.php',
  'photo', 'photos', 'permalink.php', 'hashtag', 'people', 'search', 'friends',
  'messages', 'notifications', 'settings', 'help', 'policies', 'privacy',
  'ads', 'reel', 'reels', 'stories', 'dialog', 'plugins', 'l.php', 'home.php',
  'pages', 'profile', 'me', 'video.php', 'videos', 'live', 'bookmarks',
  'saved', 'memories', 'fundraisers', 'jobs', 'business', 'checkpoint',
  'recover', 'r.php', 'sharer', 'media', 'notes', 'places', 'pg',
]);

// Tabs that may follow a page slug; we strip them (facebook.com/acme/posts -> acme).
const PAGE_TAB_SEGMENTS = new Set([
  'posts', 'about', 'photos', 'videos', 'reels', 'community', 'mentions',
  'reviews', 'events', 'followers', 'live_videos', 'photos_by', 'shop',
]);

// Facebook vanity usernames: letters, digits, periods (we also allow '-' and '_'
// for legacy page slugs). Must contain at least one letter or digit.
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Normalise a Facebook page reference to { key, url }.
 *   key - lowercase identifier used for allowlist matching and folder names
 *   url - canonical https://www.facebook.com/... URL passed to Apify
 * Throws ConfigError with a human-readable reason if it is not a page reference.
 */
function normalisePage(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new ConfigError('Page reference is empty.');
  }
  let raw = input.trim();

  // Bare username, e.g. "acmeofficial" or "@acmeofficial".
  if (!/[/:]/.test(raw)) {
    const slug = raw.replace(/^@/, '');
    return fromSlug(slug, input);
  }

  // Allow "facebook.com/acme" without a scheme.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = 'https://' + raw;

  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(`"${input}" is not a valid URL or page username.`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new ConfigError(`"${input}" must be an http(s) Facebook URL.`);
  }
  if (!FACEBOOK_HOSTS.has(u.hostname.toLowerCase())) {
    throw new ConfigError(`"${input}" is not a facebook.com URL.`);
  }
  if (u.username || u.password) {
    throw new ConfigError(`"${input}" must not contain credentials.`);
  }

  const segments = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  // Numeric page IDs: facebook.com/profile.php?id=123456 (used by many newer Pages).
  if (segments.length === 1 && segments[0].toLowerCase() === 'profile.php') {
    const id = u.searchParams.get('id');
    if (!id || !/^\d{5,20}$/.test(id)) {
      throw new ConfigError(`"${input}" has no valid numeric id.`);
    }
    return { key: `id-${id}`, url: `https://www.facebook.com/profile.php?id=${id}` };
  }

  // facebook.com/p/Acme-Name-100012345678 (another newer Page URL form).
  if (segments.length >= 2 && segments[0].toLowerCase() === 'p') {
    const slug = segments[1];
    if (!SLUG_RE.test(slug)) throw new ConfigError(`"${input}" is not a valid page URL.`);
    return { key: `p-${slug.toLowerCase()}`, url: `https://www.facebook.com/p/${slug}` };
  }

  if (segments.length === 0) {
    throw new ConfigError(`"${input}" does not point to a page.`);
  }
  if (NON_PAGE_SEGMENTS.has(segments[0].toLowerCase())) {
    throw new ConfigError(
      `"${input}" is not a Facebook Page URL (/${segments[0]}/... is not allowed). ` +
      'Only public Pages are supported: no groups, personal profiles, events or single posts.'
    );
  }
  if (segments.length > 2 || (segments.length === 2 && !PAGE_TAB_SEGMENTS.has(segments[1].toLowerCase()))) {
    throw new ConfigError(`"${input}" points inside a page, not to the page itself.`);
  }
  return fromSlug(segments[0], input);
}

function fromSlug(slug, original) {
  if (!SLUG_RE.test(slug) || NON_PAGE_SEGMENTS.has(slug.toLowerCase())) {
    throw new ConfigError(`"${original}" is not a valid Facebook page username.`);
  }
  return { key: slug.toLowerCase(), url: `https://www.facebook.com/${slug}` };
}

function parseIntStrict(name, value, fallback, min, max) {
  if (value === undefined || String(value).trim() === '') return fallback;
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) throw new ConfigError(`${name} must be a whole number (got "${s}").`);
  const n = Number(s);
  if (n < min || n > max) throw new ConfigError(`${name} must be between ${min} and ${max} (got ${n}).`);
  return n;
}

/**
 * Load and validate configuration.
 * @param {object} [opts]
 * @param {object} [opts.env]   Use this object instead of process.env + .env file (for tests).
 * @param {boolean} [opts.requireToken=true]
 */
function loadConfig(opts = {}) {
  let env = opts.env;
  if (!env) {
    if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
    env = process.env;
  }
  const requireToken = opts.requireToken !== false;
  const errors = [];

  // --- Token (presence only; value never echoed) ---
  const token = (env.APIFY_TOKEN || '').trim();
  if (requireToken) {
    if (!token) errors.push('APIFY_TOKEN is missing. Add it to .env (see .env.example).');
    else if (token === 'apify_api_replace_me') errors.push('APIFY_TOKEN still has the placeholder value from .env.example.');
    else if (/\s/.test(token)) errors.push('APIFY_TOKEN contains whitespace; check for a copy/paste error.');
  }

  // --- Optional access code for the hosted demo (secret; never echoed) ---
  const accessCode = (env.DEMO_ACCESS_CODE || '').trim();
  if (accessCode && accessCode.length < 6) errors.push('DEMO_ACCESS_CODE must be at least 6 characters (or leave it empty).');

  // --- Example pages (optional suggestions for the UI; not a restriction) ---
  const examples = new Map(); // key -> canonical url
  const rawPages = (env.EXAMPLE_PAGES ?? env.AUTHORIZED_PAGES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const p of rawPages) {
    try {
      const n = normalisePage(p);
      examples.set(n.key, n.url);
    } catch (e) {
      errors.push(`EXAMPLE_PAGES: ${e.message}`);
    }
  }

  // --- Numbers ---
  // MAX_POSTS is optional: empty/unset (or 0) means no app-side limit. Every
  // run still gets an Apify cost cap sized to the requested post count.
  let maxPosts = null;
  let uiPort = DEFAULT_UI_PORT;
  try {
    const m = parseIntStrict('MAX_POSTS', env.MAX_POSTS, null, 0, 1_000_000);
    maxPosts = m ? m : null;
  } catch (e) { errors.push(e.message); }
  try { uiPort = parseIntStrict('UI_PORT', env.UI_PORT, DEFAULT_UI_PORT, 1024, 65535); } catch (e) { errors.push(e.message); }

  // --- Default page (any valid page; prefilled in the UI) ---
  let defaultPage = null;
  const rawDefault = (env.DEFAULT_PAGE_URL || '').trim();
  if (rawDefault) {
    try {
      const n = normalisePage(rawDefault);
      defaultPage = examples.get(n.key) ?? n.url;
    } catch (e) {
      errors.push(`DEFAULT_PAGE_URL: ${e.message}`);
    }
  } else if (examples.size > 0) {
    defaultPage = examples.values().next().value;
  }

  if (errors.length) {
    throw new ConfigError('Configuration problems:\n  - ' + errors.join('\n  - '));
  }

  const config = {
    projectRoot: PROJECT_ROOT,
    outputDir: path.join(PROJECT_ROOT, 'output'),
    examplePages: [...examples.values()],
    defaultPageUrl: defaultPage,
    maxPosts,
    uiPort,
    hasToken: Boolean(token),
    accessCodeRequired: Boolean(accessCode),

    /** Validate and normalise a page URL/username. Returns { key, url } or throws ConfigError. */
    resolvePage(input) {
      return normalisePage(input);
    },

    /** Validate a requested post count; applies the MAX_POSTS cap only if one is configured. */
    clampPostCount(requested) {
      const n = Number(requested);
      if (!Number.isInteger(n) || n < 1) throw new ConfigError('Post count must be a whole number of at least 1.');
      return maxPosts ? Math.min(n, maxPosts) : n;
    },
  };

  // Token is reachable only through a non-enumerable getter, so it never shows
  // up in JSON.stringify(config), console.log(config), Object.keys(config) etc.
  Object.defineProperty(config, 'getApifyToken', {
    enumerable: false,
    value: () => token,
  });
  // Constant-time access-code check (always true when no code is configured).
  Object.defineProperty(config, 'checkAccessCode', {
    enumerable: false,
    value: (given) => {
      if (!accessCode) return true;
      const a = crypto.createHash('sha256').update(String(given ?? '')).digest();
      const b = crypto.createHash('sha256').update(accessCode).digest();
      return crypto.timingSafeEqual(a, b);
    },
  });
  Object.defineProperty(config, util.inspect.custom, {
    enumerable: false,
    value: () => ({ ...config, apifyToken: token ? '[REDACTED]' : '(missing)' }),
  });
  return Object.freeze(config);
}

module.exports = { loadConfig, normalisePage, ConfigError };

// `npm run check-config` prints a non-secret summary.
if (require.main === module) {
  try {
    const c = loadConfig();
    console.log('Configuration OK');
    console.log(`  APIFY_TOKEN      : present (value hidden)`);
    console.log(`  EXAMPLE_PAGES    : ${c.examplePages.length} (suggestions only; any public page can be collected)`);
    for (const p of c.examplePages) console.log(`                     - ${p}`);
    console.log(`  DEFAULT_PAGE_URL : ${c.defaultPageUrl ?? '(none)'}`);
    console.log(`  MAX_POSTS        : ${c.maxPosts ?? 'no limit'}`);
    console.log(`  UI_PORT          : ${c.uiPort}`);
    console.log(`  DEMO_ACCESS_CODE : ${c.accessCodeRequired ? 'set (value hidden)' : 'not set (anyone with the link can run collections)'}`);
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : e);
    process.exitCode = 1;
  }
}
