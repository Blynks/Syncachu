import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { validateInput, verifyStream } from "../src/service.js";
import { ApiError, MAX_MEDIA_SIZE, MAX_THUMBNAIL_SIZE, SAS_LIFETIME_MS, TICKET_LIFETIME_MS, type UploadTicket } from "../src/types.js";
import { MemoryStorage } from "./memory.js";

const owner = "a".repeat(64);
const other = "b".repeat(64);
const data = Buffer.from("media-content");
const sha256 = createHash("sha256").update(data).digest("hex");
const input = { sha256, size: data.length, contentType: "image/jpeg", name: "photo.jpg", hasThumbnail: false };
const rejects = (status: number) => (error: unknown) => error instanceof ApiError && error.status === status;
const stream = async function* (data: Buffer) { for (const byte of data) yield Buffer.from([byte]); };

test("upload input rejects malformed types, paths in hashes, unsafe MIME, bad size, and names", () => {
  const invalid = [
    null, [], {}, { ...input, sha256: sha256.toUpperCase() }, { ...input, sha256: "../x" },
    { ...input, size: -1 }, { ...input, size: 0 }, { ...input, size: 1.5 }, { ...input, size: NaN },
    { ...input, size: "12" }, { ...input, contentType: "text/html" }, { ...input, contentType: "image/svg+xml" },
    { ...input, name: "\r\nfoo" }, { ...input, name: "" }, { ...input, name: "x".repeat(256) },
    { ...input, hasThumbnail: "false" },
  ];
  for (const value of invalid) assert.throws(() => validateInput(value), rejects(400));
  assert.throws(() => validateInput({ ...input, size: MAX_MEDIA_SIZE + 1 }), rejects(413));
  assert.deepEqual(validateInput(input), input);
});

test("completion hashes actual stream, snapshots before reading, and is idempotent", async () => {
  const store = new MemoryStorage();
  const service = store.service();
  const ticket = await service.begin(owner, input) as UploadTicket;
  assert.equal(ticket.duplicate, false);
  assert.equal(ticket.blockSize, 4_194_304);
  store.stage(owner, ticket.uploadId, data);
  const result = await service.complete(owner, ticket.uploadId);
  assert.equal(result.id, sha256);
  assert.deepEqual(store.calls, ["snapshot", "read", "promote", "finalize"]);
  assert.equal(store.snapshots.size, 0);
  assert.deepEqual(await service.complete(owner, ticket.uploadId), result);
  assert.deepEqual(await service.begin(owner, input), { duplicate: true, media: result });
  assert.equal(store.originals.size, 1);
});

test("staging mutation while verification runs cannot alter promoted original", async () => {
  const store = new MemoryStorage();
  const service = store.service();
  const ticket = await service.begin(owner, input) as UploadTicket;
  store.stage(owner, ticket.uploadId, data);
  store.onRead = () => store.stage(owner, ticket.uploadId, Buffer.from("evil-mutation"));
  await service.complete(owner, ticket.uploadId);
  assert.deepEqual(store.originals.get(`${owner}/${sha256}`), data);
});

test("wrong real digest, declared size, truncated and oversized streams never finalize", async () => {
  for (const uploaded of [Buffer.from("wrong-content"), Buffer.from("short"), Buffer.from("longer-than-original")]) {
    const store = new MemoryStorage();
    const service = store.service();
    const ticket = await service.begin(owner, input) as UploadTicket;
    store.stage(owner, ticket.uploadId, uploaded);
    await assert.rejects(service.complete(owner, ticket.uploadId), rejects(409));
    assert.equal(store.media.size, 0);
    assert.equal(store.originals.size, 0);
    assert.equal(store.snapshots.size, 0);
  }
  await assert.rejects(verifyStream(stream(data), data.length + 1, sha256), rejects(409));
  await assert.rejects(verifyStream(stream(data), data.length - 1, sha256), rejects(409));
  await assert.rejects(verifyStream(stream(data), data.length, "0".repeat(64)), rejects(409));
});

