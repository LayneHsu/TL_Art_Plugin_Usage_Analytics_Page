import assert from "node:assert/strict";
import test from "node:test";

import { PluginAuthError } from "../src/plugin-auth/errors";
import { GooglePluginOidcExchange } from "../src/plugin-auth/google-oidc";

const validClaims = {
  iss: "https://accounts.google.com",
  aud: "plugin-oauth-client-id",
  sub: "google-subject",
  nonce: "expected-nonce",
  email: "artist@xd.com",
  email_verified: true,
  name: "Artist",
  picture: "https://images.example/artist.png",
};

function createInjectedExchange(payload: Record<string, unknown> | undefined) {
  const authorizationCalls: Record<string, unknown>[] = [];
  const tokenCalls: Record<string, unknown>[] = [];
  const verificationCalls: Record<string, unknown>[] = [];
  const exchange = new GooglePluginOidcExchange({
    clientId: "plugin-oauth-client-id",
    clientSecret: "test-client-secret",
    callbackUri: "https://analytics.example/plugin/pair/callback",
    oauthClient: {
      generateAuthUrl(options) {
        authorizationCalls.push(options);
        return "https://accounts.google.com/o/oauth2/v2/auth";
      },
      async getToken(options) {
        tokenCalls.push(options);
        return { tokens: { id_token: "google-id-token" } };
      },
      async verifyIdToken(options) {
        verificationCalls.push(options);
        return { getPayload: () => payload };
      },
    },
  });
  return { exchange, authorizationCalls, tokenCalls, verificationCalls };
}

test("Google pairing adapter constructs PKCE authorization and token requests", async () => {
  const injected = createInjectedExchange(validClaims);
  injected.exchange.createAuthorizationUrl({
    state: "oauth-state",
    nonce: "expected-nonce",
    pkceChallenge: "pkce-challenge",
  });
  const identity = await injected.exchange.exchangeAndVerify({
    authorizationCode: "authorization-code",
    pkceVerifier: "pkce-verifier",
    callbackUri: "https://analytics.example/plugin/pair/callback",
    expectedNonce: "expected-nonce",
    expectedAudience: "plugin-oauth-client-id",
    allowedIssuers: ["https://accounts.google.com"],
    companyDomain: "xd.com",
  });
  assert.equal(identity.email, "artist@xd.com");
  assert.deepEqual(injected.tokenCalls, [
    {
      code: "authorization-code",
      codeVerifier: "pkce-verifier",
      redirect_uri: "https://analytics.example/plugin/pair/callback",
    },
  ]);
  assert.deepEqual(injected.verificationCalls, [
    { idToken: "google-id-token", audience: "plugin-oauth-client-id" },
  ]);
  assert.deepEqual(injected.authorizationCalls[0], {
    access_type: "online",
    prompt: "select_account",
    scope: ["openid", "email", "profile"],
    state: "oauth-state",
    code_challenge: "pkce-challenge",
    code_challenge_method: "S256",
    nonce: "expected-nonce",
    include_granted_scopes: false,
  });
});

for (const [label, patch] of [
  ["issuer", { iss: "https://securetoken.google.com/project" }],
  ["audience", { aud: "portal-firebase-client" }],
  ["nonce", { nonce: "substituted-nonce" }],
  ["email verification", { email_verified: false }],
  ["company domain", { email: "artist@outside.example" }],
] as const) {
  test(`Google pairing adapter rejects invalid ${label}`, async () => {
    const { exchange } = createInjectedExchange({ ...validClaims, ...patch });
    await assert.rejects(
      exchange.exchangeAndVerify({
        authorizationCode: "authorization-code",
        pkceVerifier: "pkce-verifier",
        callbackUri: "https://analytics.example/plugin/pair/callback",
        expectedNonce: "expected-nonce",
        expectedAudience: "plugin-oauth-client-id",
        allowedIssuers: ["https://accounts.google.com"],
        companyDomain: "xd.com",
      }),
      (error: unknown) =>
        error instanceof PluginAuthError &&
        error.code === "COMPANY_IDENTITY_REJECTED",
    );
  });
}

test("Google pairing adapter rejects a missing ID token", async () => {
  const exchange = new GooglePluginOidcExchange({
    clientId: "plugin-oauth-client-id",
    clientSecret: "test-client-secret",
    callbackUri: "https://analytics.example/plugin/pair/callback",
    oauthClient: {
      generateAuthUrl: () => "https://accounts.google.com/o/oauth2/v2/auth",
      async getToken() {
        return { tokens: {} };
      },
      async verifyIdToken() {
        throw new Error("must not verify");
      },
    },
  });
  await assert.rejects(
    exchange.exchangeAndVerify({
      authorizationCode: "authorization-code",
      pkceVerifier: "pkce-verifier",
      callbackUri: "https://analytics.example/plugin/pair/callback",
      expectedNonce: "expected-nonce",
      expectedAudience: "plugin-oauth-client-id",
      allowedIssuers: ["https://accounts.google.com"],
      companyDomain: "xd.com",
    }),
    PluginAuthError,
  );
});
