---
complexity: moderate
order: 11264
kind: plan
title: [feat] installers
status: In Progress
---
Create a pipeline that compiles macOS and Windows installer upon remote main push and publishes a release.

Developed 2026-10-13: publish a **Preview build** (`CONTEXT.md`) of Gavin — unsigned macOS arm64 and Windows x64 installers on one rolling GitHub pre-release — from a local script on this Mac, started by hand from a Gavin tool.

**Settled in the interview — do not re-open:**

- **Local, not GitHub Actions.** No new workflow. `release.yml` stays the signed, tag-triggered path and is not touched. No Linux, no signing secrets, no updater (`latest.json`), no Companion store build — the Companion bundle is signed with this Mac's dev key, so only debug Companions run it.
- **Source is `origin/main`'s committed tip**, built in its own detached worktree at `~/Library/Caches/gavin-preview` with its own `target/` — never the shared dirty checkout, and apart from `install-release-mac.sh`'s `gavin-release`.
- **Gates before publishing:** the commit is on `origin/main` (the script fetches; it never pushes), `ci.yml` passed on it (`gh run list --commit`; `--force` skips this one), and a lock stops two runs at once.
- **Published as:** tag `preview`, a pre-release, never "Latest", replaced each run. Fixed asset names `Gavin-preview-macos-arm64.dmg` and `Gavin-preview-windows-x64-setup.exe`. Notes carry commit SHA, build number (`bundle.mjs`'s commit count), date, and the unsigned-install steps (`xattr -dr com.apple.quarantine` on macOS; SmartScreen's *More info → Run anyway* on Windows).

- [x] Windows installer cross-compiled on this Mac — nested card `feat-installers-windows-cross-compile.md`; read its conclusion before the Windows step below.
- [x] `scripts/publish-preview.sh` (POSIX sh, in `install-release-mac.sh`'s style) builds the macOS arm64 `.dmg` ad-hoc signed (`APPLE_SIGNING_IDENTITY=-`) through `bundle.mjs`, and it passes `verify-macos-bundle.sh --allow-adhoc`.
- [x] The same script builds the Windows setup `.exe` the way the nested card concluded — or, if cross-compiling was ruled out there, takes `--windows-exe PATH` (built on the Windows machine with `build-windows-installer.ps1`) and refuses to publish without one.
- [x] Gates: publishing refuses a commit not on `origin/main`, one without a green `ci.yml` run (unless `--force`), and a second concurrent run — each refusal names the gate.
- [x] `--dry-run` builds and stages both files under their final names with their notes, uploading nothing; `--ref REV` builds a local commit and is only allowed with `--dry-run`. Proven by a dry run of a local commit, both files present.
- [x] The publish step replaces the `preview` release (pre-release) with both assets and the notes. Proven against a scratch tag on this repo, deleted afterwards — never on `preview` itself.
- [x] Gavin tool **Publish Preview build** (`kind: script`, cwd the workspace root, icon `package`, body `scripts/publish-preview.sh {{flags}}`, one param `flags` labelled "Extra flags (--force skips the CI check, --dry-run builds without publishing)") saved with `gavin_save_tool`.
- [x] README *Install* leads with downloading the Preview build (both fixed asset URLs + the unsigned-install steps); building from source becomes the second route.
- [x] `docs/RELEASING.md` gains a short *Preview builds* section: what it is, how it differs from the signed tag path, and that `release.yml` is unchanged.
- [ ] Human test: after pushing, run **Publish Preview build** from the app — the `preview` pre-release appears with both assets and correct notes, not marked Latest.
- [ ] Human test: on a Mac other than the build machine, download the `.dmg`, follow the notes' `xattr` step, install and launch — sessions start.
- [ ] Human test: install the cross-compiled setup .exe on Windows 11 and launch it; a session starts and the gavin_* tools answer

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
