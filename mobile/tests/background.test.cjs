const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { join } = require('node:path');
const calls = [];
const native = new Proxy({}, {
  get: (_target, name) => async (...args) => {
    calls.push([name, ...args]);
    return name === 'snapshot' ? '[]' : undefined;
  },
});
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'expo' && parent?.filename.endsWith(join('.test-build', 'background.js'))) {
    return { requireOptionalNativeModule: name => {
      assert.equal(name, 'SyncachuBackgroundBackup');
      return native;
    } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { BackgroundBackup, parseBackgroundJobs } = require('../.test-build/background.js');
Module._load = originalLoad;

test('background bridge scopes operations and keeps tokens out of queued jobs', async () => {
  calls.length = 0;
  const backup = new BackgroundBackup('account-a');
  await backup.configure('https://api.example/api', 'account.blob.core.windows.net', 'private-token', false);
  await backup.enqueue([{ backgroundId: 'generation-a', key: 'asset:1', assetId: '1', name: 'one.jpg',
    contentType: 'image/jpeg', status: 'queued', blocks: [], progress: 0 }]);
  await backup.setMobile(false);
  await backup.cancel('generation-a');
  await backup.retry(['generation-a']);
  await backup.acknowledge(['generation-a']);
  await backup.stop();
  assert.equal(JSON.parse(calls[0][1]).userId, 'account-a');
  for (const call of calls.slice(1)) assert.equal(call[1], 'account-a');
  assert.equal(calls[1][2].includes('private-token'), false);
  assert.deepEqual(JSON.parse(calls[1][2])[0], { id: 'generation-a', key: 'asset:1', assetId: '1',
    name: 'one.jpg', contentType: 'image/jpeg' });
  assert.throws(() => backup.enqueue([{ key: 'unsaved' }]), /Save the background job/);
});

test('background snapshot rejects malformed or falsely successful completions', () => {
  const good = { id: 'native-1', status: 'working', progress: 0.5 };
  assert.deepEqual(parseBackgroundJobs(JSON.stringify([good]))[0].status, 'working');
  for (const rows of [{}, [null], [good, good], [{ ...good, progress: 2 }],
    [{ ...good, status: 'done' }], [{ ...good, status: 'success' }]]) {
    assert.throws(() => parseBackgroundJobs(JSON.stringify(rows)), /Invalid background/);
  }
  const media = { id: 'media-1', name: 'one.jpg', contentType: 'image/jpeg', size: 42,
    createdAt: '2026-01-01T00:00:00Z', url: 'https://account.blob.core.windows.net/media/1?sig=private' };
  assert.deepEqual(parseBackgroundJobs(JSON.stringify([{ ...good, status: 'done', media }]))[0].media,
    { ...media, thumbnailUrl: undefined });
});
