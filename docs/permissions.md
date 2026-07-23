# Permissions

## Trust boundaries

The portal user trust domain and the future plugin device trust domain are separate. A portal session must never be accepted as a device credential, and a device credential must never grant portal access. Neither domain may reuse PCG Firebase authentication, service accounts, collections, or project roles.

## GitHub Actions

- Verification: `contents: read` only.
- Pages: `contents: read`, `pages: write`, and GitHub Pages OIDC token issuance.
- Firebase: `contents: read` and Google workload identity OIDC token issuance.

Deploy workflows must use protected GitHub environments with reviewer rules appropriate to the organization.

## Firebase deploy identity

Create a dedicated deploy service account for this repository. Start with no roles, then grant only the documented permissions required to deploy Functions v2 and Firestore rules/indexes. Do not grant Owner or Editor. Keep runtime service accounts separate from the deploy service account.

Firestore client access remains deny-by-default. The only direct browser read is the signed-in user's own `portalUsers/{uid}` document, which drives the live role/status listener. `errorAggregates`, `toolUsageDaily`, `principalUsageDaily`, raw events, device bindings, people, policies, and audits remain server-only. Team and error summaries must pass through role-aware Functions so visitor minimum-group protection cannot be bypassed. Emulator-backed rules tests guard this single read exception. All browser writes and all other direct reads are denied.

`portalErrorDetails` is admin-only and writes a bounded query audit for allowed, denied, and failed requests. Its response allowlist is limited to event ID, plugin principal ID, current display name/email, binding ID, tool/action/event type, plugin version, observed time, and received time. It never returns raw log text, traceback, call-site text, credentials, local paths, or the stored error payload.

## Plugin authentication operations

Plugin OAuth client secrets, credential/delivery/principal peppers, and lease signing keys are separate `PLUGIN_*` Secret Manager values. The Functions runtime receives secret accessor only for those named values. The private plugin operations caller receives only invoker on `pluginOpsRequest`, `pluginOpsApprove`, and `pluginOpsExecute`; it receives no portal-admin capability and no permission to read secrets. See `plugin-auth-operations.md` for bearer verification, two-person review, and recovery.

## Application identities

Management users, portal users, and plugin devices require different claims,
token audiences, revocation paths, and audit records. The contracts define these
boundaries. Plugin pairing and plugin identity provisioning are implemented by
the plugin-only Functions namespace; portal identity provisioning remains a
separate workflow.

## Usage maintenance runtime

`retentionCleanupScheduled` and `usageMonitoringScheduled` run as the dedicated Functions runtime service account. Grant it only the Firestore document access required for raw/aggregate cleanup, replay/retention state, monitoring counters/snapshots/alerts/notification outbox, and audit writes. Cloud Scheduler may invoke only these generated scheduled functions. Portal users, plugin devices, and the GitHub deploy identity do not receive runtime maintenance access.

Replay/rebuild, rollback, and finalize remain IAM-private administration through `usageReplayAdmin`. Its request and approval callers need invoker plus valid allowlisted `PLUGIN_OPS_*` service-account OIDC identity; they receive no portal role and no direct Firestore browser access. The service enforces a different approver and immutable one-shot execution payload. Preserve the previous aggregate generation until validation and rollback verification are complete, then execute an independently approved finalize to end rollback writes.
