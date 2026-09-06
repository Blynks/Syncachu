import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { BlobServiceClient, UserDelegationKey } from "@azure/storage-blob";
import { AzureBlobStorage } from "../src/storage.js";
import { loadConfig } from "../src/config.js";
import { SAS_LIFETIME_MS, type StoredMedia, type Ticket } from "../src/types.js";

const now = Date.UTC(2026, 0, 1);
const owner = "a".repeat(64);
const config = { storageAccountUrl: "https://syncachutest.blob.core.windows.net", storageContainer: "media", googleClientIds: ["test-client"] };
const ticket: Ticket = {
  owner, uploadId: "12345678-1234-4234-8234-123456789abc", createdAt: new Date(now).toISOString(),
  sha256: "b".repeat(64), size: 3, contentType: "image/jpeg", name: "café.jpg", hasThumbnail: true,
};
const media: StoredMedia = { id: ticket.sha256, name: ticket.name, size: 3, contentType: ticket.contentType, createdAt: ticket.createdAt };

function mockSdk() {
  const calls: { name: string; path?: string; options?: Record<string, unknown>; source?: string }[] = [];
  const data = new Map<string, Buffer>();
  const metadata = new Map<string, Record<string, string>>();
  const client = (path: string, snapshot?: string): Record<string, unknown> => ({
    url: `${config.storageAccountUrl}/media/${path}${snapshot ? `?snapshot=${encodeURIComponent(snapshot)}` : ""}`,
    withSnapshot: (id: string) => client(path, id),
    createSnapshot: async () => {
      calls.push({ name: "snapshot", path });
      data.set(`${path}@immutable-snapshot`, Buffer.from(data.get(path) ?? Buffer.alloc(3)));
      return { snapshot: "immutable-snapshot" };
    },
    getProperties: async () => {
      calls.push({ name: "properties", path, options: { snapshot } });
      return { contentLength: data.get(snapshot ? `${path}@${snapshot}` : path)?.length ?? 3, blobType: "BlockBlob", metadata: metadata.get(path) };
    },
    download: async () => {
      calls.push({ name: "download", path, options: { snapshot } });
      const bytes = data.get(snapshot ? `${path}@${snapshot}` : path);
      if (!bytes) throw { statusCode: 404 };
      return { readableStreamBody: Readable.from([bytes.subarray(0, 1), bytes.subarray(1)]) };
    },
    deleteIfExists: async () => { calls.push({ name: "delete", path, options: { snapshot } }); },
    uploadData: async (bytes: Buffer, options: Record<string, unknown>) => {
      calls.push({ name: "json", path, options });
      if (data.has(path)) throw { statusCode: 412 };
      data.set(path, bytes);
    },
    syncUploadFromURL: async (source: string, options: Record<string, unknown>) => {
      calls.push({ name: "promote", path, source, options });
      if (data.has(path)) throw { statusCode: 412 };
      const sourceUrl = new URL(source);
      const sourcePath = decodeURIComponent(sourceUrl.pathname.replace("/media/", ""));
      data.set(path, Buffer.from(data.get(`${sourcePath}@${sourceUrl.searchParams.get("snapshot")}`)!));
      metadata.set(path, options.metadata as Record<string, string>);
    },
  });
  let publicAccess: string | undefined;
  let listNames: string[] = [];
  const service = {
    getUserDelegationKey: async (startsOn: Date, expiresOn: Date): Promise<UserDelegationKey> => {
      calls.push({ name: "delegation", options: { startsOn, expiresOn } });
      return {
        signedObjectId: "00000000-0000-4000-8000-000000000001",
        signedTenantId: "00000000-0000-4000-8000-000000000002",
        signedStartsOn: startsOn, signedExpiresOn: expiresOn, signedService: "b", signedVersion: "2025-11-05",
        value: randomBytes(32).toString("base64"),
      };
    },
    getContainerClient: () => ({
      containerName: "media",
      getProperties: async () => ({ blobPublicAccess: publicAccess }),
      getBlobClient: client,
      getBlockBlobClient: client,
      listBlobsFlat: (options: Record<string, unknown>) => ({
        byPage: (paging: Record<string, unknown>) => ({
          next: async () => {
            calls.push({ name: "list", options: { ...options, ...paging } });
            return { done: false, value: { segment: { blobItems: listNames.map(name => ({ name })) }, continuationToken: "next-token" } };
          },
        }),
      }),
    }),
  };
  return {
    storage: new AzureBlobStorage(config, service as unknown as BlobServiceClient, () => now),
    calls, data, metadata,
    publicAccess: (value: string) => { publicAccess = value; },
    listNames: (value: string[]) => { listNames = value; },
  };
}

