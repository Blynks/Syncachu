import assert from "node:assert/strict";
import { test } from "node:test";
import { TableClient } from "@azure/data-tables";
import { AzureQuotaStore } from "../src/quotaStorage.js";
import { loadStorageConfig } from "../src/config.js";

const config = loadStorageConfig({ AZURE_STORAGE_ACCOUNT_URL: "https://syncachutest.blob.core.windows.net" });
function setup(status = 200, body: unknown = {}) {
  const requests: { url: string; body: unknown }[] = [];
  const table = new TableClient("https://syncachutest.table.core.windows.net", "syncachuquota", {
    getToken: async () => ({ token: "test-token", expiresOnTimestamp: Date.now() + 60_000 }),
  }, {
    retryOptions: { maxRetries: 0 },
    httpClient: {
      sendRequest: async request => {
        requests.push({ url: request.url, body: request.body });
        request.headers.set("content-type", "application/json");
        return { request, status, headers: request.headers, bodyAsText: JSON.stringify(body) };
      },
    },
  });
  return { store: new AzureQuotaStore(config, table), requests };
}
test("Table adapter decodes actual SDK entity responses without truncating TB counters", async () => {
  const { store } = setup(200, {
    "odata.etag": 'W/"version1"', PartitionKey: "instance", RowKey: "usage", kind: "counter", state: "ready",
    "usedBytes@odata.type": "Edm.Double", usedBytes: 1e12, "reservedBytes@odata.type": "Edm.Double", reservedBytes: 4e9,
  });
  assert.deepEqual(await store.get("usage"), {
    rowKey: "usage", etag: 'W/"version1"', kind: "counter", state: "ready", usedBytes: 1e12, reservedBytes: 4e9,
  });
});
test("Table transactions serialize ETags, shared partition and Double byte values", async () => {
  const { store, requests } = setup(409, { "odata.error": { code: "EntityAlreadyExists", message: { lang: "en-US", value: "Conflict" } } });
  assert.equal(await store.transact([
    { entry: { rowKey: "usage", kind: "counter", state: "ready", usedBytes: 1e12, reservedBytes: 3e9 }, etag: 'W/"counter1"' },
    { entry: { rowKey: "media-owner-hash", kind: "media", bytes: 3e9 } },
  ]), false);
  assert.equal(requests.length, 1);
  const body = String(requests[0]!.body);
  assert.match(body, /"usedBytes@odata.type":"Edm.Double"/);
  assert.match(body, /"reservedBytes@odata.type":"Edm.Double"/);
  assert.match(body, /"bytes@odata.type":"Edm.Double"/);
  assert.match(body, /"PartitionKey":"instance"/);
  assert.match(body, /if-match: W\/"counter1"/i);
});
test("Table conflicts can retry but permissions and transport errors are not swallowed", async () => {
  assert.equal(await setup(404).store.get("missing"), undefined);
  const changes = [{ entry: { rowKey: "media-x", kind: "media" as const, bytes: 1 } }];
  assert.equal(await setup(412).store.transact(changes), false);
  await assert.rejects(setup(403).store.transact(changes));
  await assert.rejects(setup(500).store.get("usage"));
});
test("expiry query is scoped to the shared ledger and includes stale publications", async () => {
  const { store, requests } = setup(200, { value: [{ PartitionKey: "instance", RowKey: "upload-id" }] });
  const rows: string[] = [];
  for await (const row of store.expired("2026-09-01T00:00:00.000Z")) rows.push(row);
  assert.deepEqual(rows, ["upload-id"]);
  const filter = new URL(requests[0]!.url).searchParams.get("$filter")!;
  assert.match(filter, /PartitionKey eq 'instance'/);
  assert.match(filter, /state eq 'publishing'/);
  assert.match(filter, /expiresAt le '2026-09-01T00:00:00.000Z'/);
});
