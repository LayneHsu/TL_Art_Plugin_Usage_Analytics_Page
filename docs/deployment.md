# Deployment

The analytics project is a static GitHub Pages site backed directly by Firebase Authentication and Cloud Firestore. It stays on the personal Firebase Spark plan and has no server-side deployment step.

## Firebase Console setup

1. Create a dedicated Firebase project for analytics; do not reuse the PCG project.
2. Keep the project on the Spark plan.
3. Enable Google sign-in in Firebase Authentication.
4. Add the GitHub Pages hostname to Authentication authorized domains.
5. Create a Web app and copy its public configuration into the Pages environment.
6. Create Cloud Firestore in production mode and deploy `firestore.rules` and `firestore.indexes.json` with the Firebase CLI.
7. Create the first `portalMembers` document manually with `snkhtm@gmail.com` as the document ID and `email`, `role: "admin"`, `enabled: true`; later member changes happen from the admin page. Plugin data writes remain restricted to verified `@xindong.com` accounts.

## GitHub Pages

`.github/workflows/deploy-pages.yml` builds the Vue site, verifies the generated artifact, and publishes it to GitHub Pages. Configure only these public values in the protected Pages environment:

- `PORTAL_DEPLOY_ENV`
- `PORTAL_FIREBASE_API_KEY`
- `PORTAL_FIREBASE_AUTH_DOMAIN`
- `PORTAL_FIREBASE_PROJECT_ID`
- `PORTAL_FIREBASE_APP_ID`
- `PORTAL_FIREBASE_STORAGE_BUCKET`
- `PORTAL_FIREBASE_MESSAGING_SENDER_ID`
- `PORTAL_PUBLIC_BASE_PATH`
- `PORTAL_PAGES_ORIGIN`
- `PORTAL_FIREBASE_AUTHORIZED_DOMAINS_JSON`

The Pages origin must be present in Firebase Authentication authorized domains. The build must fail when a required public value is missing or when a production value still points at an emulator project.

## Local verification

Use the repository scripts before publishing:

```powershell
npm ci
npm run verify:core
npm run build:web
npm run test:rules
```

For local permission checks, start the Auth and Firestore emulators with a `demo-` project ID and run `npm run test:rules`. No production credentials are needed for emulator tests.
The Firebase Emulator requires Java 21 or newer; this repository's permission matrix is verified with JDK 25 LTS.

## Spark operating limits

The design budget is 20,000 Firestore writes, 50,000 reads, and 20,000 deletes per day, with 1 GiB stored data and 10 GiB monthly egress. A complete tool operation normally writes both `run_started` and one terminal event, while failed operations can also create an error document. The portal therefore uses 5,000 tool operations per day as an operational warning line, leaving room for account/profile writes, membership changes, retries, and error logs; it is not a server-side hard cap. Administrators should export before manually deleting old daily buckets and error documents in controlled batches.

## Rollback

GitHub Pages can be rolled back by redeploying a known-good commit. Firestore data changes are governed by the checked-in Rules and data contract; export the affected date range before changing those files. No private credential or server process is required to restore the static site.
