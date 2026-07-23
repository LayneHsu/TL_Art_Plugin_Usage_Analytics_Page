import assert from "node:assert/strict";
import test from "node:test";

import { pluginPrincipalProfile } from "../src/plugin-auth/principal-service";
import type { PluginPrincipalRecord } from "../src/plugin-auth/types";

const basePrincipal: PluginPrincipalRecord = {
  principalId: "pp_test",
  issuer: "https://accounts.google.com",
  subject: "subject-test",
  email: "artist@xd.com",
  displayName: "Artist",
  avatarUrl: "https://images.example/artist.png",
  enabled: true,
  createdAt: new Date("2026-07-22T02:00:00.000Z"),
  profileUpdatedAt: new Date("2026-07-22T02:00:00.000Z"),
  disabledAt: null,
  disabledReason: null,
};

test("profile projection safely nulls malformed profileUpdatedAt values", () => {
  const malformedValues: unknown[] = [
    "2026-07-22T02:00:00.000Z",
    {},
    null,
    undefined,
    new Date("not-a-date"),
  ];
  for (const value of malformedValues) {
    const principal = {
      ...basePrincipal,
      profileUpdatedAt: value as Date,
    };
    assert.doesNotThrow(() => pluginPrincipalProfile(principal));
    assert.equal(pluginPrincipalProfile(principal).profile_updated_at, null);
  }
});
