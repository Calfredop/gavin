---
kind: task
title: [sec] Tauri host & frontend surface
parent: review-security-audit.md
complexity: complex
---
Audit `app/src-tauri` and the parts of `app/src` that cross a trust boundary, against `docs/security/00-threat-model.md` (read it first), and write `docs/security/02-app-surface.md`.

## Cover

- **What a compromised webview gets.** `app/src-tauri/tauri.conf.json` has `"csp": null`; `capabilities/default.json` grants `opener:allow-open-path` on `/**` and `**`, clipboard read/write, notifications. State what a script running in the page can do with each, and what the WKWebView host adds or removes.
- **All 112 `#[tauri::command]`s**, in depth for the ~20 that take a path, cwd, or command: `read_file_for_viewer`, `write_file_for_editor`, `create_file`, `create_directory`, `rename_path`, `trash_entry`, `move_agent_file`, `list_directory`, `resolve_path_under_cursor`, `delete_card_file`, `worktree_setup`, `setup_agent_integration`, `compose_agent_prompt`. `fileviewer.rs` has a canonicalize + component-wise containment guard (`fileviewer.rs:309-342`) — verify it is on the path of every entry point, not just the reader, and what happens on symlinks and on a path outside every open workspace.
- **Every `Command::new`** in the host — git, `security`, `curl`, the agent CLIs, `open` — for how arguments are built from user, repo, or card data. Shell-string vs argv, and where a branch name, file name, or card title reaches an argument.
- **The OAuth token path** in `agent_usage.rs` (Keychain → `curl -K -` on stdin): confirm nothing logs, returns to the frontend, or writes it; check `agent_tokens.rs` and the transcript reads for the same.
- **Destructive commands from the webview**: `workspace_delete.rs`, `trash.rs`, `trash_entry` — what can be deleted and what confirms it.
- **Rendered untrusted content**: the 2 `{@html}` sites (`grep -rn '{@html' app/src`) — confirm DOMPurify is on the path in both, and what `marked` extensions are enabled; then xterm.js — which OSC/CSI sequences from an agent's output the app acts on (`osc.rs`, the OSC 133 handling, title changes, hyperlinks, clipboard OSC 52).

## Rules

- **Read-only against the live app.** Any reproduction uses a second app instance or a throwaway daemon under a temp `$HOME`; never the human's window, never `pkill`.
- **A reproduction, or an admission.** Every high-severity finding either carries steps or says in one line that it is argued from reading and not reproduced.
- **Describe, do not weaponise.** Impact and a minimal repro; no polished exploit.
- **Mark each finding** `vulnerability` or `boundary`.

## Output

`docs/security/02-app-surface.md`: a findings table (id, severity, adversary, vulnerability/boundary, reproduced yes/no), then one section per finding. Do not fix anything. Do not file cards — the parent plan does that after the dedupe pass.
