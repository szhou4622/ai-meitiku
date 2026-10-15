# Source import snapshot

Current source synchronization: **1.1.28 / 2026-10-15**. Earlier sections below are historical stage records; see the final section for the current scope and verification.

- Imported at: 2026-10-01 (Asia/Tokyo)
- Source baseline: local AI Media Library working tree based on commit `835d8e0`
- Source files inventoried: 533
- Source inventory SHA-256: `f9ab21121cde96f127a9d5690638395814ad72e6c5d07d618045eb04330aa25a`
- Scope: application, Electron main process, tests, build scripts, documentation,
  vendored downloader source, and the server contract/candidate files already
  maintained with the application source

The inventory digest is the SHA-256 of the bytewise-sorted list of
`<file SHA-256><two spaces><relative path>` entries from the imported working
tree. It excludes Git metadata, ignored files, and the local `.coverage` file.

Excluded from this public repository: dependencies, build outputs, packaged
installers, local databases, logs, credentials, authorization state, user data,
and the large bundled classifier/downloader/model/tool runtimes described in
`BUNDLED.md`.

## Import validation

- `npm run build`: passed
- `node --test tests/*.test.mjs`: 456 passed, 4 failed out of 460
- The four failures are in `tests/license-identity-observe.test.mjs`; their
  fixed test expiry dates are earlier than the import date, so the fixtures now
  return `expired` where the tests expect `active`.
- Focused Xiaohongshu parser/redirect regressions: 6 passed
- `git diff --check`: passed before commit

## Main branch integration (2026-10-01)

- Original import commit: `c30e554e50d11db81cd6279928ff9f390efc599c`.
- Integrated the repository workflow baseline from `c000233`; retained the
  imported application source and resolved the README overlap with the branch rules.
- Required `repository-checks` verifies repository hygiene only. The historical
  application results above are not a claim that all application tests pass.
