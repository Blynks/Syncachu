const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { join } = require('node:path');
process.env.EXPO_PUBLIC_API_URL = 'https://api.example.com/api';
let currentUser = 'user-a';
let requests = [];
let silentCalls = 0;
let cachedTokenCalls = 0;
const success = token => ({ type: 'success', data: { user: { id: 'user-a' }, idToken: token } });
let silentSignIn = async () => success('test');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename.endsWith(join('.test-build', 'api.js'))) {
    if (request === '@react-native-google-signin/google-signin') return { GoogleSignin: {
      getCurrentUser: () => ({ user: { id: currentUser } }),
      getTokens: async () => { cachedTokenCalls++; return { idToken: 'expired-cached-token' }; },
      signInSilently: () => { silentCalls++; return silentSignIn(); },
    } };
    if (request === 'expo/fetch') return { fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: false, status: 302, json: async () => ({ error: 'Redirect refused' }) };
    } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { Api } = require('../.test-build/api.js');
Module._load = originalLoad;

test('authenticated API requests reject redirects rather than forwarding the ID token', async () => {
  requests = [];
  const api = new Api('user-a', new AbortController().signal);
  await assert.rejects(api.request('media'), /Redirect refused/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.example.com/api/media');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[0].options.headers.Authorization, ['Bearer', 'test'].join(' '));
});
test('API client refuses to send its ID token to an Azure SAS URL', async () => {
  requests = [];
  const api = new Api('user-a', new AbortController().signal);
  await assert.rejects(api.request('https://mystorage.blob.core.windows.net/private/thumbnail?sig=test'), /untrusted media URL/);
  assert.equal(requests.length, 0);
});
test('expired cached ID tokens are replaced through silent sign-in, never access-token refresh', async () => {
  requests = [];
  cachedTokenCalls = 0;
  silentSignIn = async () => success('refreshed-id-token');
  const api = new Api('user-a', new AbortController().signal);
  await assert.rejects(api.request('media'), /Redirect refused/);
  assert.equal(requests[0].options.headers.Authorization, ['Bearer', 'refreshed-id-token'].join(' '));
  assert.equal(cachedTokenCalls, 0);
  silentSignIn = async () => success('test');
});
test('parallel API callers share one in-flight silent refresh', async () => {
  let resolve;
  silentCalls = 0;
  silentSignIn = () => new Promise(done => { resolve = done; });
  const api = new Api('user-a', new AbortController().signal);
  const first = api.token();
  const second = api.token();
  assert.equal(silentCalls, 1);
  resolve(success('fresh-shared-token'));
  assert.deepEqual(await Promise.all([first, second]), ['fresh-shared-token', 'fresh-shared-token']);
  silentSignIn = async () => success('test');
  assert.equal(await api.token(), 'test');
  assert.equal(silentCalls, 2);
});
test('account switch during silent refresh blocks the request and discards returned token', async () => {
  requests = [];
  let resolve;
  silentSignIn = () => new Promise(done => { resolve = done; });
  const api = new Api('user-a', new AbortController().signal);
  const request = api.request('media');
  currentUser = 'user-b';
  resolve(success('old-account-token'));
  await assert.rejects(request, /Account changed/);
  assert.equal(requests.length, 0);
  currentUser = 'user-a';
  silentSignIn = async () => success('test');
});
test('sign-out aborts refreshed-token use and drains the native SDK before another auth action', async () => {
  let resolve;
  silentSignIn = () => new Promise(done => { resolve = done; });
  const session = new AbortController();
  const api = new Api('user-a', session.signal);
  const token = api.token();
  session.abort();
  let drained = false;
  const drain = api.drain().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  resolve(success('discarded-token'));
  await assert.rejects(token, /Cancelled/);
  await drain;
  assert.equal(drained, true);
  silentSignIn = async () => success('test');
});
