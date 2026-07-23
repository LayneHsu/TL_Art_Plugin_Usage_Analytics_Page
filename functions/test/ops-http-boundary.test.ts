import assert from "node:assert/strict";
import test from "node:test";

import { PluginAuthError } from "../src/plugin-auth/errors";
import {
  authenticatePluginOpsRequest,
  readPluginOpsBearerToken,
} from "../src/plugin-auth/plugin-ops-http";
import type { VerifiedPluginOpsIdentity } from "../src/plugin-auth/types";

const verified: VerifiedPluginOpsIdentity = {
  actorId: "serviceAccount:requester@example.iam.gserviceaccount.com",
  issuer: "https://accounts.google.com",
  subject: "ops-subject",
  email: "requester@example.iam.gserviceaccount.com",
};

test("requires one plugin-ops bearer token and rejects trusted-header spoofing", async () => {
  assert.equal(
    readPluginOpsBearerToken({ authorization: "Bearer google-ops-token" }),
    "google-ops-token",
  );
  for (const headers of [
    {},
    { authorization: "Basic spoof" },
    { authorization: ["Bearer first", "Bearer second"] },
    {
      "x-goog-authenticated-user-email":
        "accounts.google.com:requester@example.iam.gserviceaccount.com",
    },
  ]) {
    await assert.rejects(
      authenticatePluginOpsRequest(headers, { verify: async () => verified }),
      (error: unknown) =>
        error instanceof PluginAuthError &&
        error.code === "OPS_IDENTITY_REQUIRED",
    );
  }
});

test("derives identity only from the verified bearer token", async () => {
  const tokens: string[] = [];
  const identity = await authenticatePluginOpsRequest(
    {
      authorization: "Bearer google-ops-token",
      "x-goog-authenticated-user-email":
        "accounts.google.com:attacker@example.iam.gserviceaccount.com",
    },
    {
      async verify(token) {
        tokens.push(token);
        return verified;
      },
    },
  );
  assert.deepEqual(tokens, ["google-ops-token"]);
  assert.deepEqual(identity, verified);
});
