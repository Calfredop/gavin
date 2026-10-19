---
order: 49152
kind: task
title: "[sec] Clicking a card's attachment chip or a terminal path hands a repo-shipped .command, executable or symlinked file to the OS launcher, with no type check and under a viewable-looking name"
status: Done
priority: medium
complexity: moderate
labels: security, ready-for-agent
---
Fix a needs-validation lead from the 2026-10-15 security audit (run-1). It is not confirmed: the audit traced it in source but could not observe whether macOS LaunchServices, through `/usr/bin/open`, runs a git-checked-out, non-quarantined `.command` or extensionless executable in Terminal.app without a prompt. The failing regression test below is the proof — write it first and watch it fail. If it already passes before any change, the lead is wrong: record why under a dated "## Comments" heading and move the card to Done with no code change. Fingerprint: `app/src-tauri/src/fileviewer.rs:open_path_externally:repo-file-handed-to-os-launcher`.

Full record: `NEEDS-VALIDATION.md` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

Two desk-side click surfaces send any file whose resolved extension is outside VIEWABLE_EXTENSIONS to open_path_externally: a card's attachment chip (CardDetailModal openAttachment) and a Cmd+click or middle-click on a terminal path (terminalRegistry activatePath). The chip also sends a viewable file there when no terminal session is focused. open_path_externally checks only that the path lies inside an open workspace, and the cloned repository is one. It then calls tauri_plugin_opener::open_path, which runs `/usr/bin/open -- <path>` and hands the file to its default handler. Nothing refuses an executable or launch-handler type, and nothing asks first.

The decision is made on the symlink-resolved path while the human sees the raw name. attachment_status canonicalises the entry and returns the target as absolutePath, but the chip is labelled with attachmentName(raw path). resolve_path_under_cursor does the same for terminal links. So a cloned repository can ship a symlink named `spec.md` that points at an in-repo `spec.command`: the chip reads as a markdown file but resolves to a non-viewable target that goes to `open`. An extensionless file is never viewable (fileExtension returns "") and always goes to `open`. If the default handler runs it, as Terminal.app does for `.command` and for extensionless Unix executables, a click the human meant as "view this attachment" runs repository code as the user.

The repository is lower-trust content, and a card's attachment is presented as data for the agent to read. open_path_externally is Refused for Devices, so the trigger is a human click at the desk. The 2026-09 audit recorded the terminal half as a residual "phishing step needing a human click" (docs/security/02-app-surface.md:347-351) but filed no fix, and nothing accepts it by design. AS-09/R5 narrowed the opener to the open workspaces, which does not cover a file inside the attacker's own repository.

## Root cause

open_path_externally treats "inside an open workspace" as enough reason to launch. Its click callers route every non-viewable target to it with no executable or launch-handler refusal and no confirmation, and they classify by the symlink-resolved path while showing the human the unresolved name. Nothing on this path tells data apart from launchable content.

## The invariant to enforce

gavin never hands the OS launcher a file that the launcher would run as a program: a launch-handler type, an application bundle, or a regular file with an execute bit. The judgement is made on the resolved target, in open_path_externally itself, so every caller gets it. Such a target is refused with a message that names the resolved target and offers Reveal in Finder instead. Where the chip or link shows a name different from the target it would open, it shows the target.

## Trace (lines as of 2026-10-16; re-read before editing)

- `app/src/lib/cards/CardDetailModal.svelte:1726` (attachment chip): Labelled attachmentName(path) from the raw frontmatter entry (attachments.ts:94); a click calls openAttachment(status).
- `app/src/lib/cards/CardDetailModal.svelte:638` (openAttachment): Takes status.absolutePath, the symlink-resolved target. Unless a session is focused and the target is viewable, it calls backend.openPathExternally(path) at 649 with no type check and no confirmation.
- `app/src-tauri/src/fileviewer.rs:684` (attachment_status_impl): resolve_for_containment (125) canonicalises the entry (705-706); the result is returned as absolute_path (738), so the chip is enabled for the target.
- `app/src/lib/terminal/terminalRegistry.ts:107` (activatePath): A Cmd+click or middle-click on a path resolve_path_under_cursor accepted (canonical target at fileviewer.rs:341) goes to openPathExternally (117) when the target is not viewable in-app.
- `app/src/lib/files/fileTypes.ts:7` (fileExtension): Returns "" for a name with no dot, so an extensionless file is never viewable.
- `app/src-tauri/src/fileviewer.rs:36` (VIEWABLE_EXTENSIONS): The only split; every other extension, including .command, .tool, .terminal, .webloc, .fileloc and extensionless files, goes to the OS.
- `app/src-tauri/src/fileviewer.rs:1135` (open_path_externally): ensure_within_open_workspaces against allowed_roots (1136-1137) is the only control; tauri_plugin_opener::open_path (1138) runs `/usr/bin/open -- <path>`. The module note above it (1108-1123) says `open` launches .app bundles and hands other files to "a second program of the attacker's choosing".
- Other callers of openPathExternally that the same refusal will reach: cardMenu.ts:73 and CardDetailModal.svelte:980 (the card file), FileEditor.svelte:236, FilesHubView.svelte:270, tabMenu.ts:125, PlanTree.svelte:130 and sidebarMenu.ts:69 (a folder or the workspace root).
- `crates/protocol/src/remote_commands.rs:122`: open_path_externally is Refused for Devices.

