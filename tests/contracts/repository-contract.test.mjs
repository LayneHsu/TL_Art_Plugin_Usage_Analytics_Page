import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "..", "..");

function readText(relativePath) {
  return fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

test("documents the data, auth, redaction, retention, and replay contracts", () => {
  const dataContract = readText("contracts/data-contract.md");
  const authBoundaries = readText("contracts/auth-domain-boundaries.md");
  const redaction = readText("contracts/error-redaction.md");
  const retention = readText("docs/data-retention.md");

  for (const collectionName of [
    "portalUsers",
    "portalAccessPolicies",
    "portalAuthAudit",
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
    "usageEventReservations",
    "usageReplayApprovals",
    "usageReplayValidationGroups",
    "usageAggregateSourceRevisions",
    "portalQueryAudit",
  ]) {
    assert.match(dataContract + authBoundaries, new RegExp(collectionName));
  }

  assert.match(dataContract, /only.*run_started.*usage count/is);
  assert.match(dataContract, /operation_id.*terminal/is);
  assert.match(dataContract, /watermark/i);
  assert.match(dataContract, /online aggregation/i);
  assert.match(dataContract, /shadow/i);
  assert.match(dataContract, /validate.*switch/is);
  assert.match(dataContract, /idempotent rebuild/i);
  assert.match(dataContract, /Asia\/Shanghai.*UTC\+8.*no DST/is);
  assert.match(dataContract, /30 days behind.*24 hours ahead.*permanent rejection/is);
  assert.match(dataContract, /10 minutes ahead.*7 days behind.*server_received_at/is);
  assert.match(dataContract, /corrected_observed_at.*Asia\/Shanghai/is);
  assert.match(
    dataContract,
    /ingestion.*corrected_observed_at.*equals.*client_observed_at.*server_received_at/is,
  );
  assert.match(dataContract, /startup recovery.*run_interrupted.*stable.*idempotent/is);
  assert.match(dataContract, /abandoned.*24 hours.*derived.*source event type/is);
  assert.match(dataContract, /later run_interrupted.*supersede.*abandoned/is);
  assert.match(dataContract, /registry_status.*draft.*ingestion.*disabled/is);
  assert.match(dataContract, /Task 7.*active/is);
  assert.match(retention, /raw event retention.*rebuild window/is);

  assert.match(authBoundaries, /issuer.*subject/is);
  assert.match(authBoundaries, /immutable.*principal/is);
  assert.match(authBoundaries, /email.*name.*avatar.*snapshot/is);
  assert.match(authBoundaries, /pre-authori[sz]ed email policy ID/is);
  assert.match(authBoundaries, /must not contain.*plain.*email/is);
  assert.match(authBoundaries, /portal Firebase UID.*never/is);
  assert.match(authBoundaries, /browser.*directly.*only.*own.*portalUsers|browser.*only.*portalUsers.*own/is);
  assert.match(authBoundaries, /errorAggregates.*Functions.*Admin SDK-only|Functions.*errorAggregates.*Admin SDK-only/is);
  assert.doesNotMatch(authBoundaries, /may directly read.*errorAggregates/i);

  assert.match(redaction, /error_category/);
  assert.match(redaction, /summary/);
  assert.match(redaction, /fingerprint/);
  assert.match(redaction, /traceback/i);
  assert.match(redaction, /absolute path/i);
  assert.match(redaction, /token/i);
  assert.match(redaction, /512/);
});

test("documents every replay and maintenance collection behind the default-deny boundary", () => {
  const source = [
    readText("contracts/data-contract.md"),
    readText("contracts/auth-domain-boundaries.md"),
    readText("docs/data-retention.md"),
    readText("docs/usage-operations.md"),
  ].join("\n");
  for (const collectionName of [
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
    "usageQuotas",
    "usageOperations",
    "usageEventReservations",
    "usageReplayApprovals",
    "usageReplayValidationGroups",
    "usageAggregateSourceRevisions",
  ]) {
    assert.match(source, new RegExp(`\\b${collectionName}\\b`));
  }
  assert.match(source, /Admin SDK-only|Admin SDK services are the only writers/i);
  assert.match(source, /replayMetadataRetentionMs/);
  assert.match(source, /retentionRunRetentionMs/);
  assert.match(source, /usageReplayJobs.*failed.*finalized/is);
  assert.match(source, /running.*switched.*rolled_back.*never eligible|running.*switched.*rolled_back.*excluded/is);
  assert.match(source, /usageRetentionRuns.*completed/is);
  assert.match(source, /usageReplayAppliedEvents.*not.*generic|usageReplayAppliedEvents.*not eligible/is);
  assert.match(source, /usageEventReservations.*pending.*terminal.*not.*generic|usageEventReservations.*not eligible.*generic/is);
  assert.match(source, /production.*block|release blocker/is);
  assert.match(source, /ReplayService.*in-memory.*fixture.*only/is);
  const replayAdmin = readText("functions/src/usage/replay-admin.ts");
  assert.match(replayAdmin, /FirestoreReplayService/);
  assert.doesNotMatch(replayAdmin, /from\s+["']\.\/replay["']/);
  const publicFunctions = readText("functions/src/index.ts");
  assert.doesNotMatch(publicFunctions, /\bReplayService\b/);
  assert.doesNotMatch(publicFunctions, /\bRetentionCleanupService\b/);
  assert.match(source, /RetentionCleanupService.*in-memory.*not exported/is);
  const rules = readText("firestore.rules");
  assert.match(rules, /match\s+\/\{document=\*\*\}\s*\{\s*allow read, write:\s*if false;/s);
  const ingestionEndpoints = readText("functions/src/usage/endpoints.ts");
  assert.doesNotMatch(ingestionEndpoints, /collection\("usageMonitoring"\)/);
  assert.match(ingestionEndpoints, /FirestoreMonitoringService/);
});

test("production registry gate accepts the checked-in active registry", () => {
  const rootPackage = readJson("package.json");
  assert.equal(
    rootPackage.scripts["validate:production-registry"],
    "node scripts/validate-contracts.mjs --require-active",
  );

  const result = spawnSync(
    process.execPath,
    ["scripts/validate-contracts.mjs", "--require-active"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Validated registry.*68 tools/is);

  const deployment = readText("docs/deployment.md");
  assert.match(deployment, /npm run validate:production-registry/);
  assert.match(deployment, /registry_status.*active.*nonempty/is);
  assert.match(deployment, /draft.*block.*production deployment/is);
});

test("matches the exact ordered Firestore index manifest", () => {
  const configuration = readJson("firestore.indexes.json");
  const normalizedIndexes = configuration.indexes.map((index) => ({
    collectionGroup: index.collectionGroup,
    queryScope: index.queryScope,
    fields: index.fields.map((field) => ({
      fieldPath: field.fieldPath,
      ...(Object.hasOwn(field, "order") ? { order: field.order } : {}),
      ...(Object.hasOwn(field, "arrayConfig")
        ? { arrayConfig: field.arrayConfig }
        : {}),
    })),
  }));

  assert.deepEqual(normalizedIndexes, [
    {
      collectionGroup: "usageEvents",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "time_correction.corrected_observed_at", order: "ASCENDING" },
        { fieldPath: "server_received_at", order: "ASCENDING" },
        { fieldPath: "event_id", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "usageReplayValidationGroups",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "replay_id", order: "ASCENDING" },
        { fieldPath: "kind", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "usageReplayValidationGroups",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "updated_at", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "usageAggregateSourceRevisions",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "updated_at", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "toolUsageDaily",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "generation", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "toolUsageDaily",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "generation", order: "ASCENDING" },
        { fieldPath: "date", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "principalUsageDaily",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "generation", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "principalUsageDaily",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "generation", order: "ASCENDING" },
        { fieldPath: "date", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "errorAggregates",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "generation", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "errorAggregates",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "generation", order: "ASCENDING" },
        { fieldPath: "date", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "portalUsers",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "role", order: "ASCENDING" },
        { fieldPath: "status", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "portalUsers",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "search_terms", arrayConfig: "CONTAINS" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "usageEvents",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "server_received_at", order: "ASCENDING" },
        { fieldPath: "event_id", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "usageEvents",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "server_received_at", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "usageEvents",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "tool_key", order: "ASCENDING" },
        { fieldPath: "action_key", order: "ASCENDING" },
        { fieldPath: "server_received_at", order: "DESCENDING" },
      ],
    },
    {
      collectionGroup: "usageEvents",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "plugin_principal_id", order: "ASCENDING" },
        { fieldPath: "server_received_at", order: "DESCENDING" },
      ],
    },
    {
      collectionGroup: "usageEvents",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "event_type", order: "ASCENDING" },
        { fieldPath: "server_received_at", order: "DESCENDING" },
      ],
    },
    {
      collectionGroup: "toolUsageDaily",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "tool_key", order: "ASCENDING" },
        { fieldPath: "action_key", order: "ASCENDING" },
        { fieldPath: "date", order: "DESCENDING" },
      ],
    },
    {
      collectionGroup: "principalUsageDaily",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "plugin_principal_id", order: "ASCENDING" },
        { fieldPath: "date", order: "DESCENDING" },
      ],
    },
    {
      collectionGroup: "errorAggregates",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "fingerprint", order: "ASCENDING" },
        { fieldPath: "date", order: "DESCENDING" },
      ],
    },
    {
      collectionGroup: "errorAggregates",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "status", order: "ASCENDING" },
        { fieldPath: "date", order: "DESCENDING" },
      ],
    },
    {
      collectionGroup: "errorAggregates",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "tool_key", order: "ASCENDING" },
        { fieldPath: "action_key", order: "ASCENDING" },
        { fieldPath: "date", order: "DESCENDING" },
      ],
    },
    {
      collectionGroup: "deadLetters",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "status", order: "ASCENDING" },
        { fieldPath: "server_received_at", order: "DESCENDING" },
      ],
    },
    {
      collectionGroup: "deadLetters",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "server_received_at", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "pluginAuthAudit",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "occurredAt", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "toolUsageDaily",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "date", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "principalUsageDaily",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "date", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "errorAggregates",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "date", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "pluginDevicePairings",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "status", order: "ASCENDING" },
        { fieldPath: "expires_at", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "usageQuotas",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "expires_at", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "usageOperations",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "pending_terminal", order: "ASCENDING" },
        { fieldPath: "updated_at", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "usageReplayApprovals",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "expires_at", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "usageReplayJobs",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "status", order: "ASCENDING" },
        { fieldPath: "updated_at", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "usageRetentionRuns",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "status", order: "ASCENDING" },
        { fieldPath: "updated_at", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "usageMonitoringCounters",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "expires_at", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "usageMonitoringCounters",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "bucket_start", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "usageMonitoringSnapshots",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "recorded_at", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "usageMonitoringNotifications",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "created_at", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "errorAggregates",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "generation", order: "ASCENDING" },
        { fieldPath: "plugin_version", order: "ASCENDING" },
        { fieldPath: "date", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "usageEvents",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "error.fingerprint", order: "ASCENDING" },
        { fieldPath: "tool_key", order: "ASCENDING" },
        { fieldPath: "action_key", order: "ASCENDING" },
        { fieldPath: "time_correction.corrected_observed_at", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
    {
      collectionGroup: "usageEvents",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "error.fingerprint", order: "ASCENDING" },
        { fieldPath: "tool_key", order: "ASCENDING" },
        { fieldPath: "action_key", order: "ASCENDING" },
        { fieldPath: "plugin_version", order: "ASCENDING" },
        { fieldPath: "time_correction.corrected_observed_at", order: "ASCENDING" },
        { fieldPath: "__name__", order: "ASCENDING" },
      ],
    },
  ]);
  assert.deepEqual(configuration.fieldOverrides, []);
});

