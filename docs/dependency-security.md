# Dependency security review

Owner: TL Art Tool maintainers

This repository has one production application workspace, `web`. Its runtime dependencies are Vue and the Firebase Web SDK. Root dependencies support contract validation, Playwright, Firestore Rules tests, and the repository-local Firebase CLI.

Dependency controls:

- `package-lock.json` is committed and CI installs with `npm ci`.
- Root and web manifests use bounded or exact dependency versions and require Node 22.
- Browser code receives only public Firebase Web configuration.
- Firestore Rules and their emulator tests are part of every production authorization review.
- Dependency changes require a fresh lockfile audit and focused build/test run.

Review audit findings before deployment, when an upstream fix becomes available, or when adding a new browser/runtime dependency. High or critical findings block release unless the maintainers record a narrowly scoped exception with an owner and expiry date.
