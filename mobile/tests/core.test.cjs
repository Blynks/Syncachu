const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BLOCK_SIZE, MAX_SIZE, blockId, planBlocks, canUpload, sameContent, mergeQueue, checkCancelled, trustedBlobUrl, privateApiUrl } = require('../.test-build/core.js');

test('block boundaries use equal-width stable base64 IDs and exact byte counts', () => {
  for (const size of [1, BLOCK_SIZE - 1, BLOCK_SIZE, BLOCK_SIZE + 1, MAX_SIZE]) {
    const blocks = planBlocks(size);
    assert.equal(blocks.reduce((sum, block) => sum + block.size, 0), size);
    blocks.forEach((block, index) => {
      assert.equal(block.offset, BLOCK_SIZE * index);
      assert.equal(Buffer.from(block.id, 'base64').toString(), String(index).padStart(8, '0'));
      assert.equal(block.id.length, 12);
    });
  }
  for (const size of [0, -1, 1.5, MAX_SIZE + 1, NaN]) assert.throws(() => planBlocks(size));
  assert.throws(() => blockId(-1));
});
test('resuming skips only acknowledged blocks and preserves the full commit list', () => {
  const before = planBlocks(BLOCK_SIZE * 3 + 17);
  const resumed = planBlocks(BLOCK_SIZE * 3 + 17, [0, 2]);
  assert.deepEqual(resumed.filter(block => !block.done).map(block => block.index), [1, 3]);
  assert.deepEqual(before.map(block => block.id), resumed.map(block => block.id));
});
test('manual and automatic uploads require active app, connectivity and approved network', () => {
  const good = { connected: true, reachable: true, active: true, wifi: true, allowMobile: false };
  assert.equal(canUpload(good), true);
  for (const field of ['connected', 'reachable', 'active', 'wifi']) assert.equal(canUpload({ ...good, [field]: false }), false);
  assert.equal(canUpload({ ...good, wifi: false, allowMobile: true }), true);
  assert.equal(canUpload({ ...good, active: false, allowMobile: true }), false);
});
test('byte digest or size changes invalidate resume checkpoint', () => {
  const item = { sha256: 'a'.repeat(64), size: 42 };
  assert.equal(sameContent(item, 'a'.repeat(64), 42), true);
  assert.equal(sameContent(item, 'b'.repeat(64), 42), false);
  assert.equal(sameContent(item, 'a'.repeat(64), 43), false);
});
test('queue deduplicates library scans, preserves cancelled/done items and notices edits', () => {
  const item = { key: 'asset:1', revision: 1, status: 'done', blocks: [] };
  const queued = { ...item, status: 'queued' };
  assert.deepEqual(mergeQueue([item], [queued, queued]), [item]);
  const cancelled = { ...item, status: 'cancelled' };
  assert.deepEqual(mergeQueue([cancelled], [queued]), [cancelled]);
  const edited = { ...queued, revision: 2 };
  assert.deepEqual(mergeQueue([item], [edited]), [edited]);
});
test('cancellation blocks stale work', () => {
  const controller = new AbortController();
  assert.doesNotThrow(() => checkCancelled(controller.signal));
  controller.abort();
  assert.throws(() => checkCancelled(controller.signal), /Cancelled/);
});
test('SAS upload is restricted to exact HTTPS Azure account host', () => {
  const host = 'mystorage.blob.core.windows.net';
  assert.equal(trustedBlobUrl(`https://${host}/private/blob?sig=test`, host).hostname, host);
  for (const url of [
    `http://${host}/blob?sig=test`, `https://${host}.evil.com/blob?sig=test`,
    'https://other.blob.core.windows.net/blob?sig=test',
    `https://${host}:8443/blob?sig=test`,
    `https://${host}/blob`, `https://${host}/blob?sig=test#fragment`,
  ]) assert.throws(() => trustedBlobUrl(url, host));
});
test('Google ID token is only attached to URLs inside the API origin and path', () => {
  const base = 'https://api.example.com/api';
  assert.equal(privateApiUrl('media', base), `${base}/media`);
  assert.equal(privateApiUrl('/api/media/a/thumbnail', base), `${base}/media/a/thumbnail`);
  for (const url of ['https://evil.com/api/media', '//evil.com/api/media', '/outside', '../secret', 'https://api.example.com/api-evil/media']) {
    assert.throws(() => privateApiUrl(url, base));
  }
});
test('private SAS gallery previews never receive Google authorization', () => {
  const host = 'mystorage.blob.core.windows.net';
  const sas = `https://${host}/private/thumbnail?sig=test`;
  assert.equal(trustedBlobUrl(sas, host).toString(), sas);
  assert.throws(() => trustedBlobUrl('https://api.example.com/api/media/thumbnail', host));
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../App.tsx'), 'utf8');
  const component = source.slice(source.indexOf('function Thumbnail('), source.indexOf('function Library('));
  assert.match(component, /trustedBlobUrl\(item\.thumbnailUrl!, BLOB_HOST\)/);
  assert.doesNotMatch(component, /Authorization|api\.token|GoogleSignin/);
  assert.match(component, /credentials: 'omit'/);
  assert.match(component, /redirect: 'error'/);
});
