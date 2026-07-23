# Usage data contract

This repository is authoritative for the usage event schema and tool registry. Producers must send a client event that validates against `usage-event-schema.json`. The ingestion service validates it again, resolves the plugin identity, and adds only the server-owned stored-event fields.

## Event lifecycle

The fixed categories are `entry_clicked`, `dialog_opened`, `dialog_open_failed`, `run_rejected`, `run_started`, `run_succeeded`, `run_failed`, `run_cancelled`, `run_interrupted`, and `unexpected_exception`.

Only `run_started` increments a usage count. Entry clicks and dialog opens describe navigation, not successful or attempted usage. Every event carries an `operation_id`; a run terminal event (`run_succeeded`, `run_failed`, `run_cancelled`, or `run_interrupted`) is correlated with its `run_started` event by that ID. Consumers must tolerate a missing terminal event and must not infer success from `run_started`.

The client owns observation and version fields. The service derives `plugin_principal_id` from authenticated plugin credentials and adds `server_received_at` plus the bounded `time_correction` record. A portal Firebase UID is never an event identity and is rejected as an extra event field.

Terminal run events may include `duration_ms`, an integer from 0 through 604800000 (7 days). Nonterminal events must not include it.

## Time correction and daily buckets

The company reporting timezone is `Asia/Shanghai` (`UTC+8`, no DST). Client observations more than 30 days behind or 24 hours ahead of `server_received_at` receive permanent rejection. Within that hard range, observations more than 10 minutes ahead or 7 days behind are corrected to `server_received_at`. The stored `clock_offset_ms` is `server_received_at - client_observed_at`. An offset from -600000 through 604800000 is `within_tolerance` with `applied=false`; an offset from -86400000 through -600001 is `client_clock_ahead` with `applied=true`; an offset from 604800001 through 2592000000 is `client_clock_behind` with `applied=true`. Ingestion computes and verifies `corrected_observed_at`: it equals `client_observed_at` when correction is not applied and `server_received_at` when correction is applied. JSON Schema cannot compare these sibling timestamp fields, so ingestion must enforce that equality before storage. `invalid_client_time` is not a stored reason because `client_observed_at` is schema-valid and observations outside the hard range are rejected. Aggregation uses `corrected_observed_at` to assign the `Asia/Shanghai` daily bucket.

## Operation recovery

On startup, recovery emits `run_interrupted` only for a stable persisted `operation_id` that has no terminal event. This startup recovery is idempotent on `(operation_id, run_interrupted)`. An `abandoned` run is one with no terminal event after 24 hours; it is a derived display state and does not mutate the source event type. A later run_interrupted event supersedes the abandoned display state.

When a terminal event arrives before its matching `run_started`, ingestion stores it only as `usageOperations.pending_terminal` and creates an Admin SDK-only `usageEventReservations` document keyed by `event_id`. The reservation prevents any other payload or principal from claiming that global event ID. The matching start transaction validates the reservation, commits both raw events and their aggregates, and deletes the reservation atomically. A pending operation and its reservation are not ordinary expired operation metadata.

## Registry readiness gate

`registry_status` is either `draft` or `active`. When it is `draft`, production ingestion is disabled. Task 7 must populate the verified tool/action inventory and change the registry to `active` before any production ingestion or deployment is allowed.

## Collections

| Collection | Purpose | Browser access |
| --- | --- | --- |
| `portalUsers` | Portal profile, role, active/disabled state, and server-maintained normalized search prefixes | Self get only |
| `portalAccessPolicies` | Versioned HMAC pre-authorization policy records | None |
| `portalBootstrapState` | Once-consumed first-administrator bootstrap marker without email data | None |
| `portalAuthAudit` | Portal authentication audit | None |
| `pluginPrincipals` | Immutable plugin principal identity and mutable profile snapshot | None |
| `pluginDeviceBindings` | Principal-to-device binding and revocation state | None |
| `pluginDevicePairings` | Short-lived pairing workflow | None |
| `pluginAuthAudit` | Plugin authentication audit | None |
| `pluginOpsReviews` | Immutable plugin-auth operations request and two-person approval state | None |
| `usageEvents` | Validated stored events | None |
| `toolUsageDaily` | Principal-dimensional daily tool usage aggregates | None |
| `principalUsageDaily` | Principal-level daily aggregates | None |
| `errorAggregates` | Team-level redacted error aggregates | None |
| `deadLetters` | Rejected ingestion records with bounded diagnostics | None |
| `usageQuotas` | Expiring distributed ingestion quota buckets | None |
| `usageOperations` | Run correlation and bounded terminal-first recovery state | None |
| `usageEventReservations` | Global event-ID ownership while a terminal-first operation awaits its start | None |
| `usageReplayApprovals` | Immutable IAM replay request, separate approval, and one-shot execution state | None |
| `usageReplayJobs` | Persisted replay definition, tuple checkpoint, catch-up fence, validation totals, and cutover state | None |
| `usageReplayLocks` | Expiring single-worker replay lease | None |
| `usageReplayGenerations` | Immutable claim binding a shadow generation to one replay ID | None |
| `usageReplayAppliedEvents` | Idempotency marker for applying a raw event to a shadow generation | None |
| `usageReplayValidationGroups` | Replay-scoped expected daily, principal, and error groups used by resumable validation | None |
| `usageAggregateSourceRevisions` | Transactional per-company-date source revisions used by replay cutover | None |
| `usageAggregatePointers` | Active reader generation, date partitions, rollback window, and ingestion source revision | None |
| `usageRetentionRuns` | Resumable retention cleanup cursor, pinned cutoff, and policy digest | None |
| `usageRetentionSchedules` | Active scheduled-retention run pointer and short reservation | None |
| `usageRetentionAudit` | Per-page deletion audit containing only ID hashes and counts | None |
| `usageMonitoringCounters` | Server-side bounded monitoring counters | None |
| `usageMonitoringSnapshots` | Evaluated monitoring metrics and threshold snapshots | None |
| `usageMonitoringAlerts` | Deduplicated active/recovered alert state | None |
| `usageMonitoringNotifications` | Pending named-route alert notification outbox | None |
| `portalQueryAudit` | Server-side query/export audit | None |

