# Environment contract

The repository recognizes three explicit deployment environments: `production`, `test`, and `emulator`. Their Vite-compatible examples live under `config/environments/` as `.env.<mode>.example`. Copy only the selected example to the matching ignored `.env.<mode>.local` file or inject values through the deployment environment. Vite does not load an `.example` file directly.

```powershell
Copy-Item config/environments/.env.production.example config/environments/.env.production.local
npm run build --workspace @tl-art-tool-usage-analytics/web -- --mode production

Copy-Item config/environments/.env.test.example config/environments/.env.test.local
npm run build --workspace @tl-art-tool-usage-analytics/web -- --mode test

Copy-Item config/environments/.env.emulator.example config/environments/.env.emulator.local
npm run dev --workspace @tl-art-tool-usage-analytics/web -- --mode emulator
```

The root `npm run build:web` command always passes `--mode production`. Use the explicit workspace commands above for test and emulator modes. Do not rename an environment to a vague label such as `auth` or `identity`.

## Prefix ownership

| Prefix | Owner | Browser exposure |
| --- | --- | --- |
| `PORTAL_` | Web portal and platform deployment | Only documented Firebase Web SDK client values may be exposed. |
| `VITE_PLUGIN_` | Public plugin pairing page configuration | Only `VITE_PLUGIN_AUTH_BASE_URL` is allowed. |
| `PLUGIN_` | Plugin and Functions configuration | Never exposed by the Vite build. |
| `USAGE_` | Usage ingestion and maintenance Functions configuration | Never exposed by the Vite build. |

Vite exposes only the `PORTAL_` and `VITE_PLUGIN_` prefixes. The independent pairing route receives the public `VITE_PLUGIN_AUTH_BASE_URL`; broad `PLUGIN_` values stay outside `import.meta.env`. Environment samples and artifact checks must reject OAuth secrets, credential/principal peppers, lease signing keys, and Admin credentials. Server-only plugin values are injected into Functions parameters or Secret Manager and never placed in Vite environment files.

`config/firebase-runtime-parameters.json` is the authoritative Firebase Functions deployment manifest. Contract tests compare it with every `defineString` and `defineSecret` in the Functions source and with every GitHub workflow injection, so adding a runtime parameter without updating the manifest fails verification.

## Plugin authentication values

Each environment uses its own `PLUGIN_OAUTH_CLIENT_ID`, `PLUGIN_COMPANY_DOMAIN`, `PLUGIN_ALLOWED_CALLBACK_URIS_JSON`, `PLUGIN_ALLOWED_WEB_ORIGINS_JSON`, `PLUGIN_OPS_AUDIENCE`, `PLUGIN_OPS_ALLOWED_SERVICE_ACCOUNTS_JSON`, `PLUGIN_PRINCIPAL_KEY_ID`, and `PLUGIN_PRINCIPAL_PEPPER_MIGRATION_MODE`. The usage registry is not an environment parameter: `contracts/tool-registry.json`, both schemas, the shared semantic validator, and their generated hash/version manifest are bundled into the Functions artifact. The checked-in registry must remain `draft` until Task 7 publishes the verified active inventory; draft artifacts keep production ingestion unavailable. Web builds receive only `VITE_PLUGIN_AUTH_BASE_URL`. Secret Manager supplies `PLUGIN_OAUTH_CLIENT_SECRET`, `PLUGIN_CREDENTIAL_PEPPER`, `PLUGIN_CREDENTIAL_DELIVERY_KEYS_JSON`, `PLUGIN_PRINCIPAL_KEY_PEPPER`, and `PLUGIN_LEASE_SIGNING_KEYS_JSON`; example environment files never contain these values. The delivery secret is an ID-keyed overlap map independent of the credential pepper and is used only to deterministically replay an unacknowledged initial credential for 120 seconds. Keep the recorded previous delivery key until that window has elapsed; never replace a key in place.

## Usage maintenance values

Retention uses `USAGE_RETENTION_SCHEDULE`, `USAGE_RETENTION_TIME_ZONE`, `USAGE_RETENTION_POLICY_JSON`, `USAGE_RETENTION_RUN_ID_PREFIX`, `USAGE_RETENTION_DRY_RUN`, `USAGE_RETENTION_MAX_PAGES`, `USAGE_RETENTION_OWNER_ID`, and `USAGE_RETENTION_LEASE_MS`. The owner value is a bounded prefix; each scheduled invocation adds a random attempt suffix, while the run ID remains stable for retries of the same scheduler job and schedule time. Monitoring uses `USAGE_MONITORING_SCHEDULE`, `USAGE_MONITORING_TIME_ZONE`, and `USAGE_MONITORING_CONFIG_JSON`. The schedule defaults are operational cadence only; policy JSON, thresholds, routes, and owner remain deployment-reviewed values and fail closed when required values are absent. `USAGE_RETENTION_DRY_RUN` defaults to `true`. These are Functions parameters, not Vite variables or secrets, and must be reviewed independently in production and test.

Production, test, and Emulator OAuth clients must have disjoint callback allowlists and audiences. Do not reuse the portal Firebase Google provider client or the PCG Firebase project.

## Portal server secrets

`PORTAL_POLICY_HMAC_KEYS_JSON` uses `{ "currentKeyId": "...", "previousKeyIds": ["newest-previous", "oldest-previous"], "keys": { "...": "..." } }`. `previousKeyIds` is mandatory and orders every non-current key from newest to oldest; unlisted, duplicate, or unordered key material is rejected. Every key ID is at most 32 characters and every value is server-only key material of at least 32 characters. Keep previous entries only for a reviewed migration window; current-key writes and sign-in migration remove the newest matching old policy ID as it is encountered. A disabled newer policy remains authoritative over an older enabled record. `PORTAL_BOOTSTRAP_ADMIN_JSON` uses `{ "bootstrapId": "...", "email": "..." }` and is also a server-only secret because it identifies the one account allowed to attempt first-administrator bootstrap. Neither value belongs in Vite examples, Pages variables, logs, browser bundles, or Firestore document IDs.

## Public portal values

The Firebase Web SDK API key, auth domain, project ID, app ID, storage bucket, and sender ID identify a public web app. They are not administrative credentials. Firestore rules and backend authorization must protect data independently of these values.

## Values that must stay outside Git

- Google Cloud or Firebase service-account private keys.
- Firebase deployment tokens.
- Workload identity output credential files.
- Portal management credentials.
- Portal policy HMAC keys and first-administrator bootstrap configuration.
- Plugin device identifiers, enrollment secrets, refresh tokens, or signing keys.

Production and test use different Firebase projects and approved portal auth domains. Emulator values must use local hosts and a Firebase `demo-` project ID so an emulator command cannot contact a real project accidentally.
