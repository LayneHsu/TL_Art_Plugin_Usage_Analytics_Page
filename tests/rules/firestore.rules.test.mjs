import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
} from "firebase/firestore";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const projectId = "demo-tl-art-tool-usage-analytics";
const now = new Date("2026-07-23T08:00:00.000Z");

function event(overrides = {}) {
  return {
    event_id: "evt-01JZ0000000000000000000000",
    operation_id: "op-01JZ0000000000000000000000",
    tool_key: "asset.image_exporter",
    action_key: "asset.image_exporter.run",
    event_type: "run_succeeded",
    occurred_at: "2026-07-23T08:00:00.000Z",
    result: "succeeded",
    duration_ms: 100,
    plugin_version: "8.0.0",
    ...overrides,
  };
}

function pluginUser(uid, email) {
  return {
    uid,
    email,
    display_name: "Artist",
    avatar_url: "https://lh3.googleusercontent.com/avatar",
    last_login_at: now,
    last_active_at: now,
    plugin_version: "8.0.0",
    updated_at: now,
  };
}

function usageDaily(uid = "plugin-user") {
  return {
    company_date: "2026-07-23",
    uid,
    tool_key: "asset.image_exporter",
    shard: "07",
    events: [event()],
    first_occurred_at: "2026-07-23T08:00:00.000Z",
    last_occurred_at: "2026-07-23T08:00:00.000Z",
    last_result: "succeeded",
    plugin_version: "8.0.0",
    updated_at: now,
  };
}

function errorLog(uid = "plugin-user", eventId = "evt-error-01JZ000000000000000000000") {
  return {
    event_id: eventId,
    uid,
    company_date: "2026-07-23",
    tool_key: "asset.image_exporter",
    action_key: "asset.image_exporter.run",
    occurred_at: "2026-07-23T08:00:00.000Z",
    error_type: "ue_runtime",
    summary: "Asset processing failed.",
    call_site: "asset.image_exporter.run",
    fingerprint: "9a".repeat(32),
    stack: "RuntimeError: processing failed",
    plugin_version: "8.0.0",
  };
}

