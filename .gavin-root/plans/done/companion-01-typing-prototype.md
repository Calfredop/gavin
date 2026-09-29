---
kind: task
title: Companion 01: typing prototype
status: Done
labels: ready-for-agent
parent: companion.md
complexity: moderate
---
Blocked by: none (can start immediately)

Part of `companion.md`. Read the spec (`docs/superpowers/specs/2026-09-27-companion-design.md`, especially "Typing (provisional)"), `CONTEXT.md` and ADRs 0002 and 0005 first.

## What to build

A throwaway prototype that settles how the human types into a terminal on a phone, before the Companion's terminal surface is built.

It is a single web page: xterm.js from a CDN, on the 6.1 line, since 6.0's touch scrolling is broken on iOS. Mobile Safari runs the same WebKit as the iOS webview, so it is a fair test. The page drives a scripted fake agent session that prints Claude-Code-style questions ("1/2/3", yes/no, a free-text prompt) and a shell prompt. It offers three modes to switch between:

- **Raw:** a terminal with a special-key row (Esc, Ctrl, Tab, arrows) above the soft keyboard.
- **Compose:** a field that sends a whole line, plus quick-reply buttons derived from what the agent is asking.
- **Both:** compose by default, with raw one tap away.

Keep it on a `prototype/companion-typing` branch out of main, and publish it somewhere the human can open it on their phone. Start from the handoff at `/private/tmp/claude-501/-Users-coalpila-CloudStation-Coding-gavin/33c4440e-146c-4f10-a4a5-f6432667dd90/scratchpad/companion-typing-prototype-handoff.md`. It records the xterm.js-on-mobile facts, the questions to answer and how to get the page onto the owner's phone. It lives in a temp folder; if it is gone, this card and the spec are enough.

## Acceptance criteria

- [ ] The page runs on iPhone Safari and on Android Chrome
  Note (2026-09-28): runs on iPhone Safari (the owner's iPhone, and Mobile Safari 26.5 in the iOS Simulator). Android Chrome was not run: the owner tested on an iPhone only.
- [x] All three modes switch at runtime
- [x] Findings are written in the prototype's README: which mode wins, which quick replies, and what broke (selection, input methods, scrolling)
- [x] The spec's typing decision is confirmed or amended, in a comment on `companion.md`

When the page is up, file a human test: the owner answers the fake agent in each mode on their own phone and picks one.

- [x] Human test: On your own phone, open the bench (Claude app: https://claude.ai/artifact/TNPnXSiqoiBANkFYGesFox, or in Safari/Chrome on the Mac's Wi-Fi: http://192.168.1.194:8787/ while `python3 prototypes/companion-typing/serve.py` runs in the prototype/companion-typing worktree), answer the five fake-agent prompts once in each mode (Raw, Compose, Both), also try touch-scrolling the terminal, long-press selecting text, opening and closing the keyboard and the More keys, then open the ⋯ menu, tap your pick, add notes, tap Copy report and reply here with the pick and the report.
  Result (2026-09-28): passed
