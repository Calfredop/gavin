---
order: 13312
kind: task
title: "[perf] agent_usage probes every profile on the main thread"
labels: bug
parent: perf-main-thread-command-audit.md
status: Done
---
`agent_usage` (app/src-tauri/src/agent_usage.rs:156) is a plain `fn`, so every
usage probe — `security`, `claude --version`, curl, sqlite3, file walks — runs
on the main thread. Measured 1.1–1.6 s of main-thread time per minute; the
single biggest freeze left after the `pr_status` fix.

## Evidence (2026-09-26)

- Anthropic probe: spawns `security` (agent_usage.rs:274) and
  `claude --version` (:226, never cached), then curl via `run_curl`
  (:386-413), blocking in `wait_with_output`, `--max-time 10` (:65, :326).
- Gemini: up to three curls per probe — refresh (:1248), quota (:1141),
  refresh-and-retry on 401 (:1161-1171), `loadCodeAssist` on 403 (:1230).
  The refreshed token is never saved, so every poll after expiry refreshes
  again. Cursor: `security` (:752), `sqlite3` fallback (:773). Codex: walks
  `~/.codex/sessions`, reads up to 20 whole rollout files (:557-568).
- Trigger: `startPauseClock` (layoutState.ts:1387) → `pollAll` now and every
  180 s (agentPauseState.ts:91, :508, :516), a `Promise.all` over
  `profilesInUse()` (:269) — 4 profiles here. Sync commands serialise on the
  main thread, so the freeze is the SUM of the four. The host's 120 s floor
  (:54) is shorter than the 180 s poll, so every poll is a real probe. It
  repeats per window (see the pollers card).
- Worst case: a network that hangs connections makes each of 5–7 curls hit
  its 10 s limit — 50–70 s frozen. Unverified but possible: a Keychain item
  whose ACL does not trust `/usr/bin/security` waits on a macOS
  allow-access dialog while the app is frozen.

## Fix

- `async fn agent_usage(app: AppHandle, profile_id: String, force: bool) -> Result<UsageReport, String>`,
  the probe in `spawn_blocking`, `app.state::<UsageCache>()` fetched inside
  the closure.
- Per-profile in-flight dedupe: hold a per-profile mutex across the probe
  and re-check the cache once acquired. Today the main thread's
  serialisation is the only thing stopping two windows, or a poll plus a
  forced refresh, from both missing the cache and both hitting the
  rate-limited endpoint.
- Cache `claude_version()` once per process; persist gemini's refreshed
  token (or cache it in memory until expiry).
- Frontend: `refreshUsage` (agentPauseState.ts:156-182) has no
  supersession guard — an older poll can overwrite a forced refresh once
  answers arrive out of order. Add a per-profile counter, or keep the
  reading with the newer `observedAt`.

## Verify

Add `agent_usage` to `OFF_MAIN_THREAD` in
`app/src/lib/guards/mainThreadCommands.test.ts` (red first). Unit-test the
dedupe (two concurrent probes, one real call) and the frontend guard. Then
`sample` the main thread across a 180 s poll: `agent_usage` gone.

## Done (2026-09-26, 46a88c3b on perf/main-thread-commands)

- `agent_usage` is `async` + `spawn_blocking`, with the cache fetched
  inside the closure. It is in `OFF_MAIN_THREAD` (red first).
- Per-profile probe lock. A caller notes the profile's probe generation
  when it arrives, and a probe that lands while it waits answers it, forced
  or not. Tested without sleeps: a forced refresh pinned while a poll's
  probe is provably in flight makes no second call. Removing the rule
  turns that test red. Also tested: a forced refresh with nothing in
  flight still probes, a 429 park still holds a forced refresh, and a
  slow profile does not hold up another.
- `claude --version` is asked once per process (`OnceLock`).
- Gemini's refreshed token is kept in memory until it expires, keyed on
  its refresh token. It is not written back to `oauth_creds.json`,
  because that file belongs to Gemini CLI and a gemini session refreshing
  at the same moment would race the write. A refresh that fails forgets
  the kept token.
- `refreshUsage` drops an answer, or a failure, that lands after a newer
  call's answer. A failure never counts as landing. The refreshing badge
  is cleared only by the newest call. All three tests fail when the guard
  is removed.
- Codex's rollout walk is unchanged. It is off the main thread now, and
  the card did not ask to change it.
- Checks: `cargo test --workspace`, `npm test` (6540), `npm run check`
  (0 errors) and `npm run build` all pass.
- `gavin_request_human` was refused because the daemon speaks v41 and
  gavin-mcp speaks v42, so the test below was filed by hand.

- [ ] Human test: In an app built from perf/main-thread-commands, with the usual four agent profiles in use, run `sample <Gavin pid> 200 1 -file /tmp/usage.txt` across one 180 s usage poll, and press refresh in the usage panel once during it. The sample should show no `app_lib::agent_usage` frames on the main thread, typing into a terminal should not stall during the poll, and the usage panel's bars should still fill in and update after the refresh.
