const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { hashChunks, HASH_CHUNK_SIZE } = require('../.test-build/hash.js');

test('streaming SHA-256 hashes actual bytes with bounded reads', async () => {
  const bytes = new Uint8Array(HASH_CHUNK_SIZE * 5 + 37).map((_, i) => i % 251);
  let offset = 0;
  const requests = [];
  const progress = [];
  const actual = await hashChunks(bytes.length, length => {
    requests.push(length);
    const chunk = bytes.subarray(offset, offset + length);
    offset += length;
    return chunk;
  }, new AbortController().signal, ratio => progress.push(ratio));
  assert.equal(actual, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(offset, bytes.length);
  assert.equal(Math.max(...requests), HASH_CHUNK_SIZE);
  assert.equal(requests.at(-1), 37);
  assert.equal(progress.at(-1), 1);
});
test('cancellation stops hashing before another chunk is read', async () => {
  const controller = new AbortController();
  let reads = 0;
  await assert.rejects(hashChunks(HASH_CHUNK_SIZE * 2, length => {
    reads++;
    return new Uint8Array(length);
  }, controller.signal, () => controller.abort()), /Cancelled/);
  assert.equal(reads, 1);
});
test('truncated streams cannot produce a successful digest', async () => {
  await assert.rejects(hashChunks(42, () => new Uint8Array(), new AbortController().signal, () => {}), /changed/);
});
