const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { BLOCK_SIZE, blockId } = require('../.test-build/core.js');

const host = 'mystorage.blob.core.windows.net';
let fingerprint;
let file;
let preview;
class ApiError extends Error { constructor(status) { super(); this.status = status; } }
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename.endsWith('/.test-build/upload.js')) {
    if (request === 'expo/fetch') return { fetch: (...args) => global.fetch(...args) };
    if (request === 'expo-file-system') return { FileMode: { ReadOnly: 'r' } };
    if (request === './api') return { ApiError, BLOB_HOST: host };
    if (request === './device') return {
      resolveFile: async () => file,
      hashFile: async () => fingerprint,
      thumbnail: async () => preview,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { upload } = require('../.test-build/upload.js');
Module._load = originalLoad;

function setup(size = BLOCK_SIZE + 7) {
  fingerprint = { sha256: 'a'.repeat(64), size, modified: 12 };
  file = {
    info: () => ({ size, modificationTime: 12 }),
    open: () => ({ offset: 0, readBytes: length => new Uint8Array(length), close() {} }),
  };
  preview = undefined;
  return { key: 'one', name: 'one.mp4', contentType: 'video/mp4', status: 'working',
    blocks: [], progress: 0, size, sha256: fingerprint.sha256 };
}
function ticket() {
  return { duplicate: false, uploadId: 'stage1', blockSize: BLOCK_SIZE,
    uploadUrl: `https://${host}/private/original?sig=test`, expiresAt: new Date(Date.now() + 300_000).toISOString() };
}
test('resumed upload renews, skips acknowledged block, commits full list without Google headers', async () => {
  const item = { ...setup(), uploadId: 'stage1', blocks: [0] };
  const puts = [];
  const calls = [];
  const previousFetch = global.fetch;
  global.fetch = async (url, options) => { puts.push({ url: new URL(url), ...options }); return { ok: true }; };
  try {
    const result = await upload(item, { request: async path => {
      calls.push(path);
      return path.endsWith('/renew') ? ticket() : { id: 'saved' };
    } }, new AbortController().signal, async patch => Object.assign(item, patch), () => {});
    assert.equal(result.id, 'saved');
    assert.deepEqual(calls, ['uploads/stage1/renew', 'uploads/stage1/complete']);
    assert.equal(puts.length, 2);
    assert.equal(puts[0].url.searchParams.get('blockid'), blockId(1));
    assert.equal(puts[0].body.length, 7);
    assert.match(puts[1].body, new RegExp(blockId(0)));
    assert.match(puts[1].body, new RegExp(blockId(1)));
    puts.forEach(put => assert.equal(put.headers.Authorization, undefined));
    assert.deepEqual(item.blocks, [0, 1]);
  } finally { global.fetch = previousFetch; }
});
test('changed content discards old stage and handles duplicate without storage upload', async () => {
  const item = { ...setup(), sha256: 'b'.repeat(64), uploadId: 'old-stage', blocks: [0] };
  const calls = [];
  const result = await upload(item, { request: async (path, body) => {
    calls.push({ path, body });
    return { duplicate: true, media: { id: 'duplicate' } };
  } }, new AbortController().signal, async patch => Object.assign(item, patch), () => {});
  assert.equal(result.id, 'duplicate');
  assert.equal(calls[0].path, 'uploads');
  assert.equal(calls[0].body.sha256, fingerprint.sha256);
  assert.equal(item.uploadId, undefined);
  assert.deepEqual(item.blocks, []);
});
test('cancellation after storage request prevents saving its block or completing', async () => {
  const item = { ...setup(10), uploadId: 'stage1' };
  const controller = new AbortController();
  const previousFetch = global.fetch;
  global.fetch = async () => { controller.abort(); return { ok: true }; };
  const calls = [];
  try {
    await assert.rejects(upload(item, { request: async path => { calls.push(path); return ticket(); } },
      controller.signal, async patch => Object.assign(item, patch), () => {}), /Cancelled/);
    assert.deepEqual(item.blocks, []);
    assert.deepEqual(calls, ['uploads/stage1/renew']);
  } finally { global.fetch = previousFetch; }
});
test('upload checkpoint tracking does not require persistence to mutate input', async () => {
  const item = setup();
  const saved = [];
  const previousFetch = global.fetch;
  global.fetch = async () => ({ ok: true });
  try {
    const media = await upload(item, { request: async path => path === 'uploads' ? ticket() : { id: 'saved' } },
      new AbortController().signal, async patch => { saved.push(patch); }, () => {});
    assert.equal(media.id, 'saved');
    assert.deepEqual(saved.filter(patch => patch.blocks?.length).map(patch => patch.blocks), [[0], [0, 1]]);
    assert.deepEqual(item.blocks, []);
    assert.equal(item.uploadId, undefined);
  } finally { global.fetch = previousFetch; }
});
test('expired Azure blocks clear acknowledgements so a manual retry re-stages bytes', async () => {
  const item = { ...setup(10), uploadId: 'stage1', blocks: [0] };
  const previousFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 400 });
  try {
    await assert.rejects(upload(item, { request: async () => ticket() }, new AbortController().signal,
      async patch => Object.assign(item, patch), () => {}), /Storage upload failed/);
    assert.deepEqual(item.blocks, []);
  } finally { global.fetch = previousFetch; }
});
test('unsupported MKV media is rejected before any upload API call', async () => {
  const item = { ...setup(10), contentType: 'video/x-matroska' };
  let called = false;
  await assert.rejects(upload(item, { request: async () => { called = true; return ticket(); } },
    new AbortController().signal, async () => {}, () => {}), /Unsupported media type: video\/x-matroska/);
  assert.equal(called, false);
});
