---
order: 7392
kind: task
title: Headroom 07: Gemini, after a spike
status: Done
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

## Spike record (Gemini CLI 0.35.3, Headroom 0.39.1, throwaway install, 2026-09-29)

Routing was proven with a capture server and with the real Headroom. A real generation could not be: the machine's `GEMINI_API_KEY` is rejected by Google ("API key not valid", identical with and without the proxy), and the Login with Google account is refused by Google itself.

- **API key, `GOOGLE_GEMINI_BASE_URL=<base>/p/<id>`: routed.** The CLI must have `security.auth.selectedType = gemini-api-key` (it did NOT switch modes on the variable alone while settings said `oauth-personal`). It then posts `<base>/p/<id>/v1beta/models/<m>:generateContent` with `x-goog-api-key`; through the real Headroom, Google's 400 came back to the CLI, so forwarding and the prefix work. **Recipe shipped.**
- **Login with Google, `CODE_ASSIST_ENDPOINT=<base>/p/<id>`: routed but not shipped.** `POST <base>/p/<id>/v1internal:loadCodeAssist` with the Bearer token arrives, and Headroom forwards it to cloudcode-pa. Google's answer was `UNSUPPORTED_CLIENT` ("no longer supported for Gemini Code Assist for individuals"), baseline included, so nothing past setup could be tried. Plus: endpoint documented for testing only, and CCR originals are not recovered on streamed Gemini. **No recipe; reason shown in Settings.**
- Not settled by the spike: whether a CCR marker reaches a Gemini transcript. That needs a working key (below).

Build: `compress.rs` (`gemini_uses_api_key`, the recipe), `mod.rs` (reads project + user `.gemini/settings.json` and env), Settings reason in `headroomSetup.ts`, spec row updated.

## Acceptance criteria

- [ ] Human test: Gemini CLI through Headroom on a real API key (settings `gemini-api-key`, a valid key, a workspace with compression on, a card that reads a large file) — does it answer, and does any CCR marker reach the transcript? Login with Google is expected to have no recipe; confirm the tab shows uncompressed
- [x] Recipes exist only for the modes that passed (tested)
- [x] A failed mode shows its reason in Settings

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
