import assert from "node:assert/strict";
import test from "node:test";

import { PluginAuthError } from "../src/plugin-auth/errors";
import { validateOidcClaims } from "../src/plugin-auth/oidc-validation";

const expected = {
  allowedIssuers: ["https://accounts.google.com"],
  audience: "plugin-oauth-client-id",
  nonce: "expected-nonce",
  companyDomain: "xd.com",
};

const validClaims = {
  iss: "https://accounts.google.com",
  sub: "immutable-subject",
  aud: "plugin-oauth-client-id",
  nonce: "expected-nonce",
  email: "artist@xd.com",
  email_verified: true,
  name: "Artist",
  picture: "https://images.example/artist.png",
};

test("validates plugin-specific issuer, audience, nonce, verified email, and company domain", () => {
  const identity = validateOidcClaims(validClaims, expected);
  assert.deepEqual(identity, {
    issuer: validClaims.iss,
    subject: validClaims.sub,
    email: validClaims.email,
    emailVerified: true,
    displayName: validClaims.name,
    avatarUrl: validClaims.picture,
  });
});

for (const [name, patch] of [
  ["issuer", { iss: "https://attacker.example" }],
  ["audience", { aud: "portal-firebase-client-id" }],
  ["nonce", { nonce: "replayed-nonce" }],
  ["email verification", { email_verified: false }],
  ["company domain", { email: "artist@example.com" }],
] as const) {
  test(`rejects an invalid ${name}`, () => {
    assert.throws(
      () => validateOidcClaims({ ...validClaims, ...patch }, expected),
      (error: unknown) =>
        error instanceof PluginAuthError &&
        error.publicMessage === "Company account verification failed",
    );
  });
}
