# Source import snapshot

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

## Latest local source synchronization (2026-10-09, Asia/Tokyo)

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
