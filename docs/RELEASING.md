# Releasing gavin

A release is a promise: this file came from that commit, and nobody
touched it in between. Everything here exists to make that promise
checkable by somebody who does not trust the person making it.

The audit that produced this document is [`security/README.md`](security/README.md);
this is the fix for its **R6** (`SC-06`, `SC-07`, `SC-08`). The short version
of the problem: gavin's bundle carries `gavin-daemon`, which owns every
session's PTY, stdin and queued input, and `gavin-mcp`, whose absolute path
gavin writes into each workspace's agent config so that every agent the
human launches executes it. Unsigned, those two are the most valuable
things in the bundle and the easiest to replace.

Until gavin is actually distributed, none of this needs doing. Nothing in
`npm run tauri dev` or `cargo test` touches it.

## What produces a release

`.github/workflows/release.yml`, on a `v*` tag. It builds macOS (arm64 and
x86_64), Linux and Windows, signs each one, verifies each one, composes the
updater's `latest.json` from the signatures those builds produced, and
uploads the results as workflow artefacts.

It deliberately does **not** create a GitHub release. The workflow token is
`contents: read`; publishing is a human act, done by downloading the
verified artefacts and attaching them to a release by hand. A tag-triggered
workflow with write access to the repository is a bigger hole than the one
it would be closing.

### The build host

**A GitHub-hosted ephemeral runner**, not a laptop. This is the part that
changed: when the audit was written there was no CI at all, so the build
machine was the developer's own Mac — the exact machine adversary A1 is
defined on, and the one place where a compromise silently becomes a signed
release. A fresh runner per job means the only things a release trusts are
GitHub's runner images, the four third-party actions (each pinned to a
commit SHA, never a tag — a tag can be moved by whoever holds it), and the
lockfiles in the repository.

Building a release by hand on the laptop is still possible (`cd app && npm
run bundle`) and is fine for testing the packaging. It is not a release: it
has no attestation of where it came from, and the signing key should not be
on that machine at all.

### `--locked`, in two places

`stage-sidecars.mjs` builds `gavin-daemon` and `gavin-mcp` with `--locked`,
and `npm run bundle` passes `--locked` through to the cargo invocation the
Tauri CLI makes for the app itself. Without it, a manifest edit that no
longer matches `Cargo.lock` is silently re-resolved on the build host, and
the tag no longer reproduces the binary. `npm ci` gives the frontend the
same guarantee.

`preflight` additionally refuses a tag whose name disagrees with
`bundle.version` in `tauri.conf.json`, so a downloaded artefact can always
be traced back to a commit.

## Key custody

Every secret below lives in **GitHub Actions repository secrets**, and
nowhere else that is backed up, synced or shared. The private halves belong
to one named human; the rule is that no key material is ever on a machine
that also runs agents.

`preflight` fails the run when any of them is missing, before a single
build starts. That gate is the point of this whole document: Tauri's
bundler treats a missing identity as *skip signing* and a missing
notarization credential as a warning, so an unsigned release is otherwise a
green build with a line of yellow text in it.

If gavin only ever ships one platform, **delete the other platforms' jobs
and their preflight entries**. Do not put placeholder values in the
secrets: a skipped platform should be a visible edit to this workflow, not
an accident nobody notices.

