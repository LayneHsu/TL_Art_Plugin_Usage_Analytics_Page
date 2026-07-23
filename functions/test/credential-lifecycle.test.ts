import assert from "node:assert/strict";
import test from "node:test";

import { PluginAuthError } from "../src/plugin-auth/errors";
import { pairAndIssueDeviceCredential } from "./helpers";

test("prepares a credential rotation without revoking the old credential", async () => {
  const { harness, issued } = await pairAndIssueDeviceCredential();
  const prepared = await harness.credentials.prepareRotation({
    bindingId: issued.bindingId,
    currentCredential: issued.deviceCredential,
  });

  await harness.lease.renew({
    bindingId: issued.bindingId,
    deviceCredential: issued.deviceCredential,
  });
  await assert.rejects(
    harness.lease.renew({
      bindingId: issued.bindingId,
      deviceCredential: prepared.newDeviceCredential,
    }),
    PluginAuthError,
  );
});

test("confirms the saved new credential before invalidating the old credential", async () => {
  const { harness, issued } = await pairAndIssueDeviceCredential();
  const prepared = await harness.credentials.prepareRotation({
    bindingId: issued.bindingId,
    currentCredential: issued.deviceCredential,
  });
  await harness.credentials.confirmRotation({
    bindingId: issued.bindingId,
    rotationId: prepared.rotationId,
    newDeviceCredential: prepared.newDeviceCredential,
  });

  await harness.lease.renew({
    bindingId: issued.bindingId,
    deviceCredential: prepared.newDeviceCredential,
  });
  await assert.rejects(
    harness.lease.renew({
      bindingId: issued.bindingId,
      deviceCredential: issued.deviceCredential,
    }),
    PluginAuthError,
  );
});

test("cancelled or expired rotation leaves the old credential valid", async () => {
  const { harness, issued } = await pairAndIssueDeviceCredential();
  const cancelled = await harness.credentials.prepareRotation({
    bindingId: issued.bindingId,
    currentCredential: issued.deviceCredential,
  });
  await harness.credentials.cancelRotation({
    bindingId: issued.bindingId,
    rotationId: cancelled.rotationId,
    currentCredential: issued.deviceCredential,
  });
  await harness.lease.renew({
    bindingId: issued.bindingId,
    deviceCredential: issued.deviceCredential,
  });

  const expired = await harness.credentials.prepareRotation({
    bindingId: issued.bindingId,
    currentCredential: issued.deviceCredential,
  });
  harness.clock.advance(301_000);
  await assert.rejects(
    harness.credentials.confirmRotation({
      bindingId: issued.bindingId,
      rotationId: expired.rotationId,
      newDeviceCredential: expired.newDeviceCredential,
    }),
    PluginAuthError,
  );
  await harness.lease.renew({
    bindingId: issued.bindingId,
    deviceCredential: issued.deviceCredential,
  });
});

test("never exposes device credentials in stored rotation state", async () => {
  const { harness, issued } = await pairAndIssueDeviceCredential();
  const prepared = await harness.credentials.prepareRotation({
    bindingId: issued.bindingId,
    currentCredential: issued.deviceCredential,
  });
  const stored = JSON.stringify(harness.store.exportForTest());
  assert.doesNotMatch(stored, new RegExp(issued.deviceCredential));
  assert.doesNotMatch(stored, new RegExp(prepared.newDeviceCredential));
});

test("identical rotation confirm retry succeeds after response loss but substitutions fail", async () => {
  const { harness, issued } = await pairAndIssueDeviceCredential();
  const prepared = await harness.credentials.prepareRotation({
    bindingId: issued.bindingId,
    currentCredential: issued.deviceCredential,
  });
  const confirmation = {
    bindingId: issued.bindingId,
    rotationId: prepared.rotationId,
    newDeviceCredential: prepared.newDeviceCredential,
  };
  await harness.credentials.confirmRotation(confirmation);
  await harness.credentials.confirmRotation(confirmation);
  await assert.rejects(
    harness.credentials.confirmRotation({
      ...confirmation,
      newDeviceCredential: `${prepared.newDeviceCredential}tampered`,
    }),
    PluginAuthError,
  );
  await assert.rejects(
    harness.credentials.confirmRotation({
      ...confirmation,
      rotationId: "rot_other",
    }),
    PluginAuthError,
  );
});
