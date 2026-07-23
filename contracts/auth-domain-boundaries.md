# Authentication domain boundaries

Portal users and plugin installations are separate authentication domains. Portal Firebase UID values authorize only the portal browser and are never accepted as plugin identity, `plugin_principal_id`, event ownership, or device binding identity. Plugin credentials never grant portal access.

## Portal domain

`portalUsers` maps a portal Firebase UID to an application role and status. The browser directly reads only its own `portalUsers/{uid}` document and cannot list or write the collection. `portalAccessPolicies` stores pre-authorized email policy IDs and domain policy IDs. These IDs and their value hashes are versioned HMAC derivations using server-only current/previous keys; they must not contain a plain email or domain and are never unkeyed hashes. `portalBootstrapState` is the server-only, once-consumed first-administrator marker. Creating the first administrator, consuming the marker, and writing `portalAuthAudit` are one transaction. `portalAuthAudit` and `portalQueryAudit` are server-only audit trails.

`errorAggregates` is Functions and Admin SDK-only data; neither an active `visitor` nor an `admin` may read it directly from the browser. Team and error summaries always pass through role-aware Portal Functions. `toolUsageDaily` and `principalUsageDaily` both contain `plugin_principal_id` and are also server-only. Browser roles do not grant direct access to user-level statistics, people lists, devices, raw events, policy records, or audit data. Management and report APIs use the Admin SDK.

## Plugin domain

`pluginPrincipals` uses a deterministic immutable principal key derived from the normalized `issuer` and `subject`, with domain separation and a one-way cryptographic hash. Issuer and subject assignments are immutable after creation. Email, name, and avatar are mutable display snapshots; they are not authorization keys and may be refreshed from the trusted issuer.

`pluginDeviceBindings` stores active and revoked device bindings. `pluginDevicePairings` stores short-lived pairing challenges. `pluginAuthAudit` records pairing, token, revocation, and authorization decisions. These collections and `principalUsageDaily` are server-only.

Plugin browser pairing uses an authorization code with PKCE and a plugin-only OAuth client. Portal Firebase bearer tokens are rejected at the plugin HTTP boundary. Device credentials are stored only as peppered digests and can exchange only for a maximum one-hour plugin lease. Plugin operations use a private IAM identity rather than a portal role. The full lifecycle is defined in `plugin-auth-contract.md`.

## Server maintenance domain

`usageQuotas`, `usageOperations`, `usageEventReservations`, `usageReplayApprovals`, `usageReplayJobs`, `usageReplayLocks`, `usageReplayAppliedEvents`, `usageReplayGenerations`, `usageReplayValidationGroups`, `usageAggregateSourceRevisions`, `usageAggregatePointers`, `usageRetentionRuns`, `usageRetentionSchedules`, `usageRetentionAudit`, `usageMonitoringCounters`, `usageMonitoringSnapshots`, `usageMonitoringAlerts`, and `usageMonitoringNotifications` are Admin SDK-only maintenance state. Portal Firebase users, visitor/admin roles, and plugin lease credentials cannot read or write them. Replay/rebuild request, approval, execution, rollback, and finalize use verified allowlisted Google service-account OIDC at the IAM-private `usageReplayAdmin` entry. Approval must come from an actor other than the requester, and execution must match the immutable approved payload. Scheduled retention and monitoring use their deployed Functions service identity.

No credential, UID, service account, collection, or authorization decision is shared with the PCG Firebase project.

Portal management and reporting use only the verified portal Firebase identity and the current `portalUsers` role. Portal Functions never accept a plugin lease, device credential, client-supplied portal role, or `plugin_principal_id` as an authorization substitute. Portal disable/remove operations do not revoke plugin principals, bindings, leases, or historical usage.
