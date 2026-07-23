# Data retention

Production ingestion remains disabled while the checked-in registry is `draft`. Before the active registry gate is opened, an owner must approve the collection purpose, fields, access policy, and deletion schedule.

Before production collection starts, define and automate all of the following:

- A short retention window for raw event records. Raw event retention must be
  at least the complete idempotent rebuild window plus the approved
  late-arrival allowance; a longer advertised rebuild window is invalid.
- A separately justified retention window for aggregated reports.
- Firestore TTL policies or an equivalent scheduled deletion mechanism.
- Deletion behavior for test data, failed uploads, and device enrollment records.
- Backup retention and restore verification.
- An auditable exception and legal-hold process.

The scheduled cleanup stores resumable run state in `usageRetentionRuns` and writes `usageRetentionAudit` before deleting each page. Audit records contain only collection names, counts, timestamps, and document-ID hashes. Scheduler job plus schedule time identifies a candidate run; `usageRetentionSchedules` keeps the unfinished run active across later triggers and advances only after completion. The pointer contains no user data, is updated in place, and is removed when its scheduler job is retired. Each invocation uses a different lease owner. A run pins its cutoff and policy digest; resume refuses policy drift. The worker renews the run lease around every page, and deletion transactions reject stale owners. Raw-event page deletion is also fenced by the same maintenance lock and active-job check used by replay, in the deletion transaction, so a replay cannot start between a stale check and source deletion. Expiring `usageQuotas` use the quota retention duration; only `usageOperations` with `pending_terminal == null` and expired `usageReplayApprovals` use the operation retention duration; `failed` or `finalized` `usageReplayJobs` use `replayMetadataRetentionMs`; completed `usageRetentionRuns` use `retentionRunRetentionMs`; `usageAggregateSourceRevisions` follows raw-event retention from its last accepted event. The operation query excludes pending terminal state, and the deletion transaction rechecks it to close the selection/deletion race. `running`, `switched`, and `rolled_back` replay jobs and running retention runs are excluded by status filters and rechecked in the deletion transaction.

The run cutoff is the trigger-time snapshot and never advances while pages are processed, so a long run cannot expand its deletion window. Lease renewal, ownership checks, progress timestamps, and the raw-event replay fence use a live wall clock on every operation. Production scheduler wiring must not inject the trigger timestamp as a fixed lease clock; an injected clock exists only for deterministic tests.

`usageEventReservations`, `usageReplayAppliedEvents`, `usageReplayGenerations`, `usageReplayValidationGroups`, `usageReplayLocks`, `usageAggregatePointers`, `usageRetentionSchedules`, `usageRetentionAudit`, and `usageMonitoringAlerts` are intentionally not generic cleanup targets. A `usageEventReservations` document is pending terminal event ownership and is deleted only by the matching start reconciliation transaction; an orphan requires an explicit, auditable repair procedure. The other collections depend on replay completion, rollback-window closure, generation non-reuse, scheduler retirement, or bounded-state verification. Before production ingestion is enabled, the deployment owner must approve a replay-aware purge/legal-hold procedure, a maximum age/volume monitor, and an escalation path for orphaned records. Until that gate is approved, an alert or unbounded growth in any of these collections is a release blocker, not a reason to broaden the generic retention query.

`replayMetadataRetentionMs` and `retentionRunRetentionMs` must be supplied in `USAGE_RETENTION_POLICY_JSON`; values are deployment-owner decisions and are never silently defaulted. `USAGE_RETENTION_POLICY_JSON` remains required, `USAGE_RETENTION_DRY_RUN` defaults to true, and no production retention duration is hard-coded.

Production, test, and emulator data must not share collections or exports. Test and emulator data should be disposable and must never contain copied production credentials or personal data.

Retention values are deliberately not invented in this scaffold. The approved durations and responsible owner must be recorded here before production ingestion is enabled. Legal-hold handling and backup/restore verification remain deployment-owner gates.
