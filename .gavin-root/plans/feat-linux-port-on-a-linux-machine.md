---
order: 2048
title: [feat] linux port — the half that needs a Linux machine
status: To Do
---
Everything in [feat-linux-port.md](./done/feat-linux-port.md) that could be
done from a mac is done and green: nine commits on `feat/multi-os-support`,
the whole workspace passing in a `rust:1-bookworm` container, the `/proc`
probe, the XDG data directory, the trash record, the resize grips, the first
CI workflow. What is below is what a container cannot answer — a package
that has to be built on Linux, and a window that has to be looked at.

Read that card's "What was verified, and how" section first. It records the
measurements, so none of this needs re-deriving.

**Assumption** (overrule in one word): an x86_64 Ubuntu 24.04-class VM or
box with a desktop session, WebKitGTK 4.1, and the packages
`.github/workflows/ci.yml` installs.

## 1. Produce the packages

- [ ] `cd app && npm run bundle` on the Linux box. That is `tauri build
      --config src-tauri/tauri.bundle.conf.json`; `app/src-tauri/BUNDLING.md`
      says why the flag exists and must not be dropped. First AppImage build
      downloads `linuxdeploy`, so it needs network.
- [ ] Confirm `bundle.targets: "all"` really produced **deb + AppImage**
      (rpm too, if it comes free).
- [ ] **The spec's own open item, unanswered since 2026-08-24 §2:** does
      `externalBin` strip the target triple and land `gavin-daemon` and
      `gavin-mcp` BESIDE the app binary? Install the deb and check they are
      all three in `/usr/bin`. If they are not, `resolve_daemon_binary_path`
      and `resolve_mcp_binary_path` (both `current_exe().parent().join(…)`)
      are broken on Linux and the packaging approach needs rethinking, not
      patching.
- [ ] Run the installed app — not a dev build — and confirm it starts its
      own daemon. That is the sibling lookup working end to end.
- [ ] Run the wizard's integration step against a workspace and check the
      absolute `gavin-mcp` path it writes into the agent config resolves.

## 2. The desktop pass

Nothing below has been seen on a screen. The first four are ports of
working macOS behaviour; the rest is **new code that has never run**.

- [ ] Launch, spawn a shell, run a card.
- [ ] Restart the daemon from Settings.
- [ ] Delete a workspace and confirm it is in the desktop's Trash **and
      that "Put back" works** — the `.trashinfo` now carries the
      `DeletionDate` the spec requires, and this is what that was for.
- [ ] Hover a `~/`-prefixed path in terminal output and open it.
- [ ] **Resize the window from all eight edges and corners**
      (`WindowResizeEdges.svelte`). GTK gives a `decorations: false` window
      no grips of its own, so these eight DOM strips are the only way to
      resize at all. Check the corner grips beat the edges they overlap, and
      that the top edge does not eat clicks meant for the tab row.
- [ ] Drag the window by the corner strip over the sidebar and by the empty
      run of each tab row (`startDragging`).
- [ ] Double-click the title bar: it should maximize (off macOS the Rust
      side reports `null` and the default is Zoom, which is also GNOME's and
      KDE's).
- [ ] The non-mac `WindowControls` variant — minimize / maximize / close on
      the right of the corner, with the corner still top-LEFT.

## 3. Then

- [ ] Turn on the GitHub Actions workflow for the repo and watch one run go
      green. Expect intermittent red from
      [fix-daemon-server-test-flakiness.md](./fix-daemon-server-test-flakiness.md),
      which predates this work and is deliberately not papered over.
- [ ] Record what broke on this card. `feat-windows-port.md` builds on the
      same two seams, so a Linux surprise is a Windows surprise early.

**Out of scope:** Wayland polish beyond "it launches and resizes"; any
installer beyond what Tauri bundles; the two macOS-only rail tools
([feat-linux-notification-tools.md](./feat-linux-notification-tools.md)).
