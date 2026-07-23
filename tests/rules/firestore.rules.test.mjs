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
  limit,
  query,
  setDoc,
  updateDoc,
} from "firebase/firestore";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "..", "..");
const projectId = "demo-tl-art-tool-usage-analytics";
const protectedCollections = [
  "portalUsers",
  "portalAccessPolicies",
  "portalAuthAudit",
  "portalBootstrapState",
  "pluginPrincipals",
  "pluginDeviceBindings",
  "pluginDevicePairings",
  "pluginAuthAudit",
  "pluginOpsReviews",
  "usageEvents",
  "toolUsageDaily",
  "principalUsageDaily",
  "errorAggregates",
  "deadLetters",
  "usageQuotas",
  "usageOperations",
  "usageReplayApprovals",
  "usageReplayValidationGroups",
  "usageAggregateSourceRevisions",
  "usageReplayJobs",
  "usageReplayLocks",
  "usageReplayAppliedEvents",
  "usageReplayGenerations",
  "usageAggregatePointers",
  "usageRetentionRuns",
  "usageRetentionSchedules",
  "usageRetentionAudit",
  "usageMonitoringCounters",
  "usageMonitoringSnapshots",
  "usageMonitoringAlerts",
  "usageMonitoringNotifications",
  "portalQueryAudit",
];

