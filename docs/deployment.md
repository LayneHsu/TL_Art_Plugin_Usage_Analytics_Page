# Deployment

Verification, GitHub Pages deployment, and Firebase deployment are independent workflows. A failure or permission grant in one workflow does not authorize another.

All workflows use Node 22. The repository and Functions package require `>=22.12.0 <23`.

## Verification

`.github/workflows/verify.yml` has read-only repository permission. It installs the root lockfile and runs the structure contract plus both builds.

## GitHub Pages

`.github/workflows/deploy-pages.yml` uses the protected `github-pages` environment. It needs `contents: read`, `pages: write`, and `id-token: write`. Configure these public repository or environment variables before a real build:

- `PORTAL_FIREBASE_API_KEY`
- `PORTAL_FIREBASE_AUTH_DOMAIN`
- `PORTAL_FIREBASE_PROJECT_ID`
- `PORTAL_FIREBASE_APP_ID`
- `PORTAL_FIREBASE_STORAGE_BUCKET`
- `PORTAL_FIREBASE_MESSAGING_SENDER_ID`
- `PORTAL_FUNCTIONS_BASE_URL`
- `PORTAL_PAGES_ORIGIN`
- `PORTAL_FIREBASE_AUTHORIZED_DOMAINS_JSON`
- `PORTAL_ALLOWED_WEB_ORIGINS_JSON`

`PORTAL_FIREBASE_AUTHORIZED_DOMAINS_JSON` must be a JSON string array containing both the Pages hostname and `PORTAL_FIREBASE_AUTH_DOMAIN`. `PORTAL_ALLOWED_WEB_ORIGINS_JSON` must contain the exact HTTPS `PORTAL_PAGES_ORIGIN`. The preflight also calls the Firebase Identity Toolkit project endpoint and confirms every configured authorized domain is present in the live Firebase project; a placeholder, malformed value, project mismatch, missing domain, or missing Pages CORS origin blocks deployment before the build.

The workflow derives `PORTAL_PUBLIC_BASE_PATH` from the repository name and sets `PORTAL_DEPLOY_ENV=production`. Its order is configuration/live-authorized-domain preflight, web build, Pages artifact verification, upload, deployment, then Chromium smoke. The deployed smoke checks the root route, `history-smoke` fallback, Firebase Auth initialization, browser console/page errors, and the Functions `portalSession` CORS preflight. `PORTAL_SMOKE_BASE_URL` comes from the Pages deployment output and `PORTAL_SMOKE_FUNCTIONS_BASE_URL` comes from `PORTAL_FUNCTIONS_BASE_URL`; they are workflow runtime values, not additional repository configuration. A failing main-ref gate blocks manual deployment from any ref other than `refs/heads/main`.

## Firebase

`.github/workflows/deploy-firebase.yml` is manual and uses the protected `firebase-production` environment. Its executable main-ref gate blocks any ref other than `refs/heads/main`. It installs the Playwright Chromium version selected by the lockfile before running the complete repository verification, then runs Java 21 Firestore Rules tests, the full Functions Emulator suite, `npm run validate:production-registry`, and the Firebase runtime configuration validator. The production gate requires `registry_status` to be `active` and the registry to be nonempty; the checked-in `draft` registry therefore blocks production deployment until Task 7 supplies the verified inventory. Development `npm run verify` intentionally continues to accept the draft registry. Configure:

- Environment variable `PORTAL_FIREBASE_PROJECT_ID` as a GitHub Actions variable.
- Environment variable `TL_USAGE_ANALYTICS_FIREBASE_PROJECT_ID` as the independently reviewed exact deployment target; it must equal `PORTAL_FIREBASE_PROJECT_ID` and neither may contain a PCG project marker.
- Environment variable `PORTAL_COMPANY_DOMAINS_JSON` as a non-empty JSON array of approved company domains.
- Environment variable `PORTAL_ALLOWED_WEB_ORIGINS_JSON` as a JSON array of HTTPS origins containing the exact Pages origin.
- Environment variable `PORTAL_PAGES_ORIGIN` as the exact HTTPS GitHub Pages origin.
- Environment secret `PORTAL_GCP_WORKLOAD_IDENTITY_PROVIDER`.
- Environment secret `PORTAL_GCP_DEPLOY_SERVICE_ACCOUNT`.
- Every `string_parameters` entry in `config/firebase-runtime-parameters.json` as a protected environment variable.
- Every `secret_parameters` entry in the manifest as a protected environment secret.

The two secret placeholders contain workload identity configuration, not a downloaded private key. The Google authentication action creates an ephemeral credential file for the job. Do not add a service-account JSON secret unless an approved security exception replaces workload identity federation.

Non-sensitive manifest values may be available at the production job level so validation and the non-interactive Firebase deployment consume the same target and Functions parameters. Protected secrets are injected only into the `Validate Firebase runtime configuration` and `Configure Firebase function secrets` steps through step-level `env`; dependency installation, verification, emulator, registry, authentication, and deployment steps do not receive them. Before deployment, `scripts/sync-firebase-secrets.mjs` sends each protected secret to Firebase Secret Manager over stdin and reports only the parameter name on failure and the final count, never the value. A missing backend parameter, malformed company domain, insecure origin, Pages origin mismatch, malformed key map, invalid maintenance policy, wrong project, or PCG project blocks authentication/deployment. The workflow invokes the repository-local Firebase CLI and never installs a global CLI.

On a new project, configure `PORTAL_BOOTSTRAP_ADMIN_JSON` before the first Portal sign-in. Verify the resulting `portalBootstrapState/{bootstrapId}` consumed marker, the active admin, and the matching `portal_first_admin_bootstrap` record in `portalAuthAudit`. Do not create the first admin by browser write or an unaudited manual `portalUsers` edit. Keep the bootstrap secret configured because every Portal Function declares it as a runtime secret; the consumed marker prevents replay after bootstrap completes.

Before enabling the workflow, create a dedicated non-PCG Firebase project, configure workload identity federation, approve the GitHub environment, and validate the least-privilege roles in `docs/permissions.md`.

Before deploying scheduled maintenance, configure the reviewed `USAGE_RETENTION_*` and `USAGE_MONITORING_*` Functions parameters documented in `docs/environment.md`. Start retention with dry-run enabled, review `usageRetentionAudit`, then explicitly approve deletion mode. Verify the previous aggregate generation and rollback pointer before retiring any replay generation. Scheduler configuration does not bypass the draft production registry gate for event ingestion.