test("root scripts include contract tests while CI explicitly runs Java 21 rules tests", () => {
  const rootPackage = readJson("package.json");
  assert.match(rootPackage.devDependencies.semver, /^\d+\.\d+\.\d+$/);
  assert.equal(
    rootPackage.scripts["test:contracts"],
    "node --test tests/contracts/usage-event-schema.test.mjs tests/contracts/tool-registry.test.mjs tests/contracts/repository-contract.test.mjs tests/contracts/firebase-secret-sync.test.mjs",
  );
  assert.equal(
    rootPackage.scripts["test:rules"],
    "firebase emulators:exec --only firestore --project demo-tl-art-tool-usage-analytics \"node --test tests/rules/firestore.rules.test.mjs\"",
  );
  assert.match(rootPackage.scripts["verify:core"], /npm run test:contracts/);
  assert.doesNotMatch(rootPackage.scripts["verify:core"], /test:rules/);

  const workflow = parseYaml(readText(".github/workflows/verify.yml"));
  const javaStep = workflow.jobs.verify.steps.find(
    (step) => step.name === "Set up Java 21",
  );
  assert.ok(javaStep);
  assert.equal(javaStep.uses, "actions/setup-java@v4");
  assert.equal(javaStep.with.distribution, "temurin");
  assert.equal(javaStep.with["java-version"], 21);
  const rulesStep = workflow.jobs.verify.steps.find(
    (step) => step.name === "Test Firestore rules",
  );
  assert.ok(rulesStep);
  assert.equal(rulesStep.run, "npm run test:rules");
});