test("only HTTPS Azure accounts and explicit audiences/private container names are accepted", () => {
  assert.deepEqual(loadConfig({ GOOGLE_CLIENT_IDS: " a, b,a ", AZURE_STORAGE_ACCOUNT_URL: config.storageAccountUrl }), {
    ...config, googleClientIds: ["a", "b"],
  });
  for (const value of ["http://test.blob.core.windows.net", "https://attacker.test", "https://abc.blob.core.windows.net/path"]) {
    assert.throws(() => loadConfig({ GOOGLE_CLIENT_IDS: "a", AZURE_STORAGE_ACCOUNT_URL: value }));
  }
  assert.throws(() => loadConfig({ GOOGLE_CLIENT_IDS: "*", AZURE_STORAGE_ACCOUNT_URL: config.storageAccountUrl }));
  for (const container of ["ab", "Upper", "a--b", "a/b"]) {
    assert.throws(() => loadConfig({ GOOGLE_CLIENT_IDS: "a", AZURE_STORAGE_ACCOUNT_URL: config.storageAccountUrl, AZURE_STORAGE_CONTAINER: container }));
  }
});

test("public containers fail closed", async () => {
  const mock = mockSdk();
  await mock.storage.assertPrivate();
  mock.publicAccess("blob");
  await assert.rejects(mock.storage.assertPrivate(), /must be private/);
});

test("upload SAS is blob-scoped create/write only, HTTPS, bounded expiry, and delegation key cached", async () => {
  const mock = mockSdk();
  const result = await mock.storage.uploadUrls(ticket, new Date(now + SAS_LIFETIME_MS));
  for (const url of [result.uploadUrl, result.thumbnailUploadUrl!]) {
    const parsed = new URL(url);
    assert.ok(parsed.pathname.startsWith(`/media/staging/${owner}/${ticket.uploadId}/`));
    assert.equal(parsed.searchParams.get("sp"), "cw");
    assert.equal(parsed.searchParams.get("sr"), "b");
    assert.equal(parsed.searchParams.get("spr"), "https");
    assert.equal(Date.parse(parsed.searchParams.get("se")!), now + SAS_LIFETIME_MS);
    assert.equal(Date.parse(parsed.searchParams.get("st")!), now - 5 * 60 * 1000);
    assert.ok(parsed.searchParams.get("skoid"));
    assert.ok(parsed.searchParams.get("sig"));
  }
  assert.equal(mock.calls.filter(call => call.name === "delegation").length, 1);
});

test("gallery URLs are read only, private and never expose internal thumbnail keys", async () => {
  const mock = mockSdk();
  const result = await mock.storage.mediaUrls(owner, { ...media, thumbnailKey: `users/${owner}/final/${media.id}/thumbnails/thumb.jpg` });
  assert.ok(!("thumbnailKey" in result));
  for (const url of [result.url, result.thumbnailUrl!]) {
    const parsed = new URL(url);
    assert.ok(parsed.pathname.startsWith(`/media/users/${owner}/final/`));
    assert.equal(parsed.searchParams.get("sp"), "r");
    assert.equal(parsed.searchParams.get("spr"), "https");
    assert.equal(parsed.searchParams.get("rscc"), "private, no-store");
    assert.equal(Date.parse(parsed.searchParams.get("se")!), now + SAS_LIFETIME_MS);
  }
  assert.equal(new URL(result.url).searchParams.get("rscd"), "attachment");
  assert.equal(new URL(result.thumbnailUrl!).searchParams.get("rscd"), null);
  await assert.rejects(mock.storage.mediaUrls(owner, { ...media, thumbnailKey: "users/other/final/photo" }), /namespace/);
});

