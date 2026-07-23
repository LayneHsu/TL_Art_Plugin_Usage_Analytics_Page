import type { HttpsFunction } from "firebase-functions/v2/https";

export {
  pluginAcknowledgePairingDelivery,
  pluginBeginPairing,
  pluginCancelBrowserPairing,
  pluginCancelCredentialRotation,
  pluginCancelPairing,
  pluginCompletePairing,
  pluginConfirmCredentialRotation,
  pluginCreatePairing,
  pluginOpsApprove,
  pluginOpsExecute,
  pluginOpsRequest,
  pluginPollPairing,
  pluginPrepareCredentialRotation,
  pluginRenewLease,
  pluginUnlink,
} from "./plugin-auth/endpoints";
export {
  PluginAuthDecisionService,
  assertLeaseAuthorizesBinding,
} from "./plugin-auth/auth-decision";

export type UsageAnalyticsHttpsFunction = HttpsFunction;

export { usageIngest, createUsageIngestionEndpointHandler } from "./usage/endpoints";
export {
  UsageIngestionError,
  UsageIngestionService,
  MAX_BATCH_EVENTS,
  InMemoryUsageStore,
} from "./usage/ingestion";
export { FirestoreUsageStore } from "./usage/store";
export { validateClientEvent, correctObservedTime } from "./usage/validation";
export { redactError, redactSummary, errorFingerprint } from "./usage/redaction";
export { aggregateEvent } from "./usage/aggregation";
export {
  deriveOperationDisplayState,
  type OperationDisplayState,
} from "./usage/operation-display";
export {
  FirestoreReplayService,
  FirestoreAggregateGenerationReader,
  ReplayOperationError,
} from "./usage/firestore-replay";
export {
  FirestoreReplayApprovalService,
  ReplayAdminError,
  createReplayAdminEndpointHandler,
  usageReplayAdmin,
} from "./usage/replay-admin";
export {
  FirestoreRetentionAdapter,
  FirestoreRetentionCleanupService,
  createRetentionCleanupScheduledHandler,
  createScheduledRetentionCleanupHandler,
} from "./usage/retention-firestore";
export { evaluateUsageMonitoring, validateUsageMonitoringThresholds } from "./usage/monitoring";
export {
  FirestoreMonitoringService,
  createScheduledUsageMonitoringHandler,
  createUsageMonitoringScheduledHandler,
} from "./usage/monitoring-firestore";
export { retentionCleanupScheduled, usageMonitoringScheduled } from "./usage/scheduled";
export { TokenBucketRateLimiter } from "./usage/rate-limit";
export { FirestoreUsageQuota, InMemoryUsageQuota } from "./usage/quota";
export {
  portalSession,
  portalSignIn,
  portalTeamSummary,
  portalPrincipalUsage,
  portalDevices,
  portalErrors,
  portalErrorDetails,
  portalPeople,
  portalPolicies,
  createPortalHttpHandler,
  verifyPortalIdentity,
} from "./portal/endpoints";
export {
  InMemoryPortalStore,
  PortalError,
  PortalService,
  portalDomainPolicyId,
  portalEmailPolicyId,
  portalValueHash,
} from "./portal/service";
export { FirestorePortalStore } from "./portal/firestore-store";
