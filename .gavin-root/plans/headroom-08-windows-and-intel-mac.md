---
order: 9216
kind: task
title: Headroom 08: Windows and Intel Macs
status: To Do
labels: needs-triage
parent: headroom.md
complexity: moderate
---
Blocked by: windows-desktop-pass.md, headroom-04-setup-surfaces.md, upstream headroomlabs-ai/headroom#3749

Part of `headroom.md`. Read the spec (section "Platforms") first.

Parked. v1 shows Unavailable on Windows and Intel Macs.

- **Intel Macs.** Headroom's docs disagree about native builds for Intel Macs: the installation guide lists them, and the README says use Docker (#941).
- **Windows.** Headroom has an open Windows proxy outage (#3749), and Gavin's Windows desktop pass is not done.

Re-triage when both blockers clear. Establish what installs natively on each platform at the pinned version, then lift Unavailable where it does. On Windows that includes the detection paths (uv's tool directory there), Headroom's log file permissions (0600 on Unix, unrestricted on Windows), and the named-pipe daemon's child-process handling.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

## Intel Mac findings (2026-09-29, pin 0.39.1)

- #941 is closed and PyPI now ships `headroom_ai-0.39.1-cp310-abi3-macosx_10_12_x86_64.whl`; `--no-extras` install runs (`headroom --version` under Rosetta, x86_64 Python via `uv --python cpython-3.12-macos-x86_64`).
- But gavin installs `headroom-ai[all]`, and that does NOT resolve on Intel macOS: the `proxy` extra needs `onnxruntime>=1.24.0` (python>=3.11) and onnxruntime has no x86_64 macOS wheel past 1.24.0 (only macosx_14_0_arm64). The bare package lacks fastapi, so `headroom proxy` refuses to start.
- Only python<3.11 (`onnxruntime<1.24.0`) could resolve; not pursued. Intel Mac stays Unavailable; the reason now names onnxruntime. Re-check when onnxruntime ships Intel macOS wheels or Headroom relaxes the pin.
- Windows untouched: windows-desktop-pass.md still In Progress, #3749 still open. Wheel `win_amd64` exists.