test("SDK adapter snapshots immutable input, streams downloads, promotes synchronously and conditionally", async () => {
  const mock = mockSdk();
  const stage = `staging/${owner}/${ticket.uploadId}/original`;
  mock.data.set(stage, Buffer.from("abc"));
  const snapshot = await mock.storage.snapshot(ticket, false);
  mock.data.set(stage, Buffer.from("malicious-changed-live-stage"));
  const chunks: Uint8Array[] = [];
  for await (const bytes of await mock.storage.readSnapshot(snapshot)) chunks.push(bytes);
  assert.equal(Buffer.concat(chunks).toString(), "abc");
  assert.deepEqual(await mock.storage.promoteOriginal(owner, snapshot, media), media);
  const promotion = mock.calls.find(call => call.name === "promote")!;
  const source = new URL(promotion.source!);
  assert.equal(source.searchParams.get("snapshot"), "immutable-snapshot");
  assert.equal(source.searchParams.get("sr"), "bs");
  assert.equal(source.searchParams.get("sp"), "r");
  assert.deepEqual(promotion.options?.conditions, { ifNoneMatch: "*" });
  assert.equal(promotion.options?.copySourceBlobProperties, false);
  assert.equal(mock.data.get(promotion.path!)?.toString(), "abc");
  assert.deepEqual(await mock.storage.promoteOriginal(owner, snapshot, { ...media, name: "loser.jpg" }), media);
  await mock.storage.removeSnapshot(snapshot);
  assert.ok(mock.calls.some(call => call.name === "delete" && call.options?.snapshot === "immutable-snapshot"));
});

test("metadata indexes use conditional creation, listings read only owner finalized prefix", async () => {
  const mock = mockSdk();
  assert.deepEqual(await mock.storage.finalize(owner, media), media);
  assert.deepEqual(await mock.storage.finalize(owner, { ...media, name: "loser" }), media);
  assert.ok(mock.calls.filter(call => call.name === "json").every(call => (call.options?.conditions as { ifNoneMatch: string }).ifNoneMatch === "*"));
  const name = `users/${owner}/index/${media.id}.json`;
  mock.listNames([name]);
  assert.deepEqual(await mock.storage.list(owner, "marker"), { items: [media], marker: "next-token" });
  assert.deepEqual(mock.calls.find(call => call.name === "list")?.options, {
    prefix: `users/${owner}/index/`, maxPageSize: 50, continuationToken: "marker",
  });
  mock.listNames(["users/other/index/other.json"]);
  await assert.rejects(mock.storage.list(owner), /namespace/);
  assert.equal(await mock.storage.getTicket("other", ticket.uploadId), undefined);
});

test("tickets have a lifecycle-addressable prefix separate from finalized media and enforce owner lookup", async () => {
  const mock = mockSdk();
  await mock.storage.createTicket(ticket);
  assert.ok(mock.data.has(`tickets/${owner}/${ticket.uploadId}.json`));
  assert.deepEqual(await mock.storage.getTicket(owner, ticket.uploadId), ticket);
  assert.equal(await mock.storage.getTicket("other", ticket.uploadId), undefined);
  assert.ok(mock.calls.filter(call => call.name === "json").every(call => call.path?.startsWith("tickets/")));
});

test("server metadata reads are bounded even if storage is corrupted", async () => {
  const mock = mockSdk();
  mock.data.set(`users/${owner}/index/${media.id}.json`, Buffer.alloc(16 * 1024 + 1));
  await assert.rejects(mock.storage.getMedia(owner, media.id), /Metadata limit/);
});