## What the audit could not observe

- Whether `/usr/bin/open` runs a git-checked-out, non-quarantined, mode-755 `.command` or extensionless Unix executable in Terminal.app without a Gatekeeper or other prompt on the shipped macOS. The OS launcher was not invoked and the Tauri host was not run.
- Whether the rendered chip or terminal link tells the human the file will be launched rather than viewed. Source shows only a `title` equal to the raw path.

## Fix

Put the refusal in open_path_externally, on the resolved path, behind a pure helper in fileviewer.rs, for example `fn launch_refusal(resolved: &Path, metadata: &Metadata) -> Option<String>`. It refuses:

- a regular file with any execute bit set (unix);
- a launch-handler or installer extension: .app, .command, .tool, .terminal, .webloc, .fileloc, .inetloc, .workflow, .scpt, .scptd, .applescript, .pkg, .mpkg, .dmg, .action, .prefpane, .saver, and on Windows .exe, .bat, .cmd, .com, .ps1, .vbs, .js, .msi, .lnk, .url, .scr;
- a directory that is a bundle (.app and the other bundle extensions above). A plain folder stays allowed, because sidebarMenu, PlanTree and the file tree open folders in Finder on purpose.

The error names the resolved target and says it was not opened because it would run as a program; the callers already show the error. Offer revealPathExternally as the next step at the chip and the file tree. An extensionless file with no execute bit stays allowed (README, LICENSE, Makefile).

Label the attachment chip and its title with the resolved target's name when it differs from the raw entry, so `spec.md -> hello.command` reads as `hello.command`.

Regression tests, in fileviewer.rs's test module:

- `open_externally_refuses_an_executable_file`: a mode-755 extensionless file inside an allowed root is refused before the opener is called.
- `open_externally_refuses_a_command_file_behind_a_markdown_symlink`: `spec.md -> hello.command` is refused, judged on the target.
- `open_externally_refuses_an_app_bundle_but_opens_a_folder`: a directory `X.app` is refused; a plain folder and a non-executable `.pdf` pass the check.

Test launch_refusal directly, since open_path_externally needs a Tauri State. Add a vitest beside CardDetailModal's logic, or in attachments.ts, for the label taken from the resolved target.

## Done when

- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests in the touched crate or module, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched.
- The regression test fails before the change and passes after it.
- Follow the CLAUDE.md traps that apply: a new SQLite column needs its own `ALTER TABLE`, a widened request needs a compat-gate entry, and you commit only your own files.
- Once the fix is in, file this check with `gavin_request_human(<this card>, "test", …)` using exactly this text: "On a throwaway macOS account, in a cloned workspace holding a mode-755 hello.command, an extensionless mode-755 notes and a symlink spec.md -> hello.command that each only touch /tmp/gavin-v03-marker, clicking each as a card attachment chip (with and without a session focused) and Cmd+clicking each name in a terminal pane runs nothing and leaves no marker file, and each chip shows the name of the file it would open."

- [ ] Human test: On a throwaway macOS account, in a cloned workspace holding a mode-755 hello.command, an extensionless mode-755 notes and a symlink spec.md -> hello.command that each only touch /tmp/gavin-v03-marker, clicking each as a card attachment chip (with and without a session focused) and Cmd+clicking each name in a terminal pane runs nothing and leaves no marker file, and each chip shows the name of the file it would open.
