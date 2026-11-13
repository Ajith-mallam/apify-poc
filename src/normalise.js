'use strict';

/**
 * Normalise raw apify/facebook-posts-scraper dataset items into stable records.
 *
 * Field mapping (verified against real output, build 0.0.415):
 *   postId    <- postId
 *   pageName  <- user.name (display name), else pageName (string, or object .name)
 *   pageUrl   <- facebookUrl, else inputUrl
 *   postUrl   <- url (pfbid permalink), else topLevelUrl
 *   postedAt  <- time (ISO), else timestamp (unix seconds)
 *   text      <- text
 *   likes     <- likes (total reactions), comments <- comments, shares <- shares
 *   mediaType <- derived from media[].__typename (and isVideo === true)
 *   images    <- media[] entries with a __typename: photo_image.uri | image.uri | thumbnail
 *
 * Rules: missing or malformed values become null - nothing is guessed.
 * Deliberately NOT kept: topComments (commenters are private individuals),
 * user.profilePic, textReferences, collaborators, ad-library data.
 */

const FIELD_ORDER = [
  'postId', 'pageName', 'pageUrl', 'postUrl', 'postedAt', 'text',
  'likes', 'comments', 'shares', 'mediaType', 'images', 'collectedAt',
];

function str(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function count(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null;
}

function httpsUrl(v) {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function isoDate(time, timestamp) {
  if (typeof time === 'string') {
    const d = new Date(time);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0) {
    // Unix seconds (the actor's format). Values that look like milliseconds are accepted too.
    const ms = timestamp > 1e12 ? timestamp : timestamp * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function pageNameOf(item) {
  const fromUser = str(item?.user?.name);
  if (fromUser) return fromUser;
  if (typeof item?.pageName === 'string') return str(item.pageName);
  return str(item?.pageName?.name);
}

/** Media entries without __typename (e.g. a link back to the post itself) are not media. */
function mediaEntries(item) {
  if (!Array.isArray(item?.media)) return null;
  return item.media.filter((m) => m && typeof m === 'object' && str(m.__typename));
}

function mediaTypeOf(item, entries) {
  if (entries === null) return item?.isVideo === true ? 'video' : null;
  const types = entries.map((m) => m.__typename.toLowerCase());
  const photos = types.filter((t) => t === 'photo').length;
  const videos = types.filter((t) => t === 'video').length;
  if (types.length === 0) return item?.isVideo === true ? 'video' : 'none';
  if (videos > 0 && photos > 0) return 'mixed';
  if (videos > 0) return 'video';
  if (photos === 1 && types.length === 1) return 'photo';
  if (photos === types.length) return 'album';
  // Unknown typename(s): report what the actor said rather than guessing.
  return [...new Set(types)].join('+');
}

function imagesOf(entries) {
  if (!entries) return [];
  const out = [];
  const seen = new Set();
  for (const m of entries) {
    const img = (m.photo_image && typeof m.photo_image === 'object' ? m.photo_image : null)
      || (m.image && typeof m.image === 'object' ? m.image : null);
    const url = httpsUrl(img?.uri) || httpsUrl(m.thumbnail);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      index: out.length,
      kind: m.__typename.toLowerCase() === 'video' ? 'video-thumbnail' : 'photo',
      remoteUrl: url,
      width: count(img?.width),
      height: count(img?.height),
    });
  }
  return out;
}

/** Normalise one raw item. Returns null for items that are not posts (e.g. actor error items). */
function normaliseItem(item, { collectedAt }) {
  if (!item || typeof item !== 'object' || item.error || item.errorDescription) return null;
  const entries = mediaEntries(item);
  const rec = {
    postId: str(item.postId) ?? (typeof item.postId === 'number' ? String(item.postId) : null),
    pageName: pageNameOf(item),
    pageUrl: httpsUrl(item.facebookUrl) ?? httpsUrl(item.inputUrl),
    postUrl: httpsUrl(item.url) ?? httpsUrl(item.topLevelUrl),
    postedAt: isoDate(item.time, item.timestamp),
    text: typeof item.text === 'string' ? item.text : null,
    likes: count(item.likes),
    comments: count(item.comments),
    shares: count(item.shares),
    mediaType: mediaTypeOf(item, entries),
    images: imagesOf(entries),
    collectedAt,
  };
  // Fixed key order for stable output.
  return Object.fromEntries(FIELD_ORDER.map((k) => [k, rec[k]]));
}

/**
 * Normalise a list of raw items.
 * Returns { posts, skipped: [{ index, reason }] }. Duplicate postIds are kept once.
 */
function normaliseItems(items, { collectedAt = new Date().toISOString() } = {}) {
  const posts = [];
  const skipped = [];
  const ids = new Set();
  (Array.isArray(items) ? items : []).forEach((item, index) => {
    const rec = normaliseItem(item, { collectedAt });
    if (!rec) {
      const reason = item?.error || item?.errorDescription || 'not a post object';
      skipped.push({ index, reason: String(reason).slice(0, 200) });
      return;
    }
    if (!rec.postId && !rec.postUrl) {
      skipped.push({ index, reason: 'no postId and no postUrl' });
      return;
    }
    const key = rec.postId ?? rec.postUrl;
    if (ids.has(key)) {
      skipped.push({ index, reason: `duplicate post ${key}` });
      return;
    }
    ids.add(key);
    posts.push(rec);
  });
  return { posts, skipped };
}

module.exports = { normaliseItem, normaliseItems, FIELD_ORDER };

// `node src/normalise.js output/_raw/<file>.json` - print normalised records.
if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node src/normalise.js <raw items json>');
    process.exit(1);
  }
  const data = JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
  const result = normaliseItems(Array.isArray(data) ? data : data.items);
  console.log(JSON.stringify(result, null, 2));
}