test("missing uploads and oversized stored originals fail before reading or promotion", async () => {
  const store = new MemoryStorage();
  const service = store.service();
  const ticket = await service.begin(owner, input) as UploadTicket;
  await assert.rejects(service.complete(owner, ticket.uploadId), rejects(409));
  store.snapshot = async () => ({ blobName: "staging", snapshot: "oversized", size: MAX_MEDIA_SIZE + 1 });
  await assert.rejects(service.complete(owner, ticket.uploadId), rejects(413));
  assert.ok(!store.calls.includes("read"));
  assert.equal(store.originals.size, 0);
});

test("cross-user renew, completion, dedup, gallery, and cursors are isolated", async () => {
  const store = new MemoryStorage();
  const service = store.service();
  const ticket = await service.begin(owner, input) as UploadTicket;
  await assert.rejects(service.renew(other, ticket.uploadId), rejects(404));
  await assert.rejects(service.complete(other, ticket.uploadId), rejects(404));
  store.stage(owner, ticket.uploadId, data);
  await service.complete(owner, ticket.uploadId);
  assert.equal((await service.begin(other, input)).duplicate, false);
  assert.deepEqual((await service.gallery(other)).items, []);
  store.marker = "opaque-storage-marker";
  const page = await service.gallery(owner);
  assert.ok(page.nextCursor);
  await assert.rejects(service.gallery(other, page.nextCursor), rejects(400));
  await service.gallery(owner, page.nextCursor);
  assert.ok(store.calls.includes("list:opaque-storage-marker"));
  for (const cursor of ["", "%%%", "e30", "x".repeat(8193)]) {
    await assert.rejects(service.gallery(owner, cursor), rejects(400));
  }
});

test("upload ID validation and persisted ownership are enforced", async () => {
  const store = new MemoryStorage();
  const service = store.service();
  await assert.rejects(service.renew(owner, "../other"), rejects(400));
  const ticket = await service.begin(owner, input) as UploadTicket;
  const saved = store.tickets.get(`${owner}/${ticket.uploadId}`)!;
  store.tickets.set(`${owner}/${ticket.uploadId}`, { ...saved, owner: other });
  await assert.rejects(service.complete(owner, ticket.uploadId), rejects(404));
});

test("SAS renewal capped at ticket age; completed uploads stay idempotent after expiry", async () => {
  let now = Date.UTC(2026, 0, 1);
  const store = new MemoryStorage();
  const service = store.service(() => now);
  const ticket = await service.begin(owner, input) as UploadTicket;
  assert.equal(Date.parse(ticket.expiresAt), now + SAS_LIFETIME_MS);
  now += TICKET_LIFETIME_MS - 1_000;
  assert.equal(Date.parse((await service.renew(owner, ticket.uploadId)).expiresAt), now + 1_000);
  store.stage(owner, ticket.uploadId, data);
  const media = await service.complete(owner, ticket.uploadId);
  now += 1_000;
  await assert.rejects(service.renew(owner, ticket.uploadId), rejects(409));
  assert.deepEqual(await service.complete(owner, ticket.uploadId), media);
  const fresh = await service.begin(other, input) as UploadTicket;
  now += TICKET_LIFETIME_MS;
  await assert.rejects(service.complete(other, fresh.uploadId), rejects(409));
});

