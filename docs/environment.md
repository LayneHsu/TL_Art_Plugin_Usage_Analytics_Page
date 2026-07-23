# Environment

The repository has three Vite modes: `production`, `test`, and `emulator`. Copy only the selected example to the matching ignored `.env.<mode>.local` file, or provide the same public values through the Pages build environment.

```powershell
Copy-Item config/environments/.env.production.example config/environments/.env.production.local
npm run build --workspace @tl-art-tool-usage-analytics/web -- --mode production

Copy-Item config/environments/.env.test.example config/environments/.env.test.local
npm run build --workspace @tl-art-tool-usage-analytics/web -- --mode test

Copy-Item config/environments/.env.emulator.example config/environments/.env.emulator.local
npm run dev --workspace @tl-art-tool-usage-analytics/web -- --mode emulator
```

## Public web values

The browser build may contain only public Firebase Web SDK identifiers and the Pages base path. This repository uses the `PORTAL_` prefix for these public web values:

| Variable | Purpose |
| --- | --- |
| `PORTAL_DEPLOY_ENV` | Build mode, which must be `production` for Pages |
| `PORTAL_FIREBASE_API_KEY` | Firebase Web SDK application identifier |
| `PORTAL_FIREBASE_AUTH_DOMAIN` | Firebase Authentication web domain |
| `PORTAL_FIREBASE_PROJECT_ID` | Dedicated analytics Firebase project |
| `PORTAL_FIREBASE_APP_ID` | Firebase Web app identifier |
| `PORTAL_FIREBASE_STORAGE_BUCKET` | Public SDK configuration value |
| `PORTAL_FIREBASE_MESSAGING_SENDER_ID` | Public SDK configuration value |
| `PORTAL_PUBLIC_BASE_PATH` | GitHub Pages repository path |
| `PORTAL_PAGES_ORIGIN` | Published Pages origin |
| `PORTAL_FIREBASE_AUTHORIZED_DOMAINS_JSON` | Firebase Auth authorized hostnames |

Firebase API keys, project IDs, app IDs, and authorized domains are not secrets. Firestore Rules and Firebase Authentication enforce access. Do not put service-account keys, refresh tokens, OAuth client secrets, or private signing material in this repository or a Vite environment file.

## Emulator values

The emulator example must use a `demo-` Firebase project ID and local hosts. It enables the Auth and Firestore emulators without contacting a real Firebase project. Emulator-only values must never be copied into a production Pages environment.

## Plugin boundary

ImportTool has its own runtime configuration and local credential storage. This repository does not contain plugin credentials, plugin refresh tokens, or a second copy of the plugin configuration. The two projects share only the documented Firestore data contract.
