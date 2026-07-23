# Error redaction contract

Events may include only this bounded `error` object:

- `error_category`: one value from the schema enum.
- `summary`: a redacted, single-line summary of at most 512 characters.
- `call_site`: a stable lowercase symbolic producer location such as `asset_exporter.run`; paths, filenames, line numbers, and stack frames are invalid.
- `fingerprint`: a lowercase SHA-256-shaped fingerprint of a normalized error signature.

The event's existing schema, registry, plugin, UE, UI, session, operation, binding, and principal fields provide version and correlation context. Do not duplicate them inside the error object.

Never send or store a full traceback, stack frame, exception object, absolute path, user directory, network path, asset payload, source excerpt, access token, refresh token, authorization header, cookie, credential, email address, or arbitrary diagnostic field. Authorization, Bearer, and Cookie detection is ASCII case-insensitive. Bare JWT-shaped credentials with three bounded base64url segments are rejected even when no `Bearer` label is present. A Python frame shaped like `File "...", line N[, in symbol]` is rejected even when the summary omits the `Traceback` heading. Credential detection is structural rather than a fixed label list: an optionally quoted key whose underscore, hyphen, or camel-case name ends in a sensitive suffix (`token`, `secret`, `password`, `passwd`, `credential`, `apiKey` / `api_key` / `api-key`, or `privateKey` / `private_key` / `private-key`) is rejected only when it is followed by a `:` or `=` marker and a nonempty quoted or unquoted value. Key and suffix matching is ASCII case-insensitive. This covers namespaced keys such as `oauth_token`, `session_token`, and `oauth_client_secret`, as well as JSON fragments such as `{"access_token":"..."}`. A normal message that merely contains a credential word, such as `Token refresh failed`, is not rejected automatically, and an explicitly empty quoted value is not treated as a leaked value. Replace sensitive values with stable type markers before forming the summary. Windows, UNC, Unix, and Unreal package paths become `<path>`; stack frames become `<stack>`; common Unreal asset identifiers such as `SM_*`, `SK_*`, `T_*`, `M_*`, `MI_*`, and `BP_*` become `<asset>`; email, JWT, other credential, and volatile address values use their corresponding stable markers.

Producer and server use the same v2 fingerprint input: `SHA-256("tl-art-error-v2" + NUL + error_category + NUL + normalized_summary + NUL + call_site)`. The producer sends that fingerprint, and ingestion rejects rather than silently replacing a mismatch. Category, normalized redacted summary, and bounded symbolic call site all participate; asset identity, paths, tokens, accounts, numeric values, and volatile addresses do not create high-cardinality groups.

The fingerprint intentionally remains stable across plugin versions, while storage and reporting add `plugin_version` as a separate bounded aggregate dimension. A version-filtered report must select the version shard before merging counts, timestamps, distinct principals, or summaries.

Schema rejection is the final guard, not the primary sanitizer. Producers must redact before transmission; ingestion must independently validate and route rejected records to bounded server-side dead-letter metadata without preserving the rejected sensitive payload.
