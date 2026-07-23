# Error redaction contract

The plugin may report a sanitized error record for a failed operation. The complete UTF-8 encoded error payload, including the traceback or stack, must not exceed 8 KiB after redaction. When truncation is required, preserve the beginning of the exception and append a stable truncation marker inside the same limit.

Before an error leaves the workstation, replace or remove:

- Windows, UNC, Unix, Unreal package, and user absolute paths;
- access tokens, refresh tokens, authorization headers, cookies, credentials, passwords, private keys, and API keys;
- request body and response body content;
- email addresses or account identifiers duplicated from the authenticated event owner;
- arbitrary asset payloads, source excerpts, memory addresses, and other volatile values.

The stored record may contain a bounded category, sanitized summary, sanitized traceback or stack, stable call site, and deterministic fingerprint. User UID, tool key, action key, plugin version, result, and event time belong in their defined top-level fields rather than being copied into free-form error text.

Sanitization is required before local queue persistence and must be repeated before upload. Records that still match a sensitive-value pattern are rejected locally rather than sent unchanged. The browser must render error text as plain text and must never interpret it as HTML.
