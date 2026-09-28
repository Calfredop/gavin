---
order: 7392
kind: task
title: Headroom 07: Gemini, after a spike
status: To Do
labels: ready-for-agent
parent: headroom.md
complexity: moderate
---
Blocked by: headroom-03-codex-opencode-custom.md

Part of `headroom.md`. Read the spec (section "The recipes", the Gemini paragraph) first.

## What to find out, then build

Headroom has no `wrap gemini`. The Gemini CLI honours two endpoint variables:

- `GOOGLE_GEMINI_BASE_URL` for an API key. It also flips the CLI's auth type to "gateway".
- `CODE_ASSIST_ENDPOINT` for Login with Google. It is documented only "for development and testing".

Headroom serves `/v1beta/models/...:generateContent` and `/v1internal:streamGenerateContent`, but it documents the latter only for other Gemini clients. CCR originals are not recovered on streaming Gemini, so lossy compression there cannot be undone. Custom headers go through `GEMINI_CLI_CUSTOM_HEADERS` (undocumented), and a `/p/<id>/` prefix works too.

1. **The spike.** Prove each auth mode through a running Headroom, with the recipe candidate for each. Record what passed and what broke on this card.
2. **Build.** Ship the recipe only for the modes that passed, choosing between them by the CLI's configured auth type. A mode that failed gets a reason on Gemini's row, the way Cursor's does.

## Acceptance criteria

- [ ] Human test: Gemini CLI through Headroom on a real Login with Google, and on a real API key — report which works, and whether any CCR marker ever reaches the transcript
- [ ] Recipes exist only for the modes that passed (tested)
- [ ] A failed mode shows its reason in Settings

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
