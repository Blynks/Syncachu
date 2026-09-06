const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encodeQueue, QUEUE_CHUNK_BYTES, QueueStorage } = require('../.test-build/queueStorage.js');
const { shouldSkipSelection } = require('../.test-build/core.js');

function createStorage() {
  const rows = new Map();
  return {
    rows,
    getItem: async key => rows.get(key) ?? null,
    setItem: async (key, value) => { rows.set(key, value); },
    getAllKeys: async () => [...rows.keys()],
    multiRemove: async keys => { keys.forEach(key => rows.delete(key)); },
  };
}
function snapshot(count) {
  return { auto: true, allowMobile: false, queue: Array.from({ length: count }, (_, index) => ({
    key: `asset:${index}`, name: '🌸'.repeat(30), contentType: 'image/jpeg',
    status: 'done', progress: 1, blocks: [],
  })) };
}
test('large Unicode library persists in bounded chunks rather than a 2MiB SQLite row', async () => {
  const storage = createStorage();
  const queue = snapshot(15000);
  assert.ok(Buffer.byteLength(JSON.stringify(queue)) > 2 * 1024 * 1024);
  const encoded = encodeQueue(queue);
  assert.ok(encoded.chunks.length > 1);
  for (const chunk of encoded.chunks) assert.ok(Buffer.byteLength(chunk) <= QUEUE_CHUNK_BYTES);
  const store = new QueueStorage(storage, 'user-a');
  await store.write(encoded);
  for (const value of storage.rows.values()) assert.ok(Buffer.byteLength(value) <= QUEUE_CHUNK_BYTES);
  assert.deepEqual(await store.read(), queue);
});
test('interrupted chunk writes retain prior complete generation; next save removes orphan chunks', async () => {
  const storage = createStorage();
  const store = new QueueStorage(storage, 'user-a');
  const original = snapshot(1);
  await store.write(encodeQueue(original));
  const write = storage.setItem;
  let writes = 0;
  storage.setItem = async (key, value) => {
    if (++writes === 2) throw new Error('disk interrupted');
    await write(key, value);
  };
  await assert.rejects(store.write(encodeQueue(snapshot(1000))), /interrupted/);
  assert.deepEqual(await store.read(), original);
  storage.setItem = write;
  await store.write(encodeQueue(snapshot(2)));
  assert.deepEqual(await store.read(), snapshot(2));
  assert.equal(storage.rows.size, 2);
});
test('queue generations and cleanup remain isolated between accounts', async () => {
  const storage = createStorage();
  const first = new QueueStorage(storage, 'user-a');
  const second = new QueueStorage(storage, 'user-b');
  await first.write(encodeQueue(snapshot(4)));
  await second.write(encodeQueue(snapshot(7)));
  await first.write(encodeQueue(snapshot(1)));
  assert.deepEqual(await second.read(), snapshot(7));
});
test('quota failure reclaims orphan chunks before retry while preserving published and other-account data', async () => {
  const storage = createStorage();
  const store = new QueueStorage(storage, 'user-a');
  const other = new QueueStorage(storage, 'user-b');
  const original = snapshot(1);
  await store.write(encodeQueue(original));
  await other.write(encodeQueue(snapshot(2)));
  const totalBytes = () => [...storage.rows.values()].reduce((sum, value) => sum + Buffer.byteLength(value), 0);
  const quota = totalBytes() + QUEUE_CHUNK_BYTES + 256;
  const write = storage.setItem;
  storage.setItem = async (key, value) => {
    const nextSize = totalBytes() - Buffer.byteLength(storage.rows.get(key) ?? '') + Buffer.byteLength(value);
    if (nextSize > quota) throw new Error('Storage quota exceeded');
    await write(key, value);
  };
  await assert.rejects(store.write(encodeQueue(snapshot(1000))), /quota exceeded/);
  assert.deepEqual(await store.read(), original);
  assert.ok(totalBytes() + Buffer.byteLength(encodeQueue(snapshot(50)).chunks[0]) > quota);
  await store.write(encodeQueue(snapshot(50)));
  assert.deepEqual(await store.read(), snapshot(50));
  assert.deepEqual(await other.read(), snapshot(2));
  assert.equal(storage.rows.size, 4);
});
test('legacy queue migrates only after new manifest publication', async () => {
  const storage = createStorage();
  const queue = snapshot(1);
  storage.rows.set('user-a', JSON.stringify(queue));
  const store = new QueueStorage(storage, 'user-a');
  assert.deepEqual(await store.read(), queue);
  await store.write(encodeQueue(queue));
  assert.equal(storage.rows.has('user-a'), false);
  assert.deepEqual(await store.read(), queue);
});
test('completed, failed and cancelled assets can be manually selected and rehashed again', () => {
  for (const status of ['done', 'error', 'cancelled']) assert.equal(shouldSkipSelection({ status }), false);
  for (const status of ['queued', 'working']) assert.equal(shouldSkipSelection({ status }), true);
  assert.equal(shouldSkipSelection(undefined), false);
});
