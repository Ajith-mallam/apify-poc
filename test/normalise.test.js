'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normaliseItem, normaliseItems, FIELD_ORDER } = require('../src/normalise');

const AT = '2026-11-11T08:00:00.000Z';
const img = (n) => `https://scontent.xx.fbcdn.net/v/${n}.jpg?oe=1`;

// Synthetic item shaped like real actor output (build 0.0.415).
function sample(over = {}) {
  return {
    facebookUrl: 'https://www.facebook.com/ExamplePage',
    inputUrl: 'https://www.facebook.com/ExamplePage',
    postId: '111',
    pageName: 'ExamplePage',
    url: 'https://www.facebook.com/ExamplePage/posts/pfbid0abc',
    topLevelUrl: 'https://www.facebook.com/100/posts/111',
    time: '2026-11-11T05:03:23.000Z',
    timestamp: 1794373403,
    user: { id: '100', name: 'Example Page', profileUrl: 'https://www.facebook.com/100', profilePic: img('pp') },
    text: 'Hello 👋',
    likes: 10, comments: 2, shares: 1,
    media: [
      { url: 'https://www.facebook.com/ExamplePage/posts/pfbid0abc', mediaset_token: 'x' }, // not media
      { __typename: 'Photo', thumbnail: img('t1'), image: { uri: img('a'), width: 400, height: 500 } },
    ],
    topComments: [{ profileName: 'Private Person', text: 'hi' }],
    ...over,
  };
}

test('maps real-shaped item and fixes key order', () => {
  const r = normaliseItem(sample(), { collectedAt: AT });
  assert.deepEqual(Object.keys(r), FIELD_ORDER);
  assert.equal(r.postId, '111');
  assert.equal(r.pageName, 'Example Page');
  assert.equal(r.pageUrl, 'https://www.facebook.com/ExamplePage');
  assert.equal(r.postUrl, 'https://www.facebook.com/ExamplePage/posts/pfbid0abc');
  assert.equal(r.postedAt, '2026-11-11T05:03:23.000Z');
  assert.equal(r.text, 'Hello 👋');
  assert.deepEqual([r.likes, r.comments, r.shares], [10, 2, 1]);
  assert.equal(r.mediaType, 'photo');
  assert.deepEqual(r.images, [{ index: 0, kind: 'photo', remoteUrl: img('a'), width: 400, height: 500 }]);
  assert.equal(r.collectedAt, AT);
});

test('does not keep commenter data or profile pictures', () => {
  const s = JSON.stringify(normaliseItem(sample(), { collectedAt: AT }));
  assert.ok(!s.includes('Private Person'));
  assert.ok(!s.includes('topComments'));
  assert.ok(!s.includes(img('pp')));
});

test('photo_image layout and thumbnail fallback', () => {
  const r = normaliseItem(sample({ media: [
    { __typename: 'Photo', thumbnail: img('t'), photo_image: { uri: img('p'), width: 1, height: 2 } },
    { __typename: 'Photo', thumbnail: img('only-thumb') },
    { __typename: 'Photo', thumbnail: img('p') }, // duplicate URL dropped
  ] }), { collectedAt: AT });
  assert.equal(r.mediaType, 'album');
  assert.deepEqual(r.images.map((i) => i.remoteUrl), [img('p'), img('only-thumb')]);
  assert.equal(r.images[1].width, null);
});

test('media types: video, mixed, none, missing, unknown', () => {
  const t = (media, extra = {}) => normaliseItem(sample({ media, ...extra }), { collectedAt: AT }).mediaType;
  assert.equal(t([{ __typename: 'Video', thumbnail: img('v') }]), 'video');
  assert.equal(t([{ __typename: 'Video' }, { __typename: 'Photo' }]), 'mixed');
  assert.equal(t([]), 'none');
  assert.equal(t([{ url: 'x' }]), 'none');               // only non-media entries
  assert.equal(t(undefined), null);                        // media missing -> unknown, not "none"
  assert.equal(t(undefined, { isVideo: true }), 'video');
  assert.equal(t([{ __typename: 'Sticker' }]), 'sticker');
  const v = normaliseItem(sample({ media: [{ __typename: 'Video', thumbnail: img('v') }] }), { collectedAt: AT });
  assert.equal(v.images[0].kind, 'video-thumbnail');
});

test('missing values become null, never guessed', () => {
  const r = normaliseItem({ postId: '9' }, { collectedAt: AT });
  assert.deepEqual(r, {
    postId: '9', pageName: null, pageUrl: null, postUrl: null, postedAt: null, text: null,
    likes: null, comments: null, shares: null, mediaType: null, images: [], collectedAt: AT,
  });
});

test('malformed values become null', () => {
  const r = normaliseItem(sample({
    time: 'not a date', timestamp: 'x', likes: -5, comments: '12', shares: NaN, text: 42,
    url: 'javascript:alert(1)', topLevelUrl: 'http://insecure.example', facebookUrl: '', inputUrl: null,
    user: null, pageName: { name: '  ' },
    media: [{ __typename: 'Photo', thumbnail: 'http://not-https/x.jpg' }],
  }), { collectedAt: AT });
  assert.equal(r.postedAt, null);
  assert.equal(r.likes, null);
  assert.equal(r.comments, null);   // string "12" is not trusted as a number
  assert.equal(r.shares, null);
  assert.equal(r.text, null);
  assert.equal(r.postUrl, null);
  assert.equal(r.pageUrl, null);
  assert.equal(r.pageName, null);
  assert.deepEqual(r.images, []);
});

test('fallbacks: timestamp, topLevelUrl, inputUrl, pageName string/object', () => {
  const r = normaliseItem(sample({ time: undefined, url: undefined, facebookUrl: undefined, user: {} }), { collectedAt: AT });
  assert.equal(r.postedAt, '2026-11-11T05:03:23.000Z');
  assert.equal(r.postUrl, 'https://www.facebook.com/100/posts/111');
  assert.equal(r.pageUrl, 'https://www.facebook.com/ExamplePage');
  assert.equal(r.pageName, 'ExamplePage');
  const o = normaliseItem(sample({ user: undefined, pageName: { id: '1', name: 'Obj Name' } }), { collectedAt: AT });
  assert.equal(o.pageName, 'Obj Name');
});

test('empty text is kept as empty string (it is a real value)', () => {
  assert.equal(normaliseItem(sample({ text: '' }), { collectedAt: AT }).text, '');
});

test('normaliseItems skips error items, id-less items and duplicates', () => {
  const { posts, skipped } = normaliseItems([
    sample(),
    { url: 'https://www.facebook.com/x', error: 'Page not found' },
    sample(), // duplicate postId 111
    { text: 'no id or url' },
    null,
    sample({ postId: '222' }),
  ], { collectedAt: AT });
  assert.deepEqual(posts.map((p) => p.postId), ['111', '222']);
  assert.deepEqual(skipped.map((s) => s.index), [1, 2, 3, 4]);
  assert.match(skipped[0].reason, /Page not found/);
  assert.match(skipped[1].reason, /duplicate/);
});

test('numeric postId is stringified', () => {
  assert.equal(normaliseItem(sample({ postId: 123 }), { collectedAt: AT }).postId, '123');
});