test("concurrent duplicate completions use one immutable original and one stable index", async () => {
  const store = new MemoryStorage();
  const service = store.service();
  const first = await service.begin(owner, input) as UploadTicket;
  const second = await service.begin(owner, { ...input, name: "second.jpg" }) as UploadTicket;
  store.stage(owner, first.uploadId, data);
  store.stage(owner, second.uploadId, data);
  const results = await Promise.all([service.complete(owner, first.uploadId), service.complete(owner, second.uploadId)]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(store.media.size, 1);
  assert.equal(store.originals.size, 1);
  assert.equal(store.snapshots.size, 0);
});

test("interrupted verification cleans only its snapshots and can resume from the same staging upload", async () => {
  const store = new MemoryStorage();
  const service = store.service();
  const ticket = await service.begin(owner, input) as UploadTicket;
  store.stage(owner, ticket.uploadId, data);
  const readSnapshot = store.readSnapshot.bind(store);
  store.readSnapshot = async () => (async function* () {
    yield data.subarray(0, 2);
    throw new Error("Simulated interrupted stream");
  })();
  await assert.rejects(service.complete(owner, ticket.uploadId), /interrupted stream/);
  assert.equal(store.snapshots.size, 0);
  assert.equal(store.originals.size, 0);
  assert.equal(store.media.size, 0);
  store.readSnapshot = readSnapshot;
  assert.equal((await service.complete(owner, ticket.uploadId)).id, sha256);
});

test("interruption after promotion leaves no gallery entry and retry reuses immutable canonical data", async () => {
  const store = new MemoryStorage();
  const service = store.service();
  const ticket = await service.begin(owner, input) as UploadTicket;
  store.stage(owner, ticket.uploadId, data);
  const finalize = store.finalize.bind(store);
  store.finalize = async () => { throw new Error("Simulated interrupted finalization"); };
  await assert.rejects(service.complete(owner, ticket.uploadId), /interrupted finalization/);
  assert.equal(store.originals.size, 1);
  assert.equal(store.media.size, 0);
  assert.equal(store.snapshots.size, 0);
  store.finalize = finalize;
  const result = await service.complete(owner, ticket.uploadId);
  assert.equal(result.id, sha256);
  assert.equal(store.originals.size, 1);
  assert.equal(store.media.size, 1);
});

test("lost response after finalization is safely replayed without accessing mutable staging", async () => {
  const store = new MemoryStorage();
  const service = store.service();
  const ticket = await service.begin(owner, input) as UploadTicket;
  store.stage(owner, ticket.uploadId, data);
  const mediaUrls = store.mediaUrls.bind(store);
  store.mediaUrls = async () => { throw new Error("Simulated lost response"); };
  await assert.rejects(service.complete(owner, ticket.uploadId), /lost response/);
  assert.equal(store.media.size, 1);
  assert.equal(store.snapshots.size, 0);
  store.staging.clear();
  store.mediaUrls = mediaUrls;
  const previousCalls = store.calls.length;
  assert.equal((await service.complete(owner, ticket.uploadId)).id, sha256);
  assert.equal(store.calls.length, previousCalls);
});

test("thumbnails must be uploaded, <=1MiB and JPEG including split header/trailer", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01, 0xff, 0xd9]);
  assert.equal(await verifyStream(stream(jpeg), jpeg.length, undefined, true),
    createHash("sha256").update(jpeg).digest("hex"));
  for (const thumbnail of [undefined, Buffer.from("not JPEG"), Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(MAX_THUMBNAIL_SIZE + 1)]) {
    const store = new MemoryStorage();
    const service = store.service();
    const ticket = await service.begin(owner, { ...input, hasThumbnail: true }) as UploadTicket;
    store.stage(owner, ticket.uploadId, data);
    if (thumbnail) store.stage(owner, ticket.uploadId, thumbnail, true);
    await assert.rejects(service.complete(owner, ticket.uploadId), rejects(!thumbnail ? 409 : thumbnail.length > MAX_THUMBNAIL_SIZE ? 413 : 400));
    assert.equal(store.originals.size, 0);
    assert.equal(store.snapshots.size, 0);
  }
  const store = new MemoryStorage();
  const service = store.service();
  const ticket = await service.begin(owner, { ...input, hasThumbnail: true }) as UploadTicket;
  assert.ok(ticket.thumbnailUploadUrl);
  store.stage(owner, ticket.uploadId, data);
  store.stage(owner, ticket.uploadId, jpeg, true);
  assert.ok((await service.complete(owner, ticket.uploadId)).thumbnailUrl);
  assert.equal(store.thumbnails.size, 1);
  const tooLarge = (async function* () { yield Buffer.alloc(MAX_THUMBNAIL_SIZE); yield Buffer.from([1]); })();
  await assert.rejects(verifyStream(tooLarge, undefined, undefined, true), rejects(413));
});
