---
order: 7296
kind: task
title: Headroom 04: the setup surfaces
status: Done
labels: ready-for-agent
parent: headroom.md
complexity: complex
---
Blocked by: headroom-01-daemon-runs-headroom.md, headroom-02-compressed-launches-claude-code.md

Part of `headroom.md`. Read the spec (sections "Detection and install", "The switch" and "Platforms") first.

## What to build

- **A Headroom section in the app-wide Settings** (`GlobalSettingsView.svelte`'s `SECTIONS`) showing:
  - the state (Verified, Too old, Absent, Unavailable with its reason), the version and the pin, with "newer than tested" when above it
  - running, stopped or failed, and the port
  - lifetime tokens saved
  - **Install** when `uv` is found (it calls 01's install and prefetch); otherwise the install command, **Locate…** and **Check again**
  - **Update** when the pin moves past the installed version. It asks first through `askConfirm`, never a native dialog, and says running compressed agents will retry once.
  - the app-wide default switch, starting Off
  - help text naming the one residual: commands an agent runs inherit its routing
- **The workspace switch** in the workspace Settings' Agent section (`SettingsHubView.svelte`). It shows Unavailable for an ssh workspace, and for a profile with no recipe it gives the reason: "Cursor sends everything through Cursor's servers — Headroom can't reach it", and Gemini's until 07.
- **A Headroom wizard step** after Superpowers in `SETUP_STEPS`. It offers On when Headroom is Verified and the install when it is Absent. Count it everywhere steps are counted, and do not let an unknown state read as absent (the setupProgress `pending` trap).
- The logic goes in a plain `.ts` module with unit tests; the `.svelte` files stay thin.

## Acceptance criteria

- [x] Every state renders its own actions from the pure module (tested)
- [x] The wizard's step count and done-ness include Headroom, and an unknown state is pending, not absent (tested)
- [x] The Update confirmation uses `askConfirm`, and a `danger` choice keeps focus on the dismissing button
- [x] `npm test`, `npm run check` and `npm run build` green
- [ ] Human test: on a machine without Headroom, Install from Settings finishes, the first compressed run does not stall on a model download, and the Settings section and wizard step look right

## Result (2026-09-29)

Done on branch `feat/headroom`, commit `e170016d`, on top of 03's `a4bb26eb`. Not pushed. **No protocol bump**: every request used here is 01's (v46) or 02's (v47).

Every check in CLAUDE.md this change can reach is green on the committed tree: `cargo test --workspace` (daemon 850, app host 666, protocol 138, gavin-mcp 72, and the integration suites, `headroom.rs` and `headroom_sessions.rs` among them); `npm test` (7119), `npm run check` (0 errors; the 36 warnings are the ones `main` has) and `npm run build`; the Companion's three. The Companion shell was not re-run: nothing it builds changed. Three guards were broken on purpose and seen to fail: the step's `pending` on an unknown reading, its done-ness on an Absent one, and the daemon's replace after an update.

### Where things are

- **App:** `agents/headroomSetup.ts` is every rule, pure: each state's label, LED, reason, version line, process line, lifetime total, actions and install command; the Update prompt; the workspace switch's darkness and notes; the wizard step's offers and done-ness. `agents/headroomState.ts` is the one reading per window, the four actions and the polling. `agents/HeadroomControls.svelte` is shared by the Settings section and `wizardSteps/HeadroomStep.svelte`.
- **Settings:** section `headroom` in `GlobalSettingsView`'s `SECTIONS`, after Custom agent. The workspace switch is under Agent in `SettingsHubView`, after Superpowers.
- **Host:** `get_headroom_status`, `detect_headroom` and `install_headroom` (session.rs), and `Workspace.headroom_asked`.
- **Compat:** `FEATURE_MIN_VERSION.headroomSetup` (46). Its consumer is `readHeadroom`, which settles on the reason instead of asking, so all three surfaces say what the daemon needs.
- **Daemon:** `Supervisor::replace`, called at the end of an install that changed what is installed.

### Things the card did not say, and what was done

1. **Update now really restarts Headroom, in the daemon.** 01's install replaced the files under a running Headroom, which went on serving the version it had imported, while Settings showed the new one. The daemon now replaces a running Headroom, on the same port, when an install changed its path or version. That is not counted as a restart and does not feed the backoff. An install that changed nothing leaves the proxy alone. Both directions are tested against the fake.
2. **The step's evidence is `headroomAsked`**, a recorded word like Review's: off is both the default and a legitimate answer. Continue records it, and so does moving the workspace switch in Settings, the way the git switch answers the git step. It is written to config.json only when true, so a config from a build without the field survives a save unchanged (the host's old-shape test caught the first version, which wrote `false` into every workspace).
3. **Unavailable finishes the step on its own** (Intel Mac, Windows, ssh), because there is nothing to ask. A failed ask and a daemon too old to be asked are settled but not done.
4. **Headroom is outside `configured`**, like Git and Review: an unanswered compression question is no reason for the Home banner to nag. It does count in "N of 8 done".
5. **The workspace switch stays live before the install.** It is dark only where moving it could change no launch: ssh, an unavailable platform, a daemon older than v47. Otherwise it says what stands between it and a compressed agent: Headroom not installed or too old, or a profile with no recipe. Cursor's sentence is the card's. Gemini's says it waits on real logins (07), and a custom agent with no API family points at Settings → Custom agent.
6. **Locate… and Check again are offered for Absent and Too old whether or not uv is found**, beside Install or Update when it is: a Headroom in a virtualenv is invisible to detection with or without uv. Verified offers Check again, plus Update below the pin. Unavailable offers nothing.
7. **The command shown without uv is built in the app** from the pin. It is the same line as the daemon's `install::command_line`; the status does not carry it.
8. **Settings is live while open**: it polls every 5 s, and every 1.5 s during an install or while the model loads. The Home tab and the workspace switch read once and keep the answer.

### How to run the human test

1. Rebuild the daemon and the app, and restart both. The daemon's half of Update is new in this commit.
2. On a machine without Headroom, open Settings → Headroom. It should read Absent, with **Install Headroom 0.39.1** when uv is installed. Without uv it shows the command, Locate… and Check again.
3. Press Install. A progress line stays up for a few minutes. It should end Verified, `0.39.1 · tested 0.39.1`.
4. Turn compression on, either for a workspace (Settings → Agent → Compression) or as the app-wide default, and run a card. The first compressed run should not stall: the install fetched the model. 01 noted that the tokenizer is still fetched on first load, which is small.
5. Open a workspace's setup wizard. Step 4 is Headroom.

### Open, and now live

**01's decision is live now.** Headroom's own limiter allows 60 requests a minute per login, and this card puts the switch on screen, so a fleet can reach it. The decision is still unanswered on `done/headroom-01-daemon-runs-headroom.md`.

### Not verified

- **The rendered surfaces.** They were not seen in the running app. That is the human test.
- **A real `uv tool install` through the daemon.** 01 did not run one either.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