function validFirebaseRuntimeEnvironment() {
  return {
    ...process.env,
    PORTAL_FIREBASE_PROJECT_ID: "tl-art-usage-prod",
    TL_USAGE_ANALYTICS_FIREBASE_PROJECT_ID: "tl-art-usage-prod",
    PORTAL_COMPANY_DOMAINS_JSON: '["xindong.com"]',
    PORTAL_ALLOWED_WEB_ORIGINS_JSON: '["https://studio.example.github.io"]',
    PORTAL_PAGES_ORIGIN: "https://studio.example.github.io",
    PLUGIN_OAUTH_CLIENT_ID: "123456.apps.googleusercontent.com",
    PLUGIN_COMPANY_DOMAIN: "xindong.com",
    PLUGIN_ALLOWED_CALLBACK_URIS_JSON: '["https://studio.example.github.io/plugin/pair/callback"]',
    PLUGIN_ALLOWED_WEB_ORIGINS_JSON: '["https://studio.example.github.io"]',
    PLUGIN_OPS_AUDIENCE: "https://usage-analytics.example/ops",
    PLUGIN_OPS_ALLOWED_SERVICE_ACCOUNTS_JSON: '["usage-ops@tl-art-usage-prod.iam.gserviceaccount.com"]',
    PLUGIN_PRINCIPAL_KEY_ID: "primary-v1",
    PLUGIN_PRINCIPAL_PEPPER_MIGRATION_MODE: "disabled",
    USAGE_RETENTION_SCHEDULE: "0 2 * * *",
    USAGE_RETENTION_TIME_ZONE: "Asia/Shanghai",
    USAGE_RETENTION_POLICY_JSON: JSON.stringify({ rawEventRetentionMs: 86400000, deadLetterRetentionMs: 86400000, authAuditRetentionMs: 86400000, aggregateRetentionMs: 86400000, quotaRetentionMs: 86400000, operationRetentionMs: 86400000, replayMetadataRetentionMs: 86400000, retentionRunRetentionMs: 86400000, monitoringRetentionMs: 86400000, rebuildWindowMs: 3600000, lateArrivalAllowanceMs: 3600000, batchSize: 100 }),
    USAGE_RETENTION_RUN_ID_PREFIX: "scheduled-retention",
    USAGE_RETENTION_DRY_RUN: "true",
    USAGE_RETENTION_MAX_PAGES: "20",
    USAGE_RETENTION_OWNER_ID: "scheduled-retention-worker",
    USAGE_RETENTION_LEASE_MS: "300000",
    USAGE_MONITORING_SCHEDULE: "*/15 * * * *",
    USAGE_MONITORING_TIME_ZONE: "Asia/Shanghai",
    USAGE_MONITORING_CONFIG_JSON: JSON.stringify({ thresholds: { aggregateDriftRatio: 0.01, permanentRejectRate: 0.05, authFailureRate: 0.1, leaseRenewFailureRate: 0.1, deadLetterGrowthPerHour: 10, writesPerAcceptedEvent: 4, owner: "art-tools-oncall" }, routes: ["oncall"] }),
    PLUGIN_OAUTH_CLIENT_SECRET: "oauth-client-secret-material",
    PLUGIN_CREDENTIAL_PEPPER: "credential-pepper-material-at-least-32-bytes",
    PLUGIN_CREDENTIAL_DELIVERY_KEYS_JSON: JSON.stringify({ currentKeyId: "delivery-v1", verificationKeys: { "delivery-v1": "delivery-key-material-at-least-32-bytes" } }),
    PLUGIN_PRINCIPAL_KEY_PEPPER: "principal-key-pepper-material-at-least-32-bytes",
    PLUGIN_LEASE_SIGNING_KEYS_JSON: JSON.stringify({ currentKeyId: "lease-v1", verificationKeys: { "lease-v1": "lease-signing-key-material-at-least-32-bytes" } }),
    PORTAL_POLICY_HMAC_KEYS_JSON: JSON.stringify({ currentKeyId: "policy-v1", previousKeyIds: [], keys: { "policy-v1": "portal-policy-hmac-material-at-least-32-bytes" } }),
    PORTAL_BOOTSTRAP_ADMIN_JSON: JSON.stringify({ bootstrapId: "initial-admin-v1", email: "first.admin@xindong.com" }),
  };
}

