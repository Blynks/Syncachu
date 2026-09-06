import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { QuotaLedger } from "../src/quota.js";
import { ApiError, MAX_THUMBNAIL_SIZE, TICKET_LIFETIME_MS, type StoredMedia, type Ticket } from "../src/types.js";
import { MemoryQuotaStore } from "./quotaMemory.js";
import { MemoryStorage } from "./memory.js";

function ticket(size = 60, owner = "a".repeat(64), hasThumbnail = false): Ticket {
  return { owner, uploadId: randomUUID(), sha256: "b".repeat(64), size, hasThumbnail, name: "photo.jpg", contentType: "image/jpeg", createdAt: new Date().toISOString() };
}
const media = (t: Ticket): StoredMedia => ({ id: t.sha256, name: t.name, size: t.size, contentType: t.contentType, createdAt: t.createdAt });
const status = (code: number) => (error: unknown) => error instanceof ApiError && error.status === code;

test("concurrent reservations from different users share one global limit", async () => {
  const store = new MemoryQuotaStore();
  const first = new QuotaLedger(store, 100);
  const second = new QuotaLedger(store, 100);
  const results = await Promise.allSettled([first.reserve(ticket()), second.reserve(ticket(60, "c".repeat(64)))]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const failure = results.find(result => result.status === "rejected");
  assert.ok(failure?.status === "rejected" && status(507)(failure.reason));
  assert.deepEqual(await first.usage(), { limitBytes: 100, usedBytes: 0, reservedBytes: 60, availableBytes: 40 });
});

test("the default instance limit accepts exactly 1 TB and rejects the next byte", async () => {
  const store = new MemoryQuotaStore(false);
  const ledger = new QuotaLedger(store);
  await ledger.initialize((async function* () {
    yield { owner: "existing-owner", id: "existing-library", bytes: 999_999_999_999 };
  })());
  const lastByte = ticket(1);
  await ledger.reserve(lastByte);
  assert.equal((await ledger.usage()).availableBytes, 0);
  await assert.rejects(ledger.reserve(ticket(1, "c".repeat(64))), status(507));
  await ledger.claim(lastByte);
  await ledger.settle(lastByte, media(lastByte));
  assert.deepEqual(await ledger.usage(), { limitBytes: 1_000_000_000_000, usedBytes: 1_000_000_000_000, reservedBytes: 0, availableBytes: 0 });
  await assert.rejects(ledger.reserve(ticket(1, "c".repeat(64))), status(507));
});

test("reservation is idempotent and includes maximum thumbnail size", async () => {
  const ledger = new QuotaLedger(new MemoryQuotaStore(), MAX_THUMBNAIL_SIZE + 10);
  const t = ticket(10, undefined, true);
  await ledger.reserve(t);
  await ledger.reserve(t);
  assert.equal((await ledger.usage()).availableBytes, 0);
  await assert.rejects(ledger.reserve(ticket(1)), status(507));
  await ledger.claim(t);
  await ledger.settle(t, { ...media(t), thumbnailKey: "private.jpg", thumbnailSize: 7 });
  assert.deepEqual(await ledger.usage(), { limitBytes: MAX_THUMBNAIL_SIZE + 10, usedBytes: 17, reservedBytes: 0, availableBytes: MAX_THUMBNAIL_SIZE - 7 });
});

test("duplicate completions count media once and release both reservations", async () => {
  const ledger = new QuotaLedger(new MemoryQuotaStore(), 120);
  const a = ticket(), b = ticket();
  await ledger.reserve(a); await ledger.reserve(b);
  await ledger.claim(a); await ledger.claim(b);
  await Promise.all([ledger.settle(a, media(a)), ledger.settle(b, media(b))]);
  await ledger.settle(a, media(a));
  assert.deepEqual(await ledger.usage(), { limitBytes: 120, usedBytes: 60, reservedBytes: 0, availableBytes: 60 });
});

test("identical content under different owners counts both private copies", async () => {
  const ledger = new QuotaLedger(new MemoryQuotaStore(), 120);
  for (const t of [ticket(), ticket(60, "c".repeat(64))]) {
    await ledger.reserve(t); await ledger.claim(t); await ledger.settle(t, media(t));
  }
  assert.equal((await ledger.usage()).usedBytes, 120);
});

test("expiry reclaims abandoned reservations but never an unaccounted publication", async () => {
  let now = Date.now();
  const ledger = new QuotaLedger(new MemoryQuotaStore(), 120, () => now);
  const pending = ticket(), publishing = ticket();
  await ledger.reserve(pending); await ledger.reserve(publishing);
  await ledger.claim(publishing);
  now += TICKET_LIFETIME_MS + 1;
  await ledger.expireReservations();
  await ledger.expireReservations();
  assert.equal((await ledger.usage()).reservedBytes, 60);
  await assert.rejects(ledger.claim(pending), status(409));
  await assert.rejects(ledger.check(pending), status(409));
  await ledger.settle(publishing, media(publishing));
  assert.equal((await ledger.usage()).usedBytes, 60);
  assert.equal((await ledger.usage()).reservedBytes, 0);
});

test("claim and expiration race cannot publish without a counted reservation", async () => {
  const store = new MemoryQuotaStore();
  let now = Date.now();
  const ledger = new QuotaLedger(store, 100, () => now);
  const t = ticket();
  await ledger.reserve(t);
  now += TICKET_LIFETIME_MS;
  await Promise.all([assert.rejects(ledger.claim(t), status(409)), ledger.expireReservations()]);
  assert.equal((await ledger.usage()).reservedBytes, 0);
});

test("an abandoned duplicate publication is reclaimed only after its canonical media is charged", async () => {
  let now = Date.now();
  const ledger = new QuotaLedger(new MemoryQuotaStore(), 120, () => now);
  const abandoned = ticket(), completed = ticket();
  await ledger.reserve(abandoned); await ledger.claim(abandoned);
  await ledger.reserve(completed); await ledger.claim(completed);
  await ledger.settle(completed, media(completed));
  assert.equal((await ledger.usage()).reservedBytes, 60);
  now += TICKET_LIFETIME_MS + 1;
  await ledger.expireReservations();
  assert.equal((await ledger.usage()).reservedBytes, 0);
  assert.equal((await ledger.usage()).usedBytes, 60);
});

test("lost transaction response can be retried without double charging", async () => {
  const store = new MemoryQuotaStore();
  const ledger = new QuotaLedger(store, 100);
  const t = ticket();
  await ledger.reserve(t); await ledger.claim(t);
  const transact = store.transact.bind(store);
  store.transact = async changes => { await transact(changes); throw new Error("Response lost"); };
  await assert.rejects(ledger.settle(t, media(t)), /Response lost/);
  store.transact = transact;
  await ledger.settle(t, media(t));
  assert.equal((await ledger.usage()).usedBytes, 60);
  assert.equal((await ledger.usage()).reservedBytes, 0);
});

test("uninitialized instances fail closed and interrupted imports resume without double counting", async () => {
  const store = new MemoryQuotaStore(false);
  const ledger = new QuotaLedger(store, 100);
  await assert.rejects(ledger.reserve(ticket()), status(503));
  const record = { owner: "a".repeat(64), id: "b".repeat(64), bytes: 80 };
  await assert.rejects(ledger.initialize((async function* () { yield record; throw new Error("Scan interrupted"); })()), /Scan interrupted/);
  await assert.rejects(ledger.usage(), status(503));
  await ledger.initialize((async function* () { yield record; })());
  assert.equal((await ledger.usage()).usedBytes, 80);
  await ledger.initialize((async function* () { throw new Error("Should not rescan a ready instance"); })());
  await assert.rejects(ledger.reserve(ticket()), status(507));
});

test("pre-existing libraries above the limit are accounted, never silently reset", async () => {
  const ledger = new QuotaLedger(new MemoryQuotaStore(false), 100);
  await ledger.initialize((async function* () { yield { owner: "owner", id: "media", bytes: 110 }; })());
  assert.deepEqual(await ledger.usage(), { limitBytes: 100, usedBytes: 110, reservedBytes: 0, availableBytes: 0 });
  await assert.rejects(ledger.reserve(ticket(1)), status(507));
});

test("quota rejection happens before issuing tickets or storage URLs", async () => {
  const storage = new MemoryStorage();
  let issued = false;
  storage.uploadUrls = async () => { issued = true; throw new Error("must not issue"); };
  const t = ticket();
  await assert.rejects(storage.service(Date.now, 50).begin(t.owner, t), status(507));
  assert.equal(storage.tickets.size, 0);
  assert.equal(issued, false);
});

test("storage initialization changes fail closed", async () => {
  const ledger = new QuotaLedger(new MemoryQuotaStore(false), 100);
  const record = { owner: "owner", id: "same", bytes: 60 };
  await assert.rejects(ledger.initialize((async function* () { yield record; yield { ...record, bytes: 61 }; })()), /Catalog changed/);
  await assert.rejects(ledger.usage(), status(503));
});
