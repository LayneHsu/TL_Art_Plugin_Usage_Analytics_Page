# TL Art Tool Usage Analytics

This repository is the independent platform foundation for TL art tool usage analytics. It contains a Vue portal workspace and a Firebase Functions workspace. It does not import, build, or reference runtime source from ImportTool or any PCG repository.

The platform is independent from the PCG Firebase project. Its Firebase projects, data, deployment identity, and authentication domains are isolated. Portal user authentication and future plugin device authentication must remain separate trust domains with separate credentials and authorization policies.

The current foundation includes versioned usage-event and tool-registry contracts,
deny-by-default Firestore browser boundaries, required query indexes, plugin-only
Google OAuth device pairing, one-hour leases, credential recovery, audited event
authorization, and Firestore emulator transaction tests. The server-side event
ingestion, idempotent daily aggregation, redacted error grouping, retention,
monitoring, replay services, and the separate portal role/query boundary are
implemented behind the draft-registry production gate. Portal Firebase Auth is
used only for web viewing; plugin pairing and leases remain a separate domain.

## Repository layout

- `web/`: Vue 3, Vite, and TypeScript static portal shell.
- `functions/`: Firebase Functions v2 and TypeScript workspace.
- `config/environments/`: production, test, and emulator configuration contracts.
- `contracts/`: authoritative event, registry, identity, and redaction contracts.
- `docs/`: environment, deployment, permissions, retention, data dictionary, portal operations, and split-repository rollback requirements.
- `.github/workflows/`: separate verification, Pages, and Firebase workflows.

## Local commands

Use Node.js `>=22.12.0 <23`. Local builds, Functions, and CI share this Node 22 range.

```powershell
npm install
npm run test:structure
npm run test:contracts
npm run test:usage
npm run build:web
npm run build:functions
npm run verify
```

Firestore Rules tests require Java 21 and use the repository-local Firebase CLI:

```powershell
npm run test:rules
npm run test:usage-emulator
```

Firebase CLI commands use the repository-local pinned tool:

```powershell
npm run firebase -- --version
```

## GitHub Pages

The Vite base path is controlled by `PORTAL_PUBLIC_BASE_PATH`. Production defaults to this repository name, while the Pages workflow derives the path from the GitHub repository name. The build emits `404.html` and `.nojekyll` beside `index.html`, so project-subpath assets and direct refreshes use the same built application.

## Configuration and secrets

Firebase Web SDK client values are public identifiers and may be provided to the Pages build through GitHub environment variables. Google Cloud private keys, Firebase deployment tokens, management credentials, and plugin device credentials must never be committed or exposed to the browser bundle.

All portal-owned keys use `PORTAL_`. Plugin server values use `PLUGIN_`, while the
pairing page exposes only `VITE_PLUGIN_AUTH_BASE_URL`. See `docs/environment.md`
before adding a variable.

## External setup required before deployment

1. Create dedicated production and test Firebase projects that are not shared with PCG.
2. Register the portal web apps and approved portal authentication domains.
3. Create a GitHub `github-pages` environment and add the public `PORTAL_FIREBASE_*` repository variables.
4. Create a GitHub `firebase-production` environment with the workload identity provider and deploy service account placeholders documented in `docs/deployment.md`.
5. Grant the deploy identity only the roles required by the selected Firebase resources.
6. Review and approve the retention policy before enabling data collection.

No real project ID, token, private key, service-account file, or device credential belongs in this repository.
