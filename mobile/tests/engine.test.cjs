const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
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
const AppState = { currentState: 'active', addEventListener: () => ({ remove() {} }) };
const network = { isConnected: true, isInternetReachable: true, type: 'WIFI' };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename.endsWith('/.test-build/engine.js')) {
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
    if (request === './api') return { Api: class { constructor(userId) { this.userId = userId; } async drain() {} } };
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
