const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { join } = require('node:path');
const stored = new Map();
const storage = {
  getItem: async key => stored.get(key) ?? null,
  setItem: async (key, value) => { stored.set(key, value); },
  getAllKeys: async () => [...stored.keys()],
  multiRemove: async keys => { keys.forEach(key => stored.delete(key)); },
};
const removed = [];
let runUpload;
let permissionRequests = 0;
let readApi = async path => path === 'usage'
  ? { limitBytes: 1e12, usedBytes: 0, reservedBytes: 0, availableBytes: 1e12 } : { items: [] };
class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
const AppState = { currentState: 'active', addEventListener: () => ({ remove() {} }) };
const network = { isConnected: true, isInternetReachable: true, type: 'WIFI' };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename.endsWith(join('.test-build', 'engine.js'))) {
    if (request === '@react-native-async-storage/async-storage') return { __esModule: true, default: storage };
    if (request === 'react-native') return { AppState };
    if (request === 'expo-network') return {
      NetworkStateType: { WIFI: 'WIFI' }, getNetworkStateAsync: async () => network,
      addNetworkStateListener: () => ({ remove() {} }),
    };
    if (request === 'expo-media-library') return {
      addListener: () => ({ remove() {} }),
      requestPermissionsAsync: async () => { permissionRequests++; return { granted: false }; },
    };
    if (request === 'expo-image-picker' || request === 'expo-file-system') return {};
    if (request === './api') return { ApiError, Api: class {
      constructor(userId) { this.userId = userId; }
      async drain() {}
      request(path) { return readApi(path); }
    } };
    if (request === './device') return {
      userDirectory: userId => ({ uri: `file:///owned/${userId}/` }),
      removeOwnedFile: uri => removed.push(uri),
    };
    if (request === './upload') return { upload: (...args) => runUpload(...args) };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { SyncEngine } = require('../.test-build/engine.js');
const { QueueStorage } = require('../.test-build/queueStorage.js');
Module._load = originalLoad;

function seed(userId, status = 'queued') {
  stored.set(`syncachu.v1.${userId}`, JSON.stringify({
    queue: [{ key: 'asset:1', name: 'one.jpg', contentType: 'image/jpeg', status, blocks: [], progress: 0 }],
    auto: false, allowMobile: false,
  }));
}
async function until(condition) {
  for (let i = 0; i < 50 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(condition(), 'Expected asynchronous condition');
}
test('sign-out aborts old upload and cannot leak its completion into another account', async () => {
  stored.clear();
  seed('user-a');
  let resolveOld;
  let oldSignal;
  runUpload = async (_item, _api, signal) => {
    oldSignal = signal;
    return new Promise(resolve => { resolveOld = resolve; });
  };
  const first = new SyncEngine('user-a');
  await first.initialize();
  await until(() => !!resolveOld);
  await first.destroy();
  assert.equal(oldSignal.aborted, true);
  const second = new SyncEngine('user-b');
  await second.initialize();
  resolveOld({ id: 'private-a' });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(second.api.userId, 'user-b');
  assert.deepEqual(second.snapshot().queue, []);
  assert.deepEqual(second.snapshot().gallery, []);
  assert.equal((await new QueueStorage(storage, 'syncachu.v1.user-a').read()).queue[0].status, 'working');
  await second.destroy();
});
test('cancel aborts job and stale completion cannot change cancelled status', async () => {
  stored.clear();
  seed('cancel-user');
  let resolveJob;
  let jobSignal;
  runUpload = async (_item, _api, signal) => {
    jobSignal = signal;
    return new Promise(resolve => { resolveJob = resolve; });
  };
  const engine = new SyncEngine('cancel-user');
  await engine.initialize();
  await until(() => !!resolveJob);
  await engine.cancel('asset:1');
  resolveJob({ id: 'cancelled-upload' });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(jobSignal.aborted, true);
  assert.equal(engine.snapshot().queue[0].status, 'cancelled');
  assert.deepEqual(engine.snapshot().gallery, []);
  await engine.destroy();
});
test('double retry cannot replace an already-running queue entry', async () => {
  stored.clear();
  seed('retry-user', 'error');
  let resolveJob;
  runUpload = async () => new Promise(resolve => { resolveJob = resolve; });
  const engine = new SyncEngine('retry-user');
  await engine.initialize();
  await engine.retry('asset:1');
  await until(() => !!resolveJob);
  const running = engine.snapshot().queue[0];
  assert.equal(running.status, 'working');
  await engine.retry('asset:1');
  assert.equal(engine.snapshot().queue[0], running);
  await engine.destroy();
  resolveJob({ id: 'ignored' });
});
test('an expired account cannot request auto-sync permissions', async () => {
  const engine = new SyncEngine('closed-user');
  await engine.destroy();
  const before = permissionRequests;
  await engine.setAuto(true);
  assert.equal(permissionRequests, before);
});

test('initialization loads existing cloud gallery and shared storage usage', async () => {
  stored.clear();
  const previous = readApi;
  const usage = { limitBytes: 1e12, usedBytes: 100, reservedBytes: 50, availableBytes: 1e12 - 150 };
  readApi = async path => path === 'usage' ? usage : { items: [{ id: 'existing-backup' }] };
  const engine = new SyncEngine('usage-user');
  try {
    await engine.initialize();
    assert.deepEqual(engine.snapshot().usage, usage);
    assert.equal(engine.snapshot().gallery[0].id, 'existing-backup');
  } finally { await engine.destroy(); readApi = previous; }
});

test('quota rejection pauses remaining work until explicit retry', async () => {
  stored.clear();
  seed('quota-user');
  const saved = JSON.parse(stored.get('syncachu.v1.quota-user'));
  saved.queue.push({ ...saved.queue[0], key: 'asset:2' });
  stored.set('syncachu.v1.quota-user', JSON.stringify(saved));
  let attempts = 0;
  runUpload = async () => { attempts++; throw new ApiError(507, 'Instance storage quota reached'); };
  const engine = new SyncEngine('quota-user');
  try {
    await engine.initialize();
    await until(() => engine.snapshot().message.includes('quota reached'));
    assert.equal(attempts, 1);
    assert.equal(engine.snapshot().queue[1].status, 'queued');
    await until(() => !engine.running);
    runUpload = async item => { attempts++; return { id: item.key }; };
    await engine.retry();
    await until(() => engine.snapshot().queue.every(item => item.status === 'done'));
    assert.equal(attempts, 3);
  } finally { await engine.destroy(); }
});

test('usage failure is visible and sign-out discards delayed usage responses', async () => {
  stored.clear();
  const previous = readApi;
  readApi = async () => { throw new ApiError(403, 'Account not approved'); };
  const engine = new SyncEngine('usage-error');
  try {
    await engine.loadUsage();
    assert.equal(engine.snapshot().usage, undefined);
    assert.equal(engine.snapshot().usageError, 'Account not approved');
    let resolve;
    readApi = () => new Promise(done => { resolve = done; });
    const pending = engine.loadUsage();
    await engine.destroy();
    resolve({ limitBytes: 1e12, usedBytes: 0, reservedBytes: 0, availableBytes: 1e12 });
    await pending;
    assert.equal(engine.snapshot().usage, undefined);
  } finally { await engine.destroy(); readApi = previous; }
});

test('cancelling a quota-failed item allows remaining smaller uploads to proceed', async () => {
  stored.clear();
  seed('quota-cancel');
  const saved = JSON.parse(stored.get('syncachu.v1.quota-cancel'));
  saved.queue.push({ ...saved.queue[0], key: 'asset:2' });
  stored.set('syncachu.v1.quota-cancel', JSON.stringify(saved));
  let attempts = 0;
  runUpload = async item => {
    attempts++;
    if (item.key === 'asset:1') throw new ApiError(507, 'Instance storage quota reached');
    return { id: item.key };
  };
  const engine = new SyncEngine('quota-cancel');
  try {
    await engine.initialize();
    await until(() => engine.snapshot().message.includes('quota reached'));
    await engine.cancel('asset:1');
    await until(() => engine.snapshot().queue[1].status === 'done');
    assert.equal(engine.snapshot().queue[0].status, 'cancelled');
    assert.equal(attempts, 2);
  } finally { await engine.destroy(); }
});

test('retry requested during a delayed post-error usage refresh is not lost', async () => {
  stored.clear();
  seed('quota-race');
  const previous = readApi;
  let failed = false;
  let resolveUsage;
  let attempts = 0;
  readApi = path => path === 'usage' && failed
    ? new Promise(resolve => { resolveUsage = resolve; }) : previous(path);
  runUpload = async item => {
    attempts++;
    if (!failed) { failed = true; throw new ApiError(507, 'Instance storage quota reached'); }
    return { id: item.key };
  };
  const engine = new SyncEngine('quota-race');
  try {
    await engine.initialize();
    await until(() => !!resolveUsage);
    await engine.retry();
    assert.equal(engine.snapshot().queue[0].status, 'queued');
    assert.equal(attempts, 1);
    readApi = previous;
    resolveUsage(await previous('usage'));
    await until(() => engine.snapshot().queue[0].status === 'done');
    assert.equal(attempts, 2);
  } finally { await engine.destroy(); readApi = previous; }
});

test('retry during error persistence cannot reinstate the quota pause', async () => {
  stored.clear();
  seed('quota-persist-race');
  const previousWrite = storage.setItem;
  let releaseWrite;
  let attempts = 0;
  storage.setItem = async (key, value) => {
    if (!releaseWrite && value.includes('"status":"error"')) {
      await new Promise(resolve => { releaseWrite = resolve; });
    }
    await previousWrite(key, value);
  };
  runUpload = async item => {
    if (++attempts === 1) throw new ApiError(507, 'Instance storage quota reached');
    return { id: item.key };
  };
  const engine = new SyncEngine('quota-persist-race');
  try {
    await engine.initialize();
    await until(() => !!releaseWrite);
    const retry = engine.retry();
    releaseWrite();
    await retry;
    await until(() => engine.snapshot().queue[0].status === 'done');
    assert.equal(attempts, 2);
  } finally { releaseWrite?.(); await engine.destroy(); storage.setItem = previousWrite; }
});