- Both macOS installer jobs in [run 36838284542](https://github.com/szhou4622/ai-meitiku/actions/runs/36838284542)
  failed at Electron packaging with `spawn pnpm ENOENT`. Installer generation
  remains unverified and requires a separate release task.
- The installer workflow is now manual-only because it publishes release assets.
  Development pushes and this source integration must not publish installers.
- No production deployment, service restart, database migration, or production
  configuration change is part of this integration.

## Historical local source synchronization (2026-10-09, Asia/Tokyo)

- Application version: `1.1.19`.
- Remote baseline: `994715eb0243d86602a6c7239c686c2c1f0ba771` (PR #7).
- Source: the current local AI Media Library source working tree based on
  `835d8e0eda8f37b7458cf84076ce642d63804859`, including its uncommitted work.
- Prepared in an isolated checkout on `codex/latest-source-20261009`; the
  original dirty checkout was not reset, switched, committed, or overwritten.
- Final inventory: 628 files, excluding this self-referential import record.
- Inventory SHA-256:
  `a32dbceafa670240432f6787724eda72796a199e834947af82dd1bbf8d3ee9b1`.
  This hashes the sorted `<file SHA-256><two spaces><relative path>` lines,
  including a final newline, from the prepared checkout.

Scope includes the prompt library and per-record task queue, subtitle batch
workflow, license-session renewal, diagnostics and user-action guidance, VIP
workflow previews, and the explicit customer-API points policy. The platform
points wallet/payment implementation remains unavailable; the policy is not
a claim that central billing is operational. The local settings wording and
removal of the official-guide jump are included.

The complete hotspot module already present in main was retained. Its five
shared wiring files were reconciled with local prompt/subtitle/license changes.
No additional remote business overlap was found. Repository governance,
manual-only installer publication, and the cross-platform runtime-import test
fix were retained from main. Trailing whitespace and extra end-of-file blank
lines were normalized only in the isolated export, with no business changes.

### Verification of this batch

- TypeScript `tsc --noEmit`: passed.
- `npm run build`: passed (existing large-chunk warning remains).
- `node --test --test-concurrency=1 tests/*.test.mjs`: 776 passed, 0 failed.
- XHS parser/redirect Python regressions: 6 passed, 0 failed.
- Electron runtime import preflight: passed, 84 files checked.
- Repository hygiene and staged whitespace checks: passed.
- Public-source file list and literal-credential candidates reviewed; matches
  were synthetic tests or interface signatures, not real credentials.
- Local source hashes were rechecked after verification: unchanged from freeze.

Verification ran on macOS with Node `24.21.0`, existing dependencies, and local
bundled assets temporarily linked for tests. Those links, dependencies, and
assets were removed from the export before staging. This is not a clean-install
or Windows/Intel real-device acceptance claim. No new UI login acceptance was
performed; hotspot login diagnosis is a separate read-only task.

This is a source-only synchronization. No installer was generated or uploaded,
no existing release asset was reused, and no update server, production service,
database, or deployment was changed. Local credentials, login entries/sessions,
user databases, real logs, caches, screenshots, temporary files, and large
runtime/model payloads are excluded. Existing source contract/candidate files
are retained as source evidence, not deployed server changes.

## Current local source synchronization (2026-10-15, Asia/Tokyo)

- Application version: `1.1.28`.
- Publication continues PR #9 on `codex/latest-source-20261009`, based on its
  existing `530fff7` head; this is an additive commit, with no history rewrite.
- Input: the immutable source used by the locally validated Windows 1.1.28
  package, frozen at 2026-10-15T16:14:27.992132+09:00 (the exact manifest timestamp
  and digest below are authoritative).
- Canonical packaging manifest SHA-256:
  `312869c6b710314b02b3ca136ad27746202d5a84a62471ac56e00f1a4a2f1e0a`.
- Public inventory: 721 files, excluding this self-referential record.
- Public inventory SHA-256: `b47764c5c9b79e292612b4d1cc0c13d0db214d848496283b09869dc970abb49c`.

This snapshot includes the current customer/platform API selection, points
wallet and operation receipts, expired-quote recovery, partial generation
preservation, Qianchuan account/synchronization fixes, subtitle result recovery
and resumable download, generated-result layout, and the preview-stream and
subtitle lifecycle fixes. Application-specific platform/points Python modules
and their synthetic tests are included; shared production-server references,
actual production configurations, deployment helpers and receipts are excluded.

Remote repository governance, manual-only installer publication, and its
cross-platform runtime-import test assertion were preserved. Trailing
whitespace and extra EOF blank lines were normalized only in the public
export; no canonical working files were reset, switched, or overwritten.
Dependencies, large bundled runtimes, installer binaries, live account data,
credentials, local databases, logs and acceptance artifacts are not published.

Verification of the prepared public snapshot:

- TypeScript and production build: passed.
- Full Node suite: 1005 passed, 0 failed.
- Existing CI command (Feigua/features/runtime contracts): 228 passed.
- XHS Python regressions: 6 passed.
- Application-specific platform Python regressions: 159 passed.
- Application-specific points Python regressions: 38 passed.
- Electron runtime import preflight: 101 files checked, passed.
- Repository hygiene, staged whitespace and literal-credential review: passed.

Tests used existing local dependencies and temporary symlinks to frozen runtime
assets; these links were removed before staging. XHS Python tests used the
existing downloader environment rather than the dependency-free system Python.
Platform vault tests used the real `/private/tmp` directory on macOS, preserving
symlink rejection behavior. No live inference, production deployment, license
mutation or account redemption was performed for this source publication.

The local Windows installer is 1,000,531,338 bytes; SHA-256:
`d436532f7eeaefc439e568de6c841a9e8ca3508a5d05db4ab22984e5de29f476`.
Its payload, code consistency and credential-exclusion checks passed. It is
unsigned and has not undergone Windows-device installation/upgrade acceptance.
It is not uploaded by this source synchronization. A source push is not a main
branch merge or a production release; see PR #9 for its current CI/merge status.