test("Firestore Spark authorization matrix", async (suite) => {
  const environment = await initializeTestEnvironment({
    projectId,
    firestore: {
      rules: fs.readFileSync(path.join(repositoryRoot, "firestore.rules"), "utf8"),
    },
  });
  suite.after(() => environment.cleanup());

  function databaseFor({ uid, email, verified = true } = {}) {
    if (!uid) return environment.unauthenticatedContext().firestore();
    return environment.authenticatedContext(uid, { email, email_verified: verified }).firestore();
  }

  async function resetData() {
    await environment.clearFirestore();
    await environment.withSecurityRulesDisabled(async (context) => {
      const database = context.firestore();
      await setDoc(doc(database, "portalMembers", "admin@xindong.com"), {
        email: "admin@xindong.com",
        role: "admin",
        enabled: true,
        created_at: now,
        created_by: "admin-user",
        updated_at: now,
        updated_by: "admin-user",
      });
      await setDoc(doc(database, "portalMembers", "viewer@xindong.com"), {
        email: "viewer@xindong.com",
        role: "viewer",
        enabled: true,
        created_at: now,
        created_by: "admin-user",
        updated_at: now,
        updated_by: "admin-user",
      });
      await setDoc(doc(database, "portalMembers", "disabled@xindong.com"), {
        email: "disabled@xindong.com",
        role: "viewer",
        enabled: false,
        created_at: now,
        created_by: "admin-user",
        updated_at: now,
        updated_by: "admin-user",
      });
      await setDoc(doc(database, "portalMembers", "snkhtm@gmail.com"), {
        email: "snkhtm@gmail.com",
        role: "admin",
        enabled: true,
        created_at: now,
        created_by: "firebase-owner",
        updated_at: now,
        updated_by: "firebase-owner",
      });
      await setDoc(doc(database, "pluginUsers", "plugin-user"), pluginUser("plugin-user", "artist@xindong.com"));
      await setDoc(doc(database, "usageDaily", "2026-07-23_plugin-user_asset.image_exporter_07"), usageDaily());
      await setDoc(doc(database, "errorLogs", "evt-error-01JZ000000000000000000000"), errorLog());
    });
  }

  await suite.test("company plugin account can write only its own records", async () => {
    await resetData();
    const plugin = databaseFor({ uid: "plugin-user", email: "artist@xindong.com" });
    await assertSucceeds(getDoc(doc(plugin, "pluginUsers", "plugin-user")));
    await assertSucceeds(setDoc(doc(plugin, "pluginUsers", "plugin-user"), pluginUser("plugin-user", "artist@xindong.com")));
    await assertFails(setDoc(doc(plugin, "pluginUsers", "other-user"), pluginUser("other-user", "other@xindong.com")));
    await assertSucceeds(setDoc(doc(plugin, "usageDaily", "2026-07-23_plugin-user_asset.image_exporter_07"), usageDaily()));
    await assertFails(setDoc(doc(plugin, "usageDaily", "2026-07-23_other-user_asset.image_exporter_07"), usageDaily("other-user")));
    await assertSucceeds(setDoc(doc(plugin, "errorLogs", "evt-new-01JZ000000000000000000000"), errorLog("plugin-user", "evt-new-01JZ000000000000000000000")));
    await assertFails(setDoc(doc(plugin, "errorLogs", "evt-other-01JZ00000000000000000000"), errorLog("other-user")));
    await assertFails(setDoc(doc(plugin, "errorLogs", "evt-cross-01JZ000000000000000000000"), {
      ...errorLog("plugin-user", "evt-cross-01JZ000000000000000000000"),
      action_key: "other_tool.run",
    }));
  });

  await suite.test("plugin clients cannot read statistics or portal membership", async () => {
    await resetData();
    const plugin = databaseFor({ uid: "plugin-user", email: "artist@xindong.com" });
    for (const [collectionName, id] of [
      ["usageDaily", "2026-07-23_plugin-user_asset.image_exporter_07"],
      ["errorLogs", "evt-error-01JZ000000000000000000000"],
      ["portalMembers", "viewer@xindong.com"],
    ]) {
      await assertFails(getDoc(doc(plugin, collectionName, id)));
    }
    await assertFails(getDocs(collection(plugin, "usageDaily")));
  });

  await suite.test("unverified, non-company, and unauthenticated accounts cannot write", async () => {
    await resetData();
    for (const database of [
      databaseFor(),
      databaseFor({ uid: "gmail-user", email: "artist@gmail.com" }),
      databaseFor({ uid: "unverified-user", email: "artist@xindong.com", verified: false }),
    ]) {
      await assertFails(setDoc(doc(database, "pluginUsers", "plugin-user"), pluginUser("plugin-user", "artist@xindong.com")));
      await assertFails(setDoc(doc(database, "usageDaily", "2026-07-23_plugin-user_asset.image_exporter_07"), usageDaily()));
      await assertFails(setDoc(doc(database, "errorLogs", "evt-new-01JZ000000000000000000000"), errorLog()));
    }
  });

  await suite.test("viewer can read all four collections but cannot mutate data or members", async () => {
    await resetData();
    const viewer = databaseFor({ uid: "viewer-user", email: "viewer@xindong.com" });
    for (const [collectionName, id] of [
      ["pluginUsers", "plugin-user"],
      ["usageDaily", "2026-07-23_plugin-user_asset.image_exporter_07"],
      ["errorLogs", "evt-error-01JZ000000000000000000000"],
      ["portalMembers", "viewer@xindong.com"],
    ]) {
      await assertSucceeds(getDoc(doc(viewer, collectionName, id)));
    }
    await assertFails(getDoc(doc(viewer, "portalMembers", "admin@xindong.com")));
    await assertFails(getDocs(collection(viewer, "portalMembers")));
    await assertSucceeds(getDocs(collection(viewer, "usageDaily")));
    await assertFails(setDoc(doc(viewer, "portalMembers", "new@xindong.com"), { email: "new@xindong.com", role: "viewer", enabled: true }));
    await assertFails(updateDoc(doc(viewer, "usageDaily", "2026-07-23_plugin-user_asset.image_exporter_07"), { last_result: "failed" }));
    await assertFails(deleteDoc(doc(viewer, "usageDaily", "2026-07-23_plugin-user_asset.image_exporter_07")));
    await assertFails(deleteDoc(doc(viewer, "errorLogs", "evt-error-01JZ000000000000000000000")));
  });

  await suite.test("admin can delete analytics documents for manual cleanup", async () => {
    await resetData();
    const admin = databaseFor({ uid: "admin-user", email: "admin@xindong.com" });
    await assertSucceeds(deleteDoc(doc(admin, "usageDaily", "2026-07-23_plugin-user_asset.image_exporter_07")));
    await assertSucceeds(deleteDoc(doc(admin, "errorLogs", "evt-error-01JZ000000000000000000000")));
  });

  await suite.test("admin can maintain other members but cannot lock or demote itself", async () => {
    await resetData();
    const admin = databaseFor({ uid: "admin-user", email: "admin@xindong.com" });
    await assertSucceeds(setDoc(doc(admin, "portalMembers", "new@xindong.com"), {
      email: "new@xindong.com", role: "viewer", enabled: true, created_at: now, created_by: "admin-user", updated_at: now, updated_by: "admin-user",
    }));
    await assertSucceeds(updateDoc(doc(admin, "portalMembers", "viewer@xindong.com"), { enabled: false, updated_at: now, updated_by: "admin-user" }));
    await assertSucceeds(deleteDoc(doc(admin, "portalMembers", "viewer@xindong.com")));
    await assertFails(updateDoc(doc(admin, "portalMembers", "admin@xindong.com"), { enabled: false }));
    await assertFails(updateDoc(doc(admin, "portalMembers", "admin@xindong.com"), { role: "viewer" }));
    await assertFails(deleteDoc(doc(admin, "portalMembers", "admin@xindong.com")));
    await assertSucceeds(updateDoc(doc(admin, "portalMembers", "admin@xindong.com"), { updated_at: now, updated_by: "admin-user" }));
  });

  await suite.test("portal Gmail admin can read analytics without becoming a plugin writer", async () => {
    await resetData();
    const admin = databaseFor({ uid: "portal-gmail-admin", email: "snkhtm@gmail.com" });
    await assertSucceeds(getDoc(doc(admin, "usageDaily", "2026-07-23_plugin-user_asset.image_exporter_07")));
    await assertSucceeds(getDocs(collection(admin, "pluginUsers")));
    await assertSucceeds(getDoc(doc(admin, "portalMembers", "snkhtm@gmail.com")));
    await assertSucceeds(setDoc(doc(admin, "portalMembers", "new@xindong.com"), {
      email: "new@xindong.com", role: "viewer", enabled: true, created_at: now, created_by: "portal-gmail-admin", updated_at: now, updated_by: "portal-gmail-admin",
    }));
    await assertFails(setDoc(doc(admin, "pluginUsers", "portal-gmail-admin"), pluginUser("portal-gmail-admin", "snkhtm@gmail.com")));
  });

  await suite.test("usageDaily enforces dimensions, stable shard range, and bounded event arrays", async () => {
    await resetData();
    const plugin = databaseFor({ uid: "plugin-user", email: "artist@xindong.com" });
    const base = "2026-07-23_plugin-user_asset.image_exporter_07";
    const usageReference = (documentId = base) => doc(plugin, "usageDaily", documentId);
    await assertFails(setDoc(usageReference(), { ...usageDaily(), uid: "other-user" }));
    await assertFails(setDoc(usageReference(), { ...usageDaily(), company_date: "2026-07-24" }));
    await assertFails(setDoc(usageReference(), { ...usageDaily(), tool_key: "Unknown.Tool" }));
    await assertFails(setDoc(usageReference("2026-07-23_plugin-user_asset.image_exporter_32"), { ...usageDaily(), shard: "32" }));
    const missingAction = event({});
    delete missingAction.action_key;
    await assertFails(setDoc(usageReference("2026-07-23_plugin-user_asset.image_exporter_08"), { ...usageDaily(), shard: "08", events: [missingAction] }));
    await assertFails(setDoc(usageReference("2026-07-23_plugin-user_asset.image_exporter_10"), { ...usageDaily(), shard: "10", events: [event({ action_key: "other_tool.run" })] }));
    await assertFails(setDoc(usageReference("2026-07-23_plugin-user_asset.image_exporter_11"), {
      ...usageDaily(),
      shard: "11",
      events: [event({ action_key: "assetXimage_exporter.run" })],
    }));
    await assertFails(setDoc(usageReference("2026-07-23_plugin-user_asset.image_exporter_12"), {
      ...usageDaily(),
      shard: "12",
      events: [event({ action_key: "asset-image_exporter.run" })],
    }));
    await assertFails(setDoc(usageReference("2026-07-23_plugin-user_asset.image_exporter_09"), { ...usageDaily(), shard: "09", events: [event({ tool_key: "asset.other_tool" })] }));
    await assertFails(setDoc(usageReference(), { ...usageDaily(), events: Array.from({ length: 501 }, (_, index) => event({ event_id: `evt-${index}` })) }));
    await assertFails(updateDoc(usageReference(), { events: [event({ event_id: "evt-replacement" })], updated_at: now }));
    await assertFails(updateDoc(usageReference(), { events: [], updated_at: now }));
    await assertFails(deleteDoc(usageReference()));
    await assertSucceeds(updateDoc(usageReference(), { events: [event(), event({ event_id: "evt-second" }), event({ event_id: "evt-third" })], updated_at: now }));
  });

  await suite.test("error logs enforce exact action parents and UTF-8 stack bytes", async () => {
    await resetData();
    const plugin = databaseFor({ uid: "plugin-user", email: "artist@xindong.com" });
    const errorReference = (documentId) => doc(plugin, "errorLogs", documentId);
    await assertFails(setDoc(errorReference("evt-dot-boundary-01JZ00000000000000000000"), {
      ...errorLog("plugin-user", "evt-dot-boundary-01JZ00000000000000000000"),
      action_key: "assetXimage_exporter.run",
    }));
    await assertFails(setDoc(errorReference("evt-hyphen-boundary-01JZ000000000000000000"), {
      ...errorLog("plugin-user", "evt-hyphen-boundary-01JZ000000000000000000"),
      action_key: "asset-image_exporter.run",
    }));
    await assertFails(setDoc(errorReference("evt-utf8-stack-01JZ000000000000000000000"), {
      ...errorLog("plugin-user", "evt-utf8-stack-01JZ000000000000000000000"),
      stack: "中".repeat(3000),
    }));
  });

  await suite.test("default deny blocks undeclared collections and disabled members", async () => {
    await resetData();
    const disabled = databaseFor({ uid: "disabled-user", email: "disabled@xindong.com" });
    await assertFails(getDoc(doc(disabled, "usageDaily", "2026-07-23_plugin-user_asset.image_exporter_07")));
    await assertFails(getDoc(doc(disabled, "portalMembers", "disabled@xindong.com")));
    const admin = databaseFor({ uid: "admin-user", email: "admin@xindong.com" });
    await assertFails(getDoc(doc(admin, "undeclaredCollection", "document")));
    await assertFails(setDoc(doc(admin, "undeclaredCollection", "document"), { value: 1 }));
  });
});
