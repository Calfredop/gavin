---
order: 21504
kind: task
title: "[sec] A cached Companion bundle opens under a forged manifest, so retiring a bundle-signing key never stops the bundles it already signed"
status: Done
priority: low
complexity: moderate
labels: security, ready-for-agent
---
Fix a needs-validation lead from the 2026-10-15 security audit (run-1). It is not confirmed: the audit traced it in source and reproduced it in a sandbox over the real companion-core.wasm, but could not observe it reaching a store build, which today pins no publisher key and so refuses before the cache lookup. The failing regression test below is the proof — write it first and watch it fail. If it already passes before any change, the lead is wrong: record why under a dated "## Comments" heading and move the card to Done with no code change. Fingerprint: `companion-shell/bundle.ts:readyBundle:cache-hit-opens-without-signature-verify`.

Full record: `NEEDS-VALIDATION.md` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

readyBundle checks a Workstation-served manifest only with judgeSigner, which compares the manifest's unauthenticated `signer` string with the trusted-key list. If store.installed(manifest.hash) is true it returns {fetched: false} at once, so fetchArchive and the core's bundleOpen, the only place verify() runs, are skipped. The native cache keeps no signer or verification state: "installed" means only that <hash>/index.html exists, on iOS and on Android. The native open serves any installed hash the hub names.

So once the trust set shrinks, a paired Workstation can open any bundle already in the cache by serving a manifest that names that hash, any currently trusted public key (public data) as signer, and an arbitrary signature. The trust set shrinks when a debug build's dev key is regenerated, when a pinned publisher key is retired in a rotation (§5.5 plans a current+next set where rotation "retires another"), or possibly when an iOS store build is installed over a Debug container with the same bundle id. The cache is shared across Workstations by hash, so the Workstation that names the hash need not be the one that delivered it. Prune runs only after a fresh fetch and keeps every paired Workstation's remembered hash, so a trust change evicts nothing.

