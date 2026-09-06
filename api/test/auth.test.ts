import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { createAuthenticator } from "../src/auth.js";
import { ApiError } from "../src/types.js";

const keys = await generateKeyPair("RS256");
const jwk = await exportJWK(keys.publicKey);
const authenticate = createAuthenticator(["client-one", "client-two"], ["owner@example.com"], createLocalJWKSet({ keys: [{ ...jwk, kid: "google-test", alg: "RS256" }] }));
const valid: JWTPayload = {
  sub: "google-subject", iss: "https://accounts.google.com", aud: "client-one",
  exp: Math.floor(Date.now() / 1000) + 3600,
  email: "owner@example.com", email_verified: true,
};
const header = (token: string) => ["Bearer", token].join(" ");
async function token(payload: JWTPayload) {
  return new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: "google-test" }).sign(keys.privateKey);
}
const unauthorized = (error: unknown) => error instanceof ApiError && error.status === 401 && error.message === "Unauthorized";

test("Google ID token verifies signature, audience, issuer and uses stable normalized subject namespace", async () => {
  const owner = await authenticate(header(await token(valid)));
  assert.match(owner, /^[a-f0-9]{64}$/);
  assert.equal(await authenticate(header(await token({ ...valid, iss: "accounts.google.com", aud: "client-two" }))), owner);
  assert.notEqual(await authenticate(header(await token({ ...valid, sub: "another-user" }))), owner);
});

test("native hybrid tokens may have a different trusted azp and a single Web-client audience", async () => {
  const withoutPresenter = await authenticate(header(await token(valid)));
  const hybrid = await authenticate(header(await token({ ...valid, aud: "client-one", azp: "client-two" })));
  assert.equal(hybrid, withoutPresenter);
  const webAudienceOnly = createAuthenticator(["client-one"], ["owner@example.com"], createLocalJWKSet({
    keys: [{ ...jwk, kid: "google-test", alg: "RS256" }],
  }));
  await assert.rejects(webAudienceOnly(header(await token({ ...valid, aud: "client-one", azp: "client-two" }))), unauthorized);
});

test("invalid or absent expiration, subject, issuer, audience and authorized-party are rejected", async () => {
  const invalid: JWTPayload[] = [
    { ...valid, exp: Math.floor(Date.now() / 1000) - 1 },
    { ...valid, sub: "" }, { ...valid, sub: " " }, { ...valid, sub: "s".repeat(256) },
    { ...valid, iss: "https://attacker.test" }, { ...valid, aud: "wrong-client" },
    { ...valid, azp: "attacker" }, { ...valid, aud: ["client-one", "client-two"] },
    { ...valid, nbf: Math.floor(Date.now() / 1000) + 1000 },
  ];
  for (const claim of ["exp", "sub", "iss", "aud"]) {
    const payload = { ...valid };
    delete payload[claim];
    invalid.push(payload);
  }
  for (const payload of invalid) await assert.rejects(authenticate(header(await token(payload))), unauthorized);
  assert.ok(await authenticate(header(await token({ ...valid, aud: ["client-one", "client-two"], azp: "client-one" }))));
});

test("missing, malformed, oversized, wrong-signature and wrong-algorithm tokens reject", async () => {
  for (const value of [null, "", "Basic abc", header("garbage"), header("x".repeat(8193)), `${header("x")} extra`]) {
    await assert.rejects(authenticate(value), unauthorized);
  }
  const wrongKeys = await generateKeyPair("RS256");
  const wrong = await new SignJWT(valid).setProtectedHeader({ alg: "RS256", kid: "google-test" }).sign(wrongKeys.privateKey);
  await assert.rejects(authenticate(header(wrong)), unauthorized);
  const hmac = await new SignJWT(valid).setProtectedHeader({ alg: "HS256" }).sign(Buffer.alloc(32, 1));
  await assert.rejects(authenticate(header(hmac)), unauthorized);
  assert.throws(() => createAuthenticator([], ["owner@example.com"]));
  assert.throws(() => createAuthenticator(["*"], ["owner@example.com"]));
});

test("private beta allows only explicitly approved verified emails", async () => {
  assert.ok(await authenticate(header(await token({ ...valid, email: "OWNER@EXAMPLE.COM" }))));
  for (const patch of [
    { email: "stranger@example.com" }, { email: undefined }, { email_verified: false }, { email_verified: "true" },
  ]) {
    await assert.rejects(authenticate(header(await token({ ...valid, ...patch }))),
      (error: unknown) => error instanceof ApiError && error.status === 403);
  }
  assert.throws(() => createAuthenticator(["client-one"], []));
  assert.throws(() => createAuthenticator(["client-one"], ["*@example.com"]));
  assert.throws(() => createAuthenticator(["client-one"], [""]));
});
