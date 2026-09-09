---
order: 7168
status: Done
kind: task
title: [sec] give gavin a signed update channel
parent: sec-fix-signing-and-sidecars.md
---
**Severity:** Medium once a build is distributed, Info today. The fourth item of
`sec-fix-signing-and-sidecars.md` (finding **R6**, source **SC-06**, in
`docs/security/README.md`). Promoted out because it is blocked on two decisions
only the human can make, while the other three items of that card are done.

**Why it is separate.** Signing and notarization landed: a downloaded gavin is
sealed, hardened and Gatekeeper-checked, and a swapped `gavin-daemon` inside the
bundle fails `codesign --verify --deep --strict`. What is still missing is the
*channel*: without `plugins.updater` there is no in-app update at all, so every
update is a fresh manual download. That is not unsigned — the OS checks it — but
it is unprompted, so installs go stale, and a stale install is the one a known
bug stays exploitable in.

**Blocked on the human, before any code:**

1. **A keypair, and who holds the private half.** `npx tauri signer generate`
   produces one. The public half is pinned in `tauri.conf.json` and is meant to
   be committed and reviewed; the private half signs every update forever, so
   losing it means no install can ever be updated again and leaking it means
   anyone can push code to every install. It is a bigger custody question than
   the Developer ID certificate, which Apple can at least revoke. See the key
   custody section of `docs/RELEASING.md`.
2. **An endpoint that exists and stays up.** Either a static `latest.json`
   (GitHub Releases can host it) or a dynamic endpoint. It is a URL every
   install polls, forever.
3. **The decision itself.** An updater is a channel that delivers code to a
   running install. That is worth having, and it is worth choosing on purpose
   rather than because a checklist item said so.

**Then the work:**

- `tauri-plugin-updater` in `app/src-tauri/Cargo.toml`, registered in `lib.rs`,
  with its permission in the capability file — check whether the plugin errors
  at startup when `plugins.updater` is absent, and if it does, register it
  conditionally so a dev build without the block still runs.
- `plugins.updater` in `tauri.conf.json`: `pubkey` (the committed public half)
  and `endpoints`.
- `bundle.createUpdaterArtifacts: true`. Note the bundler errors with
  "configured to create updater artifacts but no updater-enabled targets were
  built" unless an updater-capable target is in `bundle.targets` (`app`,
  `appimage`, `nsis`, `msi`).
- `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as
  secrets in `.github/workflows/release.yml`, added to the `preflight` gate
  beside the others, and the `.sig` files added to the uploaded artefacts.
- A UI surface. There is none today; decide where an available update appears
  and whether it ever installs without being asked. It must not restart a
  window that owns live agent sessions without warning.
- `docs/RELEASING.md` has a "Not done yet" section that this card closes.
