# TL Art Tool Usage Analytics

This repository hosts the independent usage analytics portal for TL art tools. The target runtime stays within the personal Firebase Spark plan: GitHub Pages serves the Vue application, Firebase Authentication handles Google sign-in, and Cloud Firestore stores usage and access data.

The project is independent from the PCG Firebase project. It has its own Firebase project, Firestore data, authentication configuration, and GitHub Pages deployment. ImportTool remains a separate repository and consumes only the versioned contracts maintained here.

## Repository layout

- `web/`: Vue 3, Vite, TypeScript, and Firebase Web SDK portal.
- `config/environments/`: public web configuration templates for production, test, and local emulators.
- `contracts/`: usage event, tool registry, and error redaction contracts shared with the plugin.
- `firestore.rules` and `firestore.indexes.json`: browser authorization and query configuration.
- `tests/`: structure, contract, Firestore emulator, Pages artifact, and Playwright checks.

## Local commands

Use Node.js `>=22.12.0 <23`.

```powershell
npm install
npm run test:structure
npm run test:contracts
npm run test:cross
npm run build:web
npm run test:pages-artifacts
```

Firestore Rules tests also require Java 21:

```powershell
npm run test:rules
```

Run the browser suite after installing Playwright Chromium:

```powershell
npx playwright install chromium
npm run test:e2e
```

## GitHub Pages

`PORTAL_PUBLIC_BASE_PATH` controls the Vite base path. The production workflow derives it from the repository name and publishes `web/dist`. Each build includes `404.html` and `.nojekyll` so direct refreshes continue to load the application under the repository subpath.

The Pages build accepts only public Firebase Web identifiers, the Pages origin, and the Firebase Auth authorized-domain list. No private key, refresh token, account credential, or deployment credential belongs in the repository or browser bundle.

## External setup

1. Create a dedicated Firebase project on the Spark plan.
2. Enable Google sign-in and register the Pages hostname as an authorized domain.
3. Create the Firestore database, then publish the reviewed Rules and Indexes.
4. Add the public `PORTAL_FIREBASE_*`, Pages origin, and authorized-domain values to the GitHub `github-pages` environment.
5. After the Spark Firestore Rules/data contract has been deployed, create the first `portalMembers` administrator document before exposing the portal. During the intermediate scaffold migration, the old portal collections are not a supported production setup.

The detailed data model, Rules, portal queries, and operator runbook are completed in later implementation tasks and remain protected by their own contracts.
