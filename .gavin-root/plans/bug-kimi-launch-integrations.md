---
title: [bug] kimi launches: compressed-launch auth, subfolder trust screen, default permission mode
status: In Progress
---
Three fixes to how gavin launches kimi, diagnosed from live wire logs (~/.kimi-code/sessions, sessions of 2026-10-06) on 2026-10-07.

## 1. Compressed launches died with OAuthUnauthorizedError

Symptom: starting a task from a card opened kimi and failed with `Stored token for "kimi-code-env-…" was rejected; re-login required` even though `kimi login` was healthy.

Cause: Headroom compression points kimi at a session-tagged `KIMI_CODE_BASE_URL`, which re-derives the credential slot kimi reads (`kimi_credential_slot`, sha256 of {oauthHost, baseUrl}) — a different slot per session. `provision_kimi_credential` (crates/daemon/src/headroom/compress.rs) copied the user's token in at launch, but tokens live 15 min (`expires_in: 900`), refresh rotation kills older copies, kimi WIPES a slot whose refresh is rejected, and the old never-overwrite rule left dead slots dead forever.

Fix: provision from the FRESHEST credential on disk (largest `expires_at`); overwrite a target that is older or wiped; leave a target alone only when at least as fresh as every source. Unit tests updated/added in compress.rs.

## 2. Card launches in subfolders stopped at kimi's trust screen

Symptom: develop on a card "opened the tab with the prompt but the session never started".

Cause: kimi keys its folder-trust record on the exact process cwd; a trusted parent does not cover a child (proved 2.1.1). Cards launch in context folders below the workspace root, where no record exists — kimi stopped at the trust screen before any MCP server started, so the daemon's queued bracketed-paste prompt landed on the wrong screen and was lost.

Fix: `prepare_kimi_launch` (app/src-tauri/src/agent_setup.rs, wired into create_session in session.rs) writes the launch cwd its own record when, and only when: cwd is strictly inside the workspace root; no `.mcp.json`/`.kimi-code/mcp.json` sits between cwd and root; the root's own files declare nothing beyond gavin's server; no record already exists. A withheld grant leaves kimi asking, the pre-existing behavior.

## 3. Default permission mode

Symptom: every gavin-spawned kimi session started in `manual` mode and stalled at its first tool call until the human switched modes.

Fix: `ensure_kimi_permission_default` writes `default_permission_mode = "yolo"` ("Ask When Needed" — routine work runs, risky things still ask; the CLI's own `-y` semantics) into ~/.kimi-code/config.toml when the human has not chosen a value; an existing value (any, including manual) and unparseable TOML are left untouched. Also applied live to this machine's config.toml on 2026-10-07 (backup: config.toml.gavin-bak).

## 4. Stuck in "working" forever: OSC 133 poisoning (2026-10-08)

Symptom: kimi tabs kept showing Working long after the session stopped, so a session that was asking the human a question never raised the waiting_for_input badge.

Cause: the daemon's pump loop armed permanent OSC-133-only status detection on ANY 133 marker (one-way switch that kills the 2s quiet-timer heuristic). Captured from a live kimi TUI's PTY stream: kimi emits A;B;C at startup and per prompt submission, then only B;C pairs around each tool result — its LAST marker is always C (Working), even sitting at the prompt. After any tool-using turn: last event C → status pinned `working`, quiet timer dead.

Fix, two layers:
- crates/daemon/src/status.rs: `StatusEvent::Idle` is now `Idle { prompt: bool }` (A/D = prompt marker, B = output-ended framing). Only A/D arm the permanent switch; B before the switch is ignored (framing); C before the switch merely mirrors the output heuristic. Covers agents that never emit A.
- The decisive layer, for kimi specifically: new `Request::DistrustOsc133 { id }` (protocol v60). AgentProfile gains `untrusted_osc133` (true only on the kimi-code row), exposed through AgentProfileDto → settings.ts ResolvedAgent → every armFailureDetection call site. The daemon keeps a per-session distrust set and, under distrust, drops EVERY 133 marker (including A — kimi emits A amid redraw spam per prompt), keeps the quiet-timer heuristic as the authority, and still honours the bare-BEL waiting_for_input signal. A-gating alone was insufficient (kimi's startup A poisons the switch before the app can arm distrust, so all seen_osc133 consumers consult `!distrusted`; a stale armed switch is thereby neutralised).

## 5. Hooks: kimi never signals attention (2026-10-08)

Symptom (second report): a kimi session waiting on the human gave no waiting_for_input badge. kimi emits no bare BEL and no attention OSC when asking; its question pickers render fullscreen and then go silent.

Fix: `ensure_kimi_launch_config` (agent_setup.rs, generalised from `ensure_kimi_permission_default`) also writes `~/.kimi-code/gavin-attention` (a script: drain stdin, `printf '\a' > /dev/tty`, exit 0) and merges `[[hooks]]` entries into ~/.kimi-code/config.toml for PermissionRequest, StopFailure, Notification (task.completed/failed) and TaskStarted(question) — each running the script. The daemon already maps a bare BEL to waiting_for_input, so kimi's question/approval dialogs now raise the badge. Merge is idempotent per event and preserves human-authored hooks; kimi hooks are observation-only, so the script can never block the agent. Applied live to this machine's config on 2026-10-07.

## Follow-ups NOT done here

- Daemon-side launches (orchestration rail steps, headless runs in .gavin-worktrees) do not pass through the app's create_session, so they get no launch-time trust grant; kimi's trust-key derivation would need to move into a shared crate.
- Gavin retries a failed run by re-delivering the prompt (observed double user messages in failed sessions); harmless once auth is fixed, but worth a look.
- `startMainAgentWithPrompt` (layoutState.ts) still errors for kimi (promptArgs null + no prompt-injection branch).
- Against a daemon older than v60, DistrustOsc133 is refused and kimi keeps the old OSC 133 behaviour (stuck-in-working) — rebuild the daemon to get the fix.
- The hook chain (kimi fires PermissionRequest → script writes BEL → daemon maps BEL → waiting_for_input) is unit-tested only as far as the BEL; a real kimi approval dialog has not been observed end-to-end yet.

## Verification

- cargo test -p protocol: 216 passed (incl. new v60 band pin). cargo test -p gavin-daemon: 1018 passed (incl. the two new distrust tests). cargo test -p app --lib: 740 passed. App vitest: 7545 passed; svelte-check: 0 errors.
- Live: `default_permission_mode = "yolo"` verified — TUI footer shows "Ask When Needed"; `kimi -p` still forces `auto` in print mode (wire-checked).
- Live: trust screen reproduced in a subfolder before the fix; record shape already covered by byte-exact tests.
- LIVE E2E PENDING: the running dev daemon predates all of these fixes — rebuild and restart (scripts/start-dev-mac.sh), kill the stuck session be43957c, then run a fresh kimi card develop to verify end-to-end.