Admin SDK services are the only writers. Browser clients do not read or write events, aggregates, identity records, management records, replay state, retention state, monitoring state, or audit records. Portal reports, including redacted team error summaries, are returned only by role-aware Functions after current access and minimum-group checks.

Each `errorAggregates` document represents exactly one company date, tool, action, error category, fingerprint, generation, and `plugin_version`. Its document ID includes that version, and `affected_versions` is the matching one-element compatibility projection. This keeps every aggregate document bounded. Queries without a version filter merge the separate version documents in Functions; queries with a version filter constrain `plugin_version` before merging so counts, timestamps, distinct principals, and safe-summary totals cannot include another version.

Maintenance retention is state-aware. The scheduled cleanup may remove only `usageOperations` whose `pending_terminal` is null, only `usageReplayJobs` in `failed` or `finalized` states, and only `usageRetentionRuns` in `completed` state, after their independently configured retention durations. `running`, `switched`, and `rolled_back` replay jobs and running retention runs are never eligible because replay rollback context remains active until finalize. Pending terminal `usageEventReservations`, `usageReplayAppliedEvents`, `usageReplayGenerations`, `usageReplayValidationGroups`, `usageReplayLocks`, `usageAggregatePointers`, `usageRetentionSchedules`, `usageRetentionAudit`, and `usageMonitoringAlerts` require state-aware cleanup, replay-aware purge, bounded-state verification, or explicit scheduler-retirement handling and are not eligible for generic time-based deletion. Production enablement is blocked until an owner records their retention/legal-hold process and age/volume monitoring; no policy may imply that these collections are bounded merely because the generic cleanup is enabled.

## Replay and aggregate rebuild

Aggregation is deterministic and keyed by the source `event_id`. A rebuild uses a stable `(corrected_observed_at, server_received_at, event_id)` watermark and a company-time day-aligned half-open `[from, to)` window. Event selection and date partitions use `corrected_observed_at`, so a late upload is rebuilt into its reporting day and an event exactly at the exclusive end belongs only to the next partition. Online aggregation continues while a replay writes to a versioned shadow result. The replay starts before the current watermark, processes the complete permitted rebuild window, and is safe to retry as an idempotent rebuild.

After replay, compare source and shadow status/duration totals plus complete streaming digests for day/tool/action groups, principal groups, error fingerprints, identity fields, and bounded safe-summary counts. `usageReplayValidationGroups` is updated idempotently with each applied marker; `usageReplayJobs.validation_progress` persists the current side, group kind, document cursor, totals, and chained digest. Each invocation processes only the approved page budget, so validation resumes without retaining all groups in memory.

The ingestion transaction reads `usageAggregatePointers/active`, routes an event by its corrected timestamp, writes only the selected generation plus an applicable rollback generation, increments the global source revision, and updates that company date's `usageAggregateSourceRevisions` document in the same commit as the raw event and aggregates. A partial replay captures only its date revision vector, so outside writes do not starve it. Cutover reads the replay job, pointer, lock, and captured date revision documents in one transaction; a conflicting in-window ingestion forces a catch-up pass before the pointer can switch. A run payload must explicitly choose `partition` or `global`; scope is never inferred from retained raw events. A partition keeps historical aggregate ranges outside the window on their existing generation. A later replay of the exact same range replaces that partition and keeps its previous generation as the rollback target; partially overlapping ranges are rejected. `rollback` restores the previous reader, while separately approved `finalize` closes the rollback window, clears obsolete rollback routing, and prevents indefinite dual writes. An explicitly global rebuild clears date partitions after validating the complete declared source range and is the compaction path for long-lived partition routing. A generation claim cannot be reused by another replay ID. Raw event retention must cover the full rebuild window and its late-arrival allowance.

Queries must use the declared indexes and bounded date ranges. Services and portal clients must not implement full collection scans.
