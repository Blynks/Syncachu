const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { join } = require('node:path');
const stored = new Map();
const jobs = new Map();
const calls = [];
let snapshotRead;
let configureError;
const storage = {
  getItem: async key => stored.get(key) ?? null,
  setItem: async (key, value) => { stored.set(key, value); },
  getAllKeys: async () => [...stored.keys()],
  multiRemove: async keys => { keys.forEach(key => stored.delete(key)); },
};
const AppState = {
  currentState: 'active',
  addEventListener: (_event, listener) => {
    AppState.listener = listener;
    return { remove() { AppState.listener = undefined; } };
  },
};
class BackgroundBackup {
  available = true;
  constructor(userId) { this.userId = userId; }
  async configure(_api, _blob, _token, allowMobile) {
    calls.push(['configure', this.userId, allowMobile]);
    if (configureError) throw configureError;
  }
  async snapshot() { return snapshotRead ? snapshotRead() : structuredClone([...jobs.values()]); }
  async enqueue(items) {
    const saved = await new QueueStorage(storage, `syncachu.v1.${this.userId}`).read();
    for (const item of items) {
      assert.equal(saved.queue.find(row => row.key === item.key).backgroundId, item.backgroundId);
      jobs.set(item.backgroundId, { id: item.backgroundId, status: 'queued', progress: 0 });
      calls.push(['enqueue', item.backgroundId]);
    }
  }
  async cancel(id) {
    calls.push(['cancel', id]);
    if (jobs.has(id)) jobs.set(id, { ...jobs.get(id), status: 'cancelled' });
  }
  async retry(ids) {
    calls.push(['retry', ids]);
    for (const id of ids) jobs.set(id, { ...jobs.get(id), status: 'queued', error: undefined });
  }
  async acknowledge(ids) {
    const saved = await new QueueStorage(storage, `syncachu.v1.${this.userId}`).read();
    for (const id of ids) {
      const row = saved.queue.find(item => item.backgroundId === id);
      assert.ok(!row || row.status === 'done' || row.status === 'cancelled', 'persist before native acknowledgement');
      calls.push(['acknowledge', id]);
      jobs.delete(id);
    }
  }
  async setMobile(value) { calls.push(['mobile', value]); }
  async stop() { calls.push(['stop', this.userId]); }
}
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename.endsWith(join('.test-build', 'engine.js'))) {
    if (request === '@react-native-async-storage/async-storage') return { __esModule: true, default: storage };
    if (request === 'react-native') return { AppState };
    if (request === 'expo-network') return {
      NetworkStateType: { WIFI: 'WIFI' },
      getNetworkStateAsync: async () => ({ isConnected: true, isInternetReachable: true, type: 'WIFI' }),
      addNetworkStateListener: () => ({ remove() {} }),
    };
    if (request === 'expo-media-library') return { addListener: () => ({ remove() {} }) };
    if (request === 'expo-image-picker' || request === 'expo-file-system') return {};
    if (request === './api') return { ApiError: class extends Error {}, Api: class {
      async token() { return 'account-token'; }
      async drain() {}
      async request(path) { return path === 'usage'
        ? { limitBytes: 1000, usedBytes: 0, reservedBytes: 0, availableBytes: 1000 } : { items: [] }; }
    } };
    if (request === './device') return {
      userDirectory: userId => ({ uri: `file:///owned/${userId}/` }),
      removeOwnedFile: uri => { if (uri) calls.push(['remove', uri]); },
    };
    if (request === './upload') return { upload: () => { throw new Error('JS uploader must not run with native worker'); } };
    if (request === './background') return { BackgroundBackup };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { SyncEngine } = require('../.test-build/engine.js');
const { QueueStorage } = require('../.test-build/queueStorage.js');
Module._load = originalLoad;

function seed(patch = {}) {
  stored.clear(); jobs.clear(); calls.length = 0;
  AppState.currentState = 'active'; snapshotRead = undefined; configureError = undefined;
  stored.set('syncachu.v1.account-a', JSON.stringify({ auto: false, allowMobile: false, queue: [{
    key: 'asset:1', assetId: '1', name: 'one.jpg', contentType: 'image/jpeg', status: 'queued',
    progress: 0, blocks: [], ...patch,
  }] }));
}
async function settle(engine) {
  await engine.pump();
  if (engine.nativeRun) await engine.nativeRun;
}
function done(id) {
  return { id, status: 'done', progress: 1, media: {
    id: 'media-1', name: 'one.jpg', contentType: 'image/jpeg', size: 42,
    createdAt: '2026-01-01T00:00:00Z', url: 'https://storage.example/media',
  } };
}

test('native handoff is durable and backgrounding does not cancel the backup', async () => {
  seed();
  const engine = new SyncEngine('account-a');
  try {
    await engine.initialize(); await settle(engine);
    assert.equal(engine.snapshot().background, true);
    assert.equal(jobs.size, 1);
    const id = engine.snapshot().queue[0].backgroundId;
    AppState.currentState = 'background'; AppState.listener('background');
    jobs.set(id, done(id));
    await settle(engine);
    assert.equal(engine.snapshot().queue[0].status, 'queued');
    assert.equal(calls.some(call => call[0] === 'cancel' || call[0] === 'stop'), false);
    AppState.currentState = 'active'; AppState.listener('active');
    await settle(engine);
    assert.equal(engine.snapshot().queue[0].status, 'done');
    assert.equal(engine.snapshot().gallery[0].id, 'media-1');
    assert.equal(jobs.size, 0);
  } finally { await engine.destroy(); }
});

test('cold restart reconciles native completion without uploading the same job again', async () => {
  seed({ status: 'working', backgroundId: 'persisted-native-id' });
  jobs.set('persisted-native-id', done('persisted-native-id'));
  const engine = new SyncEngine('account-a');
  try {
    await engine.initialize(); await settle(engine);
    assert.equal(engine.snapshot().queue[0].status, 'done');
    assert.equal(calls.some(call => call[0] === 'enqueue'), false);
    assert.ok(calls.some(call => call[0] === 'acknowledge'));
  } finally { await engine.destroy(); }
});

test('failed durable completion write never acknowledges or deletes the native result', async () => {
  seed();
  const engine = new SyncEngine('account-a');
  const originalWrite = storage.setItem;
  try {
    await engine.initialize(); await settle(engine);
    const id = engine.snapshot().queue[0].backgroundId;
    jobs.set(id, done(id));
    storage.setItem = async (_key, value) => {
      if (value.includes('"status":"done"')) throw new Error('Storage full');
      return originalWrite(_key, value);
    };
    await settle(engine);
    assert.equal(jobs.has(id), true);
    assert.match(engine.snapshot().message, /Storage full/);
    storage.setItem = originalWrite;
    await settle(engine);
    assert.equal(jobs.has(id), false);
  } finally { storage.setItem = originalWrite; await engine.destroy(); }
});

test('cancellation wins over late native completion and stops before removing a picked copy', async () => {
  seed({ uri: 'file:///owned/account-a/picked.jpg', assetId: undefined });
  const engine = new SyncEngine('account-a');
  try {
    await engine.initialize(); await settle(engine);
    const id = engine.snapshot().queue[0].backgroundId;
    await engine.cancel('asset:1');
    jobs.set(id, done(id));
    await settle(engine);
    assert.equal(engine.snapshot().queue[0].status, 'cancelled');
    assert.deepEqual(engine.snapshot().gallery, []);
    assert.ok(calls.findIndex(call => call[0] === 'cancel') < calls.findIndex(call => call[0] === 'remove'));
  } finally { await engine.destroy(); }
});

test('native quota and auth errors remain visible and retry refreshes credentials', async () => {
  seed();
  const engine = new SyncEngine('account-a');
  try {
    await engine.initialize(); await settle(engine);
    const id = engine.snapshot().queue[0].backgroundId;
    for (const httpStatus of [507, 401]) {
      jobs.set(id, { id, status: 'error', progress: 0.4, httpStatus, error: `Paused ${httpStatus}` });
      await settle(engine);
      assert.equal(engine.snapshot().queue[0].status, 'error');
      assert.equal(engine.snapshot().message, `Paused ${httpStatus}`);
      const before = calls.length;
      await engine.retry(); await settle(engine);
      const next = calls.slice(before);
      assert.equal(next[0][0], 'configure');
      assert.deepEqual(next.find(call => call[0] === 'retry')[1], [id]);
      assert.equal(engine.snapshot().queue[0].status, 'queued');
    }
  } finally { await engine.destroy(); }
});

test('a saved identifier with no native row is re-enqueued idempotently', async () => {
  seed({ status: 'working', backgroundId: 'saved-before-crash' });
  const engine = new SyncEngine('account-a');
  try {
    await engine.initialize(); await settle(engine); await settle(engine);
    assert.deepEqual(calls.filter(call => call[0] === 'enqueue'), [['enqueue', 'saved-before-crash']]);
    await engine.setMobile(false);
    assert.deepEqual(calls.find(call => call[0] === 'mobile'), ['mobile', false]);
  } finally { await engine.destroy(); }
});

test('native setup failures leave the queue ready for an explicit resume', async () => {
  seed();
  configureError = new Error('Sign-in expired');
  const engine = new SyncEngine('account-a');
  try {
    await engine.initialize();
    assert.equal(engine.snapshot().ready, true);
    assert.match(engine.snapshot().message, /Sign-in expired/);
    assert.equal(jobs.size, 0);
    configureError = undefined;
    await engine.retry(); await settle(engine);
    assert.equal(jobs.size, 1);
  } finally { await engine.destroy(); }
});

test('credential refresh cannot restore cellular while an opt-out is being applied', async () => {
  seed();
  const engine = new SyncEngine('account-a');
  let release;
  try {
    await engine.initialize(); await settle(engine);
    await engine.setMobile(true);
    engine.background.setMobile = async () => new Promise(resolve => { release = resolve; });
    const changing = engine.setMobile(false);
    await engine.configureBackground();
    assert.deepEqual(calls.filter(call => call[0] === 'configure').at(-1), ['configure', 'account-a', false]);
    release(); await changing;
    assert.equal(engine.snapshot().allowMobile, false);
  } finally { release?.(); await engine.destroy(); }
});

test('sign-out stops native work once and discards a delayed snapshot', async () => {
  seed();
  const engine = new SyncEngine('account-a');
  await engine.initialize(); await settle(engine);
  const id = engine.snapshot().queue[0].backgroundId;
  let release;
  snapshotRead = () => new Promise(resolve => { release = resolve; });
  const pending = engine.pump();
  const closing = engine.destroy();
  release([done(id)]);
  await pending; await closing; await engine.destroy();
  assert.equal(engine.snapshot().queue[0].status, 'queued');
  assert.deepEqual(engine.snapshot().gallery, []);
  assert.deepEqual(calls.filter(call => call[0] === 'stop'), [['stop', 'account-a']]);
});