| Secret | What it is | Where it comes from |
|--------|-----------|---------------------|
| `APPLE_CERTIFICATE` | base64 of a *Developer ID Application* `.p12` (certificate + private key) | Apple Developer account → Certificates; export from Keychain Access, then `base64 -i cert.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the password set on that `.p12` | chosen at export |
| `APPLE_SIGNING_IDENTITY` | the identity string, e.g. `Developer ID Application: Name (TEAMID)` | `security find-identity -v -p codesigning` |
| `APPLE_API_ISSUER` | App Store Connect API issuer UUID | App Store Connect → Users and Access → Integrations |
| `APPLE_API_KEY` | that key's Key ID | same page |
| `APPLE_API_KEY_P8` | the contents of the downloaded `AuthKey_*.p8` | downloadable exactly once, at creation |
| `WINDOWS_CERTIFICATE` | base64 of a code-signing `.pfx` | see the Windows note below |
| `WINDOWS_CERTIFICATE_PASSWORD` | the password on that `.pfx` | chosen at export |
| `LINUX_GPG_KEY` | base64 of `gpg --export-secret-keys --armor <id>` | generated once, for releases only |
| `LINUX_GPG_KEY_ID` | that key's id or fingerprint | `gpg --list-secret-keys --keyid-format=long` |
| `LINUX_GPG_KEY_PASSWORD` | its passphrase, if it has one | optional; `preflight` does not require it |
| `TAURI_SIGNING_PRIVATE_KEY` | the updater's minisign private key — the contents of the file `tauri signer generate` wrote | `npx tauri signer generate -w gavin-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its passphrase | chosen at generation; **required**, for the reason below |

The App Store Connect API key is used rather than an Apple ID and an
app-specific password because it is scoped to notarization, is revocable on
its own, and carries no account password. The workflow writes it to a file
outside the workspace (`notarytool --key` wants a path), and deletes it in
an `if: always()` step.

