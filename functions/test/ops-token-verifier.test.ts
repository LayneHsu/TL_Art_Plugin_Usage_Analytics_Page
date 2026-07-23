import assert from "node:assert/strict";
import test from "node:test";

import { PluginAuthError } from "../src/plugin-auth/errors";
import {
  GooglePluginOpsTokenVerifier,
  verifyPluginOpsClaims,
} from "../src/plugin-auth/plugin-ops-identity";

const expected = {
  audience: "plugin-ops-audience",
  allowedIssuers: ["https://accounts.google.com"],
  allowedServiceAccounts: [
    "requester@example.iam.gserviceaccount.com",
    "approver@example.iam.gserviceaccount.com",
  ],
};

test("derives plugin ops actor only from verified allowlisted Google claims", () => {
  const identity = verifyPluginOpsClaims(
    {
      iss: "https://accounts.google.com",
      aud: "plugin-ops-audience",
      sub: "immutable-ops-subject",
      email: "requester@example.iam.gserviceaccount.com",
      email_verified: true,
    },
    expected,
  );
  assert.equal(
    identity.actorId,
    "serviceAccount:requester@example.iam.gserviceaccount.com",
  );
});

for (const [label, patch] of [
  ["portal audience", { aud: "portal-firebase-client" }],
  ["issuer", { iss: "https://securetoken.google.com/project" }],
  ["allowlist", { email: "portal-admin@xd.com" }],
  ["verification", { email_verified: false }],
] as const) {
  test(`rejects ops token with wrong ${label}`, () => {
    assert.throws(
      () =>
        verifyPluginOpsClaims(
          {
            iss: "https://accounts.google.com",
            aud: "plugin-ops-audience",
            sub: "ops-subject",
            email: "requester@example.iam.gserviceaccount.com",
            email_verified: true,
            ...patch,
          },
          expected,
        ),
      (error: unknown) =>
        error instanceof PluginAuthError && error.code === "OPS_IDENTITY_REQUIRED",
    );
  });
}

test("Google ops verifier validates the bearer token with the plugin-ops audience", async () => {
  const calls: unknown[] = [];
  const verifier = new GooglePluginOpsTokenVerifier({
    tokenVerifier: {
      async verifyIdToken(input) {
        calls.push(input);
        return {
          getPayload: () => ({
            iss: "https://accounts.google.com",
            aud: "plugin-ops-audience",
            sub: "ops-subject",
            email: "requester@example.iam.gserviceaccount.com",
            email_verified: true,
          }),
        };
      },
    },
    ...expected,
  });
  await verifier.verify("google-signed-ops-token");
  assert.deepEqual(calls, [
    { idToken: "google-signed-ops-token", audience: "plugin-ops-audience" },
  ]);
});
