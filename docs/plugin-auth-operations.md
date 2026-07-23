# Plugin authentication operations

Plugin authentication operations use a dedicated service account and three private IAM-protected Functions: `pluginOpsRequest`, `pluginOpsApprove`, and `pluginOpsExecute`. Portal admin cannot invoke this surface, and the portal Firebase ID token is not accepted. The caller must also present a Google-signed OIDC bearer token whose audience is the plugin-ops audience and whose verified service-account email is in the server allowlist. Header/body identity claims are ignored; `x-goog-authenticated-user-email` and `approved_by` are not trust sources.

## Minimum permissions

The runtime Functions identity may read and transact only `pluginPrincipals`, `pluginDeviceBindings`, `pluginDevicePairings`, `pluginOpsReviews`, and `pluginAuthAudit`, plus read the named plugin secrets. It does not need portal role-management permissions. The operations caller receives only Cloud Functions Invoker on the three private plugin-ops Functions. Secret-version add/enable/disable and deployment remain separate release identities; the operations caller cannot read secret payloads.

Production configuration must also enforce a distributed request limit at the gateway or Cloud Armor layer. The Function body is limited to 16 KiB, execution to 30 seconds, POST/HTTPS only, browser origins to the configured Pages origins, and polling to a per-pairing interval. The in-instance IP window is defense in depth, not the distributed limit.

## Two-person review

Every principal disable, server-side binding revoke, or signing-key rotation uses a server-generated `opsrev_*` review. Request stores immutable action, target ID, bounded parameters, requester, and expiry. A separate verified allowlisted service account approves; execute consumes the approved review atomically and applies only the stored action/target/parameters. Approval and execute retries cannot substitute values or replay the operation. Request, approval, execute, expiry, and auth denials are written to `pluginAuthAudit` without credentials or tokens.

Operation inputs use action-specific schemas before any review or audit write. Binding revocation accepts only a generated `bind_*` target and a fixed reason code, principal disable accepts only an immutable `pp_*` target and a fixed reason code, and signing-key rotation accepts only the `lease-signing-keys` target. Rotation key IDs must use the stable key-ID grammar, both IDs must already exist in the configured lease verification overlap, the IDs must differ, and the requested current ID must equal the configured signing key. OAuth codes, device credentials, arbitrary opaque strings, malformed review IDs, and unknown key IDs are rejected before storage; the audit sanitizer remains a second line of defense.

Signing-key rotation adds the new key ID to verification first, makes it current for signing, verifies new issuance, and retains the old verification key for at least the maximum 3600-second lease lifetime plus clock tolerance. Removal is a separate reviewed change. Secret JSON contains only key IDs and secret values in Firebase Secret Manager, never in source or deployment logs.

Initial device credential delivery uses a versioned `currentKeyId` plus a verification-key overlap map. The delivery key ID is stored with the pending 120-second delivery metadata, so replay and acknowledgement continue to derive and verify with the original key while a new key becomes current. Keep the old delivery key available until all pending deliveries have expired; if the recorded key is unavailable or the digest does not match, the service atomically revokes the binding and records a bounded denial. Never replace a delivery secret in place under the same key ID.

After a delivery has been acknowledged, an identical acknowledgement retry is accepted from the stored binding digest even if the old delivery key has since left the overlap map. A retry with a different credential is denied without revoking an already acknowledged binding. Pending acknowledgements still require the original key to be available and are revoked on key or digest mismatch.

The principal pepper is pinned to key ID `v1` during normal operation. A different principal key ID is rejected unless an explicit migration mode is enabled and a reviewed migration has a documented dual-lookup/record migration plan. Do not rotate the principal pepper as an ordinary secret change: changing it without migration would derive a new principal for the same issuer and subject and could bypass a disabled record. The credential pepper is an invalidating rotation: revoke all device bindings first, deploy the new pepper in a reviewed change, and require every device to pair again.

## Recovery

For an incorrect device revoke, create a new pairing; never clear `revoked_at` or restore the old credential. For an incorrect principal disable, a reviewed recovery procedure may re-enable the same immutable principal record through a dedicated recovery release tool, with before/after snapshots and a `pluginAuthAudit` entry. Do not create a replacement principal from the same email.

If the current signing key is unusable, roll back `currentKeyId` to a still-configured overlap key, verify lease issuance, then repair the intended key in a separate reviewed deployment. If audit writes or Firestore transactions are unavailable, stop the operation instead of applying an unaudited partial change.