test("Firebase production deployment verifies emulators and validates runtime portal origins", () => {
  const rootPackage = readJson("package.json");
  assert.equal(
    rootPackage.scripts["test:all-emulators"],
    "firebase emulators:exec --only firestore --project demo-tl-art-tool-usage-analytics \"npm run test:emulator --workspace @tl-art-tool-usage-analytics/functions\"",
  );
  assert.equal(rootPackage.scripts["verify:production"], "npm run test:rules && npm run test:all-emulators");
  assert.equal(rootPackage.scripts["validate:firebase-runtime"], "node scripts/validate-firebase-runtime-config.mjs");

  const validEnvironment = validFirebaseRuntimeEnvironment();
  const valid = spawnSync(process.execPath, ["scripts/validate-firebase-runtime-config.mjs"], { cwd: repositoryRoot, encoding: "utf8", env: validEnvironment });
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);

  const mismatched = spawnSync(process.execPath, ["scripts/validate-firebase-runtime-config.mjs"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...validEnvironment, PORTAL_ALLOWED_WEB_ORIGINS_JSON: '["https://other.example.com"]' },
  });
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.stdout + mismatched.stderr, /Pages origin.*allowed web origins/i);

  const emptyDomains = spawnSync(process.execPath, ["scripts/validate-firebase-runtime-config.mjs"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...validEnvironment, PORTAL_COMPANY_DOMAINS_JSON: "[]" },
  });
  assert.notEqual(emptyDomains.status, 0);
  assert.match(emptyDomains.stdout + emptyDomains.stderr, /company domains.*non-empty/i);

  const insecureOrigin = spawnSync(process.execPath, ["scripts/validate-firebase-runtime-config.mjs"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...validEnvironment, PORTAL_PAGES_ORIGIN: "http://studio.example.github.io" },
  });
  assert.notEqual(insecureOrigin.status, 0);
  assert.match(insecureOrigin.stdout + insecureOrigin.stderr, /Pages origin.*HTTPS/i);

  const workflow = parseYaml(readText(".github/workflows/deploy-firebase.yml"));
  const job = workflow.jobs.deploy;
  assert.equal(job.environment, "firebase-production");
  assert.equal(job.env.PORTAL_COMPANY_DOMAINS_JSON, "${{ vars.PORTAL_COMPANY_DOMAINS_JSON }}");
  assert.equal(job.env.PORTAL_ALLOWED_WEB_ORIGINS_JSON, "${{ vars.PORTAL_ALLOWED_WEB_ORIGINS_JSON }}");
  assert.equal(job.env.PORTAL_PAGES_ORIGIN, "${{ vars.PORTAL_PAGES_ORIGIN }}");
  const javaStep = job.steps.find((step) => step.name === "Set up Java 21");
  assert.ok(javaStep);
  assert.equal(javaStep.uses, "actions/setup-java@v4");
  assert.equal(javaStep.with.distribution, "temurin");
  assert.equal(javaStep.with["java-version"], 21);
  const names = job.steps.map((step) => step.name);
  assert.ok(names.indexOf("Verify repository") < names.indexOf("Verify production emulators"));
  assert.ok(names.indexOf("Verify production emulators") < names.indexOf("Validate Firebase runtime configuration"));
  assert.ok(names.indexOf("Validate Firebase runtime configuration") < names.indexOf("Authenticate to Google Cloud"));
  assert.ok(names.indexOf("Authenticate to Google Cloud") < names.indexOf("Deploy functions and Firestore configuration"));
  assert.equal(job.steps.find((step) => step.name === "Verify production emulators").run, "npm run verify:production");
  assert.equal(job.steps.find((step) => step.name === "Validate Firebase runtime configuration").run, "npm run validate:firebase-runtime");
});