test("Firestore browser authorization boundaries", async (suite) => {
  const environment = await initializeTestEnvironment({
    projectId,
    firestore: {
      rules: fs.readFileSync(path.join(repositoryRoot, "firestore.rules"), "utf8"),
    },
  });
  suite.after(() => environment.cleanup());

  async function resetData() {
    await environment.clearFirestore();
    await environment.withSecurityRulesDisabled(async (context) => {
      const database = context.firestore();
      await Promise.all([
        setDoc(doc(database, "portalUsers", "visitor"), {
          role: "visitor",
          status: "active",
        }),
        setDoc(doc(database, "portalUsers", "admin"), {
          role: "admin",
          status: "active",
        }),
        setDoc(doc(database, "portalUsers", "disabled"), {
          role: "visitor",
          status: "disabled",
        }),
        setDoc(doc(database, "portalUsers", "other"), {
          role: "visitor",
          status: "active",
        }),
        setDoc(doc(database, "toolUsageDaily", "2026-07-22_asset"), {
          date: "2026-07-22",
          tool_key: "asset.image_exporter",
          usage_count: 1,
        }),
        setDoc(doc(database, "errorAggregates", "2026-07-22_fingerprint"), {
          date: "2026-07-22",
          fingerprint: "9a".repeat(32),
          error_category: "validation",
          count: 1,
        }),
        setDoc(
          doc(
            database,
            "toolUsageDaily",
            "2026-07-22_asset",
            "privateDetails",
            "raw",
          ),
          { plugin_principal_id: "principal-1" },
        ),
        setDoc(
          doc(
            database,
            "errorAggregates",
            "2026-07-22_fingerprint",
            "privateDetails",
            "raw",
          ),
          { traceback: "sensitive" },
        ),
        setDoc(doc(database, "usageEvents", "event-1"), {
          event_type: "run_started",
        }),
        setDoc(doc(database, "principalUsageDaily", "principal-1"), {
          plugin_principal_id: "principal-1",
          usage_count: 1,
        }),
        setDoc(doc(database, "pluginDeviceBindings", "binding-1"), {
          status: "active",
        }),
        ...protectedCollections.map((collectionName) =>
          setDoc(doc(database, collectionName, "browser-existing"), {
            fixture: true,
          }),
        ),
      ]);
    });
  }

  function databaseFor(userId) {
    return userId === null
      ? environment.unauthenticatedContext().firestore()
      : environment.authenticatedContext(userId).firestore();
  }

  await suite.test("portalUsers permits only self get and never list or write", async () => {
    await resetData();
    const visitorDatabase = databaseFor("visitor");
    await assertSucceeds(getDoc(doc(visitorDatabase, "portalUsers", "visitor")));
    for (const userId of ["visitor", "admin"]) {
      await assertFails(
        getDoc(doc(databaseFor(userId), "portalUsers", "other")),
      );
    }
    await assertFails(getDocs(collection(visitorDatabase, "portalUsers")));
    await assertFails(
      updateDoc(doc(visitorDatabase, "portalUsers", "visitor"), { role: "admin" }),
    );
  });

  await suite.test("portal browsers cannot read aggregate collections directly", async () => {
    await resetData();
    for (const userId of ["visitor", "admin"]) {
      const database = databaseFor(userId);
      await assertFails(
        getDoc(doc(database, "toolUsageDaily", "2026-07-22_asset")),
      );
      await assertFails(
        getDoc(doc(database, "errorAggregates", "2026-07-22_fingerprint")),
      );
      await assertFails(getDoc(doc(database, "usageEvents", "event-1")));
      await assertFails(
        getDoc(doc(database, "principalUsageDaily", "principal-1")),
      );
      await assertFails(
        getDoc(doc(database, "pluginDeviceBindings", "binding-1")),
      );
      await assertFails(getDocs(collection(database, "portalUsers")));
    }
  });

  await suite.test("error aggregate list queries are denied even when bounded", async () => {
    await resetData();
    const database = databaseFor("visitor");
    const toolAggregates = collection(database, "toolUsageDaily");
    await assertFails(getDocs(query(toolAggregates, limit(100))));
    const errorAggregates = collection(database, "errorAggregates");
    await assertFails(getDocs(query(errorAggregates, limit(101))));
    await assertFails(getDocs(errorAggregates));
    await assertFails(getDocs(query(errorAggregates, limit(100))));
  });

  await suite.test("aggregate access never includes nested subcollections", async () => {
    await resetData();
    for (const userId of ["visitor", "admin"]) {
      const database = databaseFor(userId);
      await assertFails(
        getDoc(
          doc(
            database,
            "toolUsageDaily",
            "2026-07-22_asset",
            "privateDetails",
            "raw",
          ),
        ),
      );
      await assertFails(
        getDoc(
          doc(
            database,
            "errorAggregates",
            "2026-07-22_fingerprint",
            "privateDetails",
            "raw",
          ),
        ),
      );
    }
  });

  await suite.test("unauthenticated, unauthorized, and disabled users cannot read aggregates", async () => {
    await resetData();
    for (const userId of [null, "unauthorized", "disabled"]) {
      const database = databaseFor(userId);
      await assertFails(
        getDoc(doc(database, "toolUsageDaily", "2026-07-22_asset")),
      );
      await assertFails(
        getDoc(doc(database, "errorAggregates", "2026-07-22_fingerprint")),
      );
    }
  });

  await suite.test("browser clients cannot write protected collections", async () => {
    await resetData();
    for (const userId of [null, "visitor", "admin", "disabled"]) {
      const database = databaseFor(userId);
      for (const collectionName of protectedCollections) {
        await assertFails(
          setDoc(doc(database, collectionName, "browser-write"), {
            role: "admin",
            value: 1,
          }),
        );
      }
    }

    const adminDatabase = databaseFor("admin");
    for (const collectionName of protectedCollections) {
      await assertFails(
        updateDoc(doc(adminDatabase, collectionName, "browser-existing"), {
          fixture: false,
        }),
      );
      await assertFails(
        deleteDoc(doc(adminDatabase, collectionName, "browser-existing")),
      );
    }
  });

  await suite.test("default deny blocks undeclared collections", async () => {
    await resetData();
    const database = databaseFor("admin");
    await assertFails(getDoc(doc(database, "undeclaredCollection", "document")));
    await assertFails(
      setDoc(doc(database, "undeclaredCollection", "document"), { value: 1 }),
    );
    assert.ok(true);
  });
});
