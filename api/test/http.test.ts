import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import functions from "@azure/functions";
import { createHandler, type Dependencies } from "../src/http.js";
import { ApiError } from "../src/types.js";
import type { MediaItem, UploadTicket } from "../src/types.js";
import { MemoryStorage } from "./memory.js";

const { HttpRequest } = functions;
function request(body: string, headers: Record<string, string> = { "content-type": "application/json" }) {
  return new HttpRequest({ method: "POST", url: "https://api.test/api/uploads", headers, body: { string: body } });
}

test("every protected route authenticates before body parsing or storage calls", async () => {
  for (const route of ["begin", "renew", "complete", "gallery", "usage"] as const) {
    let accessed = false;
    const handler = createHandler(route, () => ({
      authenticate: async () => { throw new ApiError(401, "Unauthorized"); },
      service: async () => { accessed = true; throw new Error("must not happen"); },
    }));
    const req = request("not json");
    const response = await handler(req);
    assert.equal(response.status, 401);
    assert.equal(req.bodyUsed, false);
    assert.equal(accessed, false);
    assert.deepEqual(response.jsonBody, { error: "Unauthorized" });
  }
});

test("request JSON, content type and streamed body size are bounded after authentication", async () => {
  const dependencies: Dependencies = {
    authenticate: async () => "owner",
    service: async () => new MemoryStorage().service(),
  };
  const handler = createHandler("begin", () => dependencies);
  assert.equal((await handler(request("not json"))).status, 400);
  assert.equal((await handler(request("{}", { "content-type": "text/plain" }))).status, 400);
  assert.equal((await handler(request("{}", { "content-type": "application/json", "content-length": "20000" }))).status, 413);
  assert.equal((await handler(request("x".repeat(16385)))).status, 413);
  assert.equal((await createHandler("complete", () => dependencies)(request('{"extra":true}'))).status, 400);
});

test("unexpected errors are sanitized without exposing tokens or storage internals", async () => {
  const response = await createHandler("gallery", () => ({
    authenticate: async () => "owner",
    service: async () => { throw new Error("sensitive internal url and token"); },
  }))(new HttpRequest({ method: "GET", url: "https://api.test/api/media" }));
  assert.equal(response.status, 500);
  assert.deepEqual(response.jsonBody, { error: "Internal server error" });
  assert.deepEqual(response.headers, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
});

test("HTTP upload, renewal, completion and gallery preserve the shared API contract", async () => {
  const store = new MemoryStorage();
  const dependencies: Dependencies = { authenticate: async () => "owner", service: async () => store.service() };
  const data = Buffer.from("photo-content");
  const body = {
    sha256: createHash("sha256").update(data).digest("hex"), size: data.length,
    name: "photo.jpg", contentType: "image/jpeg", hasThumbnail: false,
  };
  const begun = await createHandler("begin", () => dependencies)(request(JSON.stringify(body)));
  assert.equal(begun.status, 200);
  const ticket = begun.jsonBody as UploadTicket;
  assert.equal(ticket.duplicate, false);
  const renewRequest = new HttpRequest({
    method: "POST", url: `https://api.test/api/uploads/${ticket.uploadId}/renew`, params: { uploadId: ticket.uploadId },
  });
  const renewed = await createHandler("renew", () => dependencies)(renewRequest);
  assert.equal(renewed.status, 200);
  assert.equal((renewed.jsonBody as UploadTicket).uploadId, ticket.uploadId);
  store.stage("owner", ticket.uploadId, data);
  const completed = await createHandler("complete", () => dependencies)(new HttpRequest({
    method: "POST", url: `https://api.test/api/uploads/${ticket.uploadId}/complete`,
    headers: { "content-type": "application/json" }, body: { string: "{}" }, params: { uploadId: ticket.uploadId },
  }));
  assert.equal(completed.status, 200);
  assert.equal((completed.jsonBody as MediaItem).id, body.sha256);
  const gallery = await createHandler("gallery", () => dependencies)(new HttpRequest({
    method: "GET", url: "https://api.test/api/media",
  }));
  assert.equal(gallery.status, 200);
  assert.deepEqual(gallery.jsonBody, { items: [completed.jsonBody] });
  const duplicate = await createHandler("begin", () => dependencies)(request(JSON.stringify(body)));
  assert.deepEqual(duplicate.jsonBody, { duplicate: true, media: completed.jsonBody });
  const usage = await createHandler("usage", () => dependencies)(new HttpRequest({ method: "GET", url: "https://api.test/api/usage" }));
  assert.equal(usage.status, 200);
  assert.deepEqual(usage.jsonBody, { limitBytes: 1_000_000_000_000, usedBytes: data.length, reservedBytes: 0, availableBytes: 1_000_000_000_000 - data.length });
});

test("unapproved accounts are forbidden before any cloud access", async () => {
  for (const route of ["begin", "renew", "complete", "gallery", "usage"] as const) {
    let accessed = false;
    const response = await createHandler(route, () => ({
      authenticate: async () => { throw new ApiError(403, "Account not approved"); },
      service: async () => { accessed = true; return new MemoryStorage().service(); },
    }))(request("{}"));
    assert.equal(response.status, 403);
    assert.equal(accessed, false);
  }
});