test("Firebase runtime manifest covers source parameters and workflow injection without drift", () => {
  const manifestPath = path.join(repositoryRoot, "config", "firebase-runtime-parameters.json");
  assert.ok(fs.existsSync(manifestPath), "Firebase runtime parameter manifest is required");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const source = [
    "functions/src/portal/endpoints.ts",
    "functions/src/plugin-auth/endpoints.ts",
    "functions/src/usage/scheduled.ts",
  ].map(readText).join("\n");
  const sourceStrings = [...source.matchAll(/defineString\(\s*"([A-Z0-9_]+)"/g)].map((match) => match[1]).sort();
  const sourceSecrets = [...source.matchAll(/defineSecret\(\s*"([A-Z0-9_]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(manifest.string_parameters.map((item) => item.name).sort(), sourceStrings);
  assert.deepEqual(manifest.secret_parameters.map((item) => item.name).sort(), sourceSecrets);
  assert.equal(manifest.project.deploy_target, "PORTAL_FIREBASE_PROJECT_ID");
  assert.equal(manifest.project.expected_target, "TL_USAGE_ANALYTICS_FIREBASE_PROJECT_ID");

  const workflow = parseYaml(readText(".github/workflows/deploy-firebase.yml"));
  const environment = workflow.jobs.deploy.env;
  for (const item of manifest.string_parameters) assert.equal(environment[item.name], `\${{ vars.${item.name} }}`);
  for (const item of manifest.secret_parameters) assert.equal(Object.hasOwn(environment, item.name), false, `${item.name} must not be job-level`);
  assert.equal(environment.PORTAL_FIREBASE_PROJECT_ID, "${{ vars.PORTAL_FIREBASE_PROJECT_ID }}");
  assert.equal(environment.TL_USAGE_ANALYTICS_FIREBASE_PROJECT_ID, "${{ vars.TL_USAGE_ANALYTICS_FIREBASE_PROJECT_ID }}");
  const validatorStep = workflow.jobs.deploy.steps.find((step) => step.name === "Validate Firebase runtime configuration");
  const secretStep = workflow.jobs.deploy.steps.find((step) => step.name === "Configure Firebase function secrets");
  assert.ok(validatorStep);
  assert.ok(secretStep);
  for (const item of manifest.secret_parameters) {
    assert.equal(validatorStep.env[item.name], `\${{ secrets.${item.name} }}`);
    assert.equal(secretStep.env[item.name], `\${{ secrets.${item.name} }}`);
  }
  for (const name of ["Install dependencies", "Install Chromium", "Verify repository", "Verify production emulators", "Require active production registry"]) {
    const step = workflow.jobs.deploy.steps.find((candidate) => candidate.name === name);
    assert.ok(step);
    for (const item of manifest.secret_parameters) assert.equal(Object.hasOwn(step.env ?? {}, item.name), false, `${name} must not receive ${item.name}`);
  }
  assert.match(secretStep.run, /sync-firebase-secrets\.mjs/);
});

test("deployment documentation scopes protected manifest secrets to the two runtime steps", () => {
  const documentation = readText("docs/deployment.md");
  assert.match(documentation, /Non-sensitive manifest values may be available at the production job level/i);
  assert.match(documentation, /protected secrets.*only.*Validate Firebase runtime configuration.*Configure Firebase function secrets.*step-level/i);
  assert.doesNotMatch(documentation, /injects all manifest values at the production job level/i);
});

test("Firebase runtime preflight rejects missing backend parameters and wrong or PCG projects", () => {
  const validEnvironment = validFirebaseRuntimeEnvironment();
  const run = (change) => spawnSync(process.execPath, ["scripts/validate-firebase-runtime-config.mjs"], { cwd: repositoryRoot, encoding: "utf8", env: { ...validEnvironment, ...change } });
  assert.equal(run({}).status, 0);
  const missing = run({ PLUGIN_OAUTH_CLIENT_ID: "" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout + missing.stderr, /PLUGIN_OAUTH_CLIENT_ID.*required/i);
  const wrongProject = run({ PORTAL_FIREBASE_PROJECT_ID: "another-analytics-project" });
  assert.notEqual(wrongProject.status, 0);
  assert.match(wrongProject.stdout + wrongProject.stderr, /project.*match/i);
  const pcgProject = run({ PORTAL_FIREBASE_PROJECT_ID: "torchlight-pcg-prod", TL_USAGE_ANALYTICS_FIREBASE_PROJECT_ID: "torchlight-pcg-prod" });
  assert.notEqual(pcgProject.status, 0);
  assert.match(pcgProject.stdout + pcgProject.stderr, /PCG/i);
  const missingBootstrapLocalPart = run({ PORTAL_BOOTSTRAP_ADMIN_JSON: JSON.stringify({ bootstrapId: "initial-admin-v1", email: "@xindong.com" }) });
  assert.notEqual(missingBootstrapLocalPart.status, 0);
  assert.match(missingBootstrapLocalPart.stdout + missingBootstrapLocalPart.stderr, /bootstrap administrator configuration is invalid/i);
  const keyId32 = `k${"a".repeat(31)}`;
  const validPortalKeyId = run({ PORTAL_POLICY_HMAC_KEYS_JSON: JSON.stringify({ currentKeyId: keyId32, previousKeyIds: [], keys: { [keyId32]: "portal-policy-hmac-material-at-least-32-bytes" } }) });
  assert.equal(validPortalKeyId.status, 0, validPortalKeyId.stdout + validPortalKeyId.stderr);
  const keyId33 = `k${"a".repeat(32)}`;
  const invalidPortalKeyId = run({ PORTAL_POLICY_HMAC_KEYS_JSON: JSON.stringify({ currentKeyId: keyId33, previousKeyIds: [], keys: { [keyId33]: "portal-policy-hmac-material-at-least-32-bytes" } }) });
  assert.notEqual(invalidPortalKeyId.status, 0);
  assert.match(invalidPortalKeyId.stdout + invalidPortalKeyId.stderr, /PORTAL_POLICY_HMAC_KEYS_JSON.*invalid/i);
});

test("portal people search is an indexed Firestore page and never a bounded full scan", () => {
  const store = readText("functions/src/portal/firestore-store.ts");
  assert.doesNotMatch(store, /PORTAL_USER_SCAN_LIMIT/);
  assert.match(store, /listUsers[\s\S]*where\("search_terms",\s*"array-contains"[\s\S]*orderBy\(FieldPath\.documentId\(\)\)[\s\S]*limit\([^\n]*\+ 1\)/);
  assert.match(store, /listUsers[\s\S]*startAfter\(input\.cursor\)/);
});