**The updater key is the odd one out**, and is why `preflight` requires
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` while it leaves
`LINUX_GPG_KEY_PASSWORD` optional. Every other key here signs something a
human chooses to download and the OS then checks. This one signs code a
running install accepts and executes on its own, and there is nothing to
revoke: the public half is compiled into every build that has ever
shipped, so a leaked private key can push code to all of those installs
until each is replaced by hand, and a lost one means none of them can
ever be updated again. `tauri signer generate` will happily produce an
unencrypted key, and nothing downstream would complain — the CLI treats a
missing password in CI as an empty one. Hence the gate.

Generate it on a machine that does not run agents, keep the master copy
off the machine that builds, and put only a copy in the GitHub secret.
The public half goes in `plugins.updater.pubkey` in
`app/src-tauri/tauri.conf.json`, committed and reviewed like any other
line of config; `preflight` refuses a release whose pubkey is empty,
which is what stops the repository's placeholder shipping by accident.

**Rotation.** Revoke and re-issue on any suspicion, and on every change in
who holds them. Apple's Developer ID certificate outlives most of them —
five years — which makes it the one worth watching: a revoked certificate
invalidates signatures made with it unless they were notarized, which is a
second reason notarization is not optional here. Rotating the UPDATER key
is a different act, because there is nothing to revoke: a build signed
with the new key is only accepted by an install that already carries the
new public half, so the rotation has to reach existing installs through
one last update signed with the OLD key. Anything older than that has to
be downloaded again by hand.

## What each platform gets

### macOS

`bundle.macOS.hardenedRuntime` is `true` and `bundle.macOS.entitlements`
points at `app/src-tauri/entitlements.plist`. That file grants **nothing**:
every key in it is `false`, and its comment enumerates what gavin does
(spawns the sidecars and agent CLIs, opens PTYs, shells out to `security`
for the Claude Code OAuth token, renders in WKWebView) and why none of it
needs a hardened-runtime exception. Library validation stays on, which is
what stops `DYLD_INSERT_LIBRARIES` and an unsigned dylib dropped beside the
app.

The bundler signs `gavin-daemon` and `gavin-mcp` individually and then
seals the bundle around them, so a swapped sidecar is caught by
`codesign --verify --deep --strict` — verified by replacing
`Contents/MacOS/gavin-daemon` in a built bundle, which reports
`nested code is modified or invalid`.

Notarization and stapling happen in the same `tauri build`, because the
`APPLE_API_*` variables are present. Stapling matters for a first launch
with no network.

Two runners, one per architecture, rather than a universal binary:
`stage-sidecars.mjs` stages the sidecars under the **host** triple from
`rustc -vV`, which is the target triple only when the two match.

### Linux

There is no OS-level code signature. Every `.deb`, `.rpm` and `.AppImage`
gets a detached OpenPGP signature, plus a signed `SHA256SUMS`. Publish the
public key once, somewhere with its own trust story, and the check a
downloader runs is:

```
gpg --verify SHA256SUMS.asc SHA256SUMS && sha256sum -c SHA256SUMS
```

If gavin ever publishes an apt or dnf repository, that is the same key that
signs its metadata, and `dpkg-sig` / `rpmsign` embed a signature in the
packages themselves. Detached signatures are the honest minimum until then.

### Windows

`bundle.windows.digestAlgorithm` is SHA-256 and `timestampUrl` is set, so
signatures keep verifying after the certificate expires. The workflow
imports the `.pfx`, reads back the thumbprint the import produced, and
passes it to `tauri build` as a generated config overlay — a thumbprint
identifies the certificate and belongs with the secret, not in the
repository. `signtool verify /pa /tw` afterwards is what actually proves
the installer is signed *and* timestamped; the bundler prints a line either
way.

**The `.pfx` route only works for a private or legacy certificate.** Since
mid-2023 the CA/Browser Forum requires the private key of a publicly
trusted code-signing certificate to live on certified hardware or in a
cloud signing service, so it cannot be exported into a GitHub secret at
all. The route for such a certificate is
`bundle.windows.signCommand` — a command with a `%1` placeholder for the
binary path, pointed at the provider's CLI (Azure Trusted Signing, DigiCert
KeyLocker, SSL.com eSigner). Swap the import step for that provider's
authentication step when the certificate is bought; everything else in the
job stays.

## The checklist

1. The tree is clean, the tests pass (`cargo test --workspace`; `cd app &&
   npm test && npm run check && npm run build`), and CI is green on the
   commit being tagged.
2. `version` in `app/src-tauri/tauri.conf.json` is the version being
   released. Commit that bump on its own.
3. `Cargo.lock` and `app/package-lock.json` are committed and match the
   manifests. `--locked` will otherwise fail the build, which is the
   intended outcome, but failing at step 3 is cheaper.
4. Every secret in the table above is present. `preflight` checks this, but
   check it first if any of them was rotated. It also refuses a release
   whose `plugins.updater.pubkey` is empty.
5. Tag and push: `git tag -a vX.Y.Z -m 'gavin X.Y.Z' && git push origin vX.Y.Z`.
6. Watch the run. Every job must be green: green means signed, verified and
   — on macOS — notarized and stapled.
7. Download the artefacts.
8. Re-verify on a machine that is not the build host:
   `./scripts/verify-macos-bundle.sh /Volumes/Gavin/Gavin.app` after
   mounting the `.dmg`, and `gpg --verify` on the Linux set. Verifying what
   was downloaded, not what was uploaded, is the only version of this check
   that means anything.
9. Create the GitHub release by hand, attach the artefacts, and publish the
   OpenPGP public key alongside them. **Attach `latest.json` too, and
   attach every file it names under the name it names** — the manifest
   points at `releases/download/<tag>/<file>`, so a renamed or omitted
   artefact is an install that can never update. Open one URL from it in
   a browser before calling the release done.

## Verifying a bundle by hand

```
./scripts/verify-macos-bundle.sh /path/to/Gavin.app
```

Checks, in order: both sidecars are present (their absence was the
`SC-08` bug — a bundle that fails at first launch); the whole bundle
verifies `--deep --strict`; every Mach-O carries the hardened runtime; the
embedded entitlements grant nothing; one Team ID across all three binaries;
Gatekeeper accepts it as notarized; the ticket is stapled.

`--allow-adhoc` downgrades the last three to warnings so the rest can be
run against a local `codesign -s -` build. Never pass it in CI, and note
that a bundle that only passes with the flag is not distributable.

## The updater

An update that is only ever a fresh manual download is an update most
people do not make, and a stale install is the one a known bug stays
exploitable in. So gavin has a channel. Precisely what it is:

**The key is pinned; the URL is not.** `plugins.updater.pubkey` is
committed and compiled in. `plugins.updater.endpoints` is a default each
install can override from **Settings › Updates**, and that asymmetry is
the whole security argument: minisign verification happens against the
pinned key before a single byte is installed, so an endpoint can offer
gavin anything at all and gavin refuses every bit of it. A configurable
URL therefore costs nothing. A configurable key would cost everything,
and no command in the app can write one.

**Nothing installs itself.** One check when the app starts and nothing
after it — there is no timer. An available update appears as a version
beside Settings in the sidebar footer and as a line in Settings ›
Updates, and installs only when somebody presses the button and answers
the prompt.

The prompt says what installing actually does *here*, which is the part
peculiar to gavin. The app quits and relaunches, and every session
survives, because the daemon owns them and outlives the window. But the
update also replaced `gavin-daemon` inside the bundle, and the daemon
that is *running* was exec'd from the old copy: it keeps running the old
code until Settings › Daemon restarts it, and that restart ends every
session it holds. So the prompt counts the live sessions and says so
before the click rather than after.

**The page cannot reach the plugin.** `updater:default` grants `check`,
`download` and `install` to the webview, and is deliberately absent from
`capabilities/default.json`. Tauri defines `__TAURI_INTERNALS__` on every
page, so any permitted command is reachable by name from whatever is
running in gavin's origin (AS-01/R5), and `plugin:updater|download_and_install`
reachable that way is a code-execution primitive one `invoke` from a
rendered markdown file. What the webview reaches instead is
`app/src-tauri/src/updater.rs`: `check_for_update`, which only reads, and
`install_update`, which spends a `confirm_gate` token bound to the exact
version the prompt named — and which re-checks that the endpoint still
offers that same version before installing it.

**`createUpdaterArtifacts` lives in its own overlay.**
`app/src-tauri/tauri.updater.conf.json`, passed only by the release
workflow. Not in `tauri.conf.json`, because the CLI turns "a pubkey is
configured and artefacts were asked for" into a hard error when
`TAURI_SIGNING_PRIVATE_KEY` is absent — which would break the `npm run
bundle` that this document says is fine for testing the packaging on a
laptop. A release has the key; a laptop does not; the overlay is where
the two part company.

**`latest.json` is composed by CI, not by hand.** The `manifest` job
reads the `.sig` files the three build jobs produced and writes the
manifest from them, failing the run if any platform is missing one. A
base64 signature pasted into a file by a human is a signature that can be
pasted into the wrong platform's entry, and nobody finds out until an
install refuses an update — or accepts one meant for another
architecture. The URLs it writes point at
`releases/download/<tag>/<file>`, which is a promise rather than a fact
until step 9 of the checklist attaches those artefacts to that tag under
those names.

That job also makes the one check Tauri leaves as a warning. The CLI
compares the key it signed with against the configured `pubkey` and, when
they disagree, prints a line of yellow text and finishes green — so a
release signed with the wrong key looks exactly like a good one, and the
damage shows up later as every install refusing every update forever.
The `manifest` job compares each signature's key number with the pinned
one and fails the run instead. This is the check that matters during a
key **rotation**, which is the only time the two realistically diverge.

**The endpoint has to be somewhere public.** The committed default is
`https://github.com/Calfredop/gavin/releases/latest/download/latest.json`,
which resolves only once the repository — or a separate releases
repository — is public: a private repo's release assets need an
`Authorization` header, and there is no header an app can ship. Until
then the launch check fails and says nothing, which is designed
behaviour and not a fault (`shouldSurfaceCheckError` in
`app/src/lib/updates.ts`), and any install can be pointed elsewhere from
Settings in the meantime.

## Not done yet

**Nothing.** The updater was the last item of the card behind this
document. What remains is not work but a first run: no tagged release has
happened, so everything needing a real Developer ID, a real Windows
certificate or a real runner — notarization, stapling, the Gatekeeper
assessment, the whole Linux and Windows jobs, and every line of the
updater path beyond a local build — has never executed. Expect the first
tagged release to need fixes, and read a red job on it as information
rather than as a regression.
