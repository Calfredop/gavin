---
kind: task
title: A Headroom update whose model fetch fails leaves the old proxy serving under the new version, with no retry
status: Done
priority: medium
complexity: moderate
---
Branch `feat/headroom` (headroom-04, e170016d; still true at c1de88b8). Work in `.gavin-worktrees/feat-headroom`.

## The defect

headroom-04 made the daemon swap a running Headroom when an install changes it. The rule is at `crates/daemon/src/headroom/mod.rs:410`:

```rust
if outcome.succeeded && (after.path, after.version) != (before.path, before.version) {
    this.inner.supervisor.replace();
}
```

It has two holes.

1. **A failed prefetch skips the replace.** `install::install` (`crates/daemon/src/headroom/install.rs:201-231`) returns `succeeded: false` when the compression-model prefetch fails, and when the tool's Python is not found. Both happen AFTER `uv tool install` has already put the new package in place. The code's own comment says so: "a failed prefetch still leaves a Headroom installed". So the version changed, but `replace()` is never called.
2. **Detection never replaces.** Check again and Locate… go through `detect()` (`mod.rs:199`), which looks and nudges but never compares with what is running. The test above compares two detections, not the detection with the running process.

The UI then has no way out. Once the stored version equals the pin, `headroomActions` (`app/src/lib/agents/headroomSetup.ts:156-169`) offers only `["check-again"]` beside "The install failed." There is no retry of the fetch, and no action that restarts the proxy, short of turning every workspace off and on again.

## The cases that break it

- **Case A (confirmed with an experiment test):** a fake Headroom 0.38.0 is running. Update runs; uv installs 0.39.1; the prefetch Python exits 1. The result: install `failed`, `status.version` 0.39.1, `run.process.version` still 0.38.0, and the same pid keeps serving. Settings shows 0.39.1 at the pin, with only Check again.
- **Case B (traced):** 0.38.0 is running. The human runs `uv tool upgrade headroom-ai` in a terminal, then presses Check again. The status reads 0.39.1, Update is not offered, and the proxy stays on 0.38.0's already-imported code.
- **Case C (traced):** the release and dev daemons share `~/.local/bin/headroom`. An Update from one daemon swaps the package under the other daemon's running proxy, and that daemon never replaces it.

## What to do

1. Make the replace rule "the recorded running process (`RunRecord.process`, `store.rs:57`: its version, and its path if you add one) differs from the stored install record". Check it in the supervisor, or after both `install` and `detect`. That one rule covers all three cases. Keep "never replace a Headroom this daemon did not start".
2. Offer a way to re-run the prefetch when the last install failed but the version is at the pin. Either keep `install`/`update` in `headroomActions` while `status.install?.state === "failed"`, or add a distinct retry action. Cover it in `headroomSetup.test.ts`.
3. Add a daemon test for Case A against the fake installer. Remember the headroom-04 trap: on macOS, `cp` over a running binary kills the process, so the fake must rename into place.

Run `cargo test -p gavin-daemon` (headroom modules), then `cd app && npm test -- headroomSetup`.
