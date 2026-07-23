# Dependency security review

Owner: TL Art Tool maintainers

Review date: 2026-08-22

The current lockfile audit has two accepted groups of moderate findings:

- `firebase-tools` is a pinned, dev-only deployment dependency with 5 moderate findings.
- The Firebase Functions transitive runtime chain has 7 moderate findings.

The first runtime-handler review was performed on 2026-07-22 for plugin authentication. `firebase-admin` and `google-auth-library` were added as exact direct versions, and the audit remained 12 moderate, 0 high, and 0 critical findings. `firebase-admin` is included in the existing seven-item Firebase runtime chain; no new finding was accepted without review.

The npm automatic recommendation to downgrade `firebase-functions` to `4.9.0` is not accepted because it crosses major versions and does not provide a sound forward fix for this scaffold. No vulnerability is ignored silently; the lockfile remains pinned and reviewable.

Review these findings again at the earliest of the following events:

- Before adding the first runtime handler.
- Before adding any Firebase Storage use.
- When an upstream fixed version is released.
- On the review date above.
