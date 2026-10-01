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