The audit reproduced it (sandboxed, the current tree's readyBundle over the real prebuilt companion-core.wasm): a fixture bundle signed by K_OLD was installed under trusted=[K_OLD]. Under trusted=[K_NEW] the genuine manifest was refused, and the forged manifest {signer: K_NEW, signature: 00×64} was refused on an empty cache ("signature does not verify") but OPENED on the populated cache, with fetched=false, one manifest ask and zero core calls. Under the committed store-build trust list (PUBLISHER_KEY null, so trusted=[]) the forged manifest was refused before the cache lookup, so no store build is affected today.

Containment bounds the effect: the bundle webview has no bridge, runs at the naming Workstation's origin, and its closed message set reaches only that Workstation, http(s) links and return-to-hub. The gain is code signed by a retired key drawing arbitrary UI inside the Companion's frame and acting as the Device against a paired Workstation that is already hostile or compromised. It defeats key rotation as the response to a stolen publisher key, for every phone that cached a forged bundle.

## Root cause

bundle.ts treats the presence of a content hash in the native cache as proof of authenticity. The trust decision made at install time (verify() inside the core's bundle-open) is never bound to the cache entry or repeated at load. The only check on the cache-hit path is judgeSigner, over an unauthenticated manifest field.

The security doc already requires the missing check. docs/security/06-companion.md CT-5, row "A poisoned cache" (line 358): "an entry is verified before it is inserted and again when loaded". §5.5, Signing (line 720): "It verifies at fetch and again when loading from the cache." The code does the first and not the second.

## The invariant to enforce

A cache hit opens a bundle only when a key in the CURRENT trusted set has a valid Ed25519 signature over signing_message(manifest.hash). The signature is checked on every load, before the cache lookup, from the manifest alone; the archive is needed only to check that the bytes match the hash, which install already did.

## Trace (lines as of 2026-10-16; re-read before editing)

- `app/companion-shell/src/shell/bundle/manifest.ts:81` (readBundleAnswer, readManifest at 109): The paired Workstation's GetCompanionBundle answer supplies the manifest; only its shape is checked. The channel is Noise-authenticated, so only a paired Workstation, not a Relay, controls it.
- `app/companion-shell/src/shell/bundle/bundle.ts:60` (readyBundle): judgeSigner(manifest, deps.trusted) is the only trust check before the cache lookup.
- `app/companion-shell/src/shell/bundle/trust.ts:46` (judgeSigner): Passes when the claimed signer string is in the list (53); the signature is not examined. An empty list refuses everything (47), which is what bounds store builds today.
- `app/companion-shell/src/shell/bundle/bundle.ts:63` (readyBundle): A cache hit returns {fetched: false}; fetchArchive and bundleOpen (67-75) are skipped.
- `app/companion-shell/ios/App/App/BundleFiles.swift:101` (BundleCache.installed): A 64-hex name with <hash>/index.html present; no signer or verification state. Android's BundleCache.java:55 is the same.
- `app/companion-shell/ios/App/App/BundleViewPlugin.swift:37` (BundleViewPlugin.open): BundleCatalog.folder(for:) serves the cached folder for whatever hash readyBundle returned.
- `crates/companion-wasm/src/lib.rs:362` (Call::BundleOpen): The only caller of protocol::companion_bundle::verify (373).
- `crates/protocol/src/companion_bundle.rs:193` (verify): check_manifest (160), signer_is_trusted (182), the archive size and hash, then the Ed25519 check over signing_message (120). The last step needs only the manifest.
- `app/companion-shell/src/routes/+page.svelte:84` (prune): Runs only after a fetch, keeping each paired Workstation's remembered hash.
- `app/companion-shell/src/shell/bundle/bundle.test.ts:295`: Asserts a cache hit asks only for the manifest and fetches and opens nothing; no test changes the trust set between install and load.

## What the audit could not observe

- Store-build reach needs a pinned PUBLISHER_KEY, which is null in the tree (publisherKey.ts:18), plus either a rotation that retires a key while bundles it signed sit in phone caches or a store install that inherits a Debug container's cache. Neither exists yet. Today only debug builds reach the gap, after a dev-key regeneration, and debug builds are accepted dev-only surface (AD-7, §5.7).
- Whether an App Store or TestFlight install of com.gavin.companion over an Xcode Debug install keeps Library/Application Support/bundles was not observed.

## Fix

Split the signature step out of verify() and run it on every load.

1. In crates/protocol/src/companion_bundle.rs, add `pub fn verify_manifest(manifest: &BundleManifest, trusted: &[[u8; 32]]) -> Result<(), BundleRefusal>`: check_manifest, signer_is_trusted, then the Ed25519 check over signing_message(hash). Have verify() call it and keep its archive size and hash check.
2. In crates/companion-wasm/src/lib.rs, add a manifest-only call (for example `Call::BundleCheck { manifest, trusted_keys }`) that runs verify_manifest. Expose it in app/companion-shell/src/shell/core/core.ts beside bundleOpen.
3. In readyBundle, after judgeSigner and BEFORE store.installed, run the check and throw a BundleError on refusal. A cache hit then means a currently trusted key signed this hash.
4. Optionally, prune the cache when the trust set changes.

Regression tests:

- `crates/protocol`: verify_manifest refuses a manifest whose signer is trusted but whose signature is 64 zero bytes, and accepts a genuine one.
- `app/companion-shell/src/shell/bundle/bundle.test.ts`: install a bundle under trusted=[K_OLD], then call readyBundle under trusted=[K_NEW] with a forged manifest {hash: the cached hash, signer: K_NEW, signature: 00×64}; it must reject with the signature refusal, and store.installed must not decide the outcome. A genuine cached bundle must still open with fetched=false and no archive fetch. Adjust the "cache hit asks only for the manifest" case at line 295 to allow the one manifest-only core call.

## Done when

- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests in the touched crate or module, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched, including the companion-shell suite and the wasm build of companion-wasm.
- The regression test fails before the change and passes after it.
- Follow the CLAUDE.md traps that apply: a new SQLite column needs its own `ALTER TABLE`, a widened request needs a compat-gate entry, and you commit only your own files.
