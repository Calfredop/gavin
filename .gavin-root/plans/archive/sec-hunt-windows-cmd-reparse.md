---
order: 59392
kind: task
title: "[sec-hunt] Finish the blocked audit unit: whether cmd.exe re-parses a POSIX-quoted launch line on the Windows .cmd shim path"
status: Done
priority: low
complexity: moderate
labels: security, ready-for-human, windows
---
Finish a coverage unit the 2026-10-15 security audit (run-1) could not close. Its decisive check needs a Windows host with Git for Windows, which the audit did not have, and its hunter was cut short before writing a candidate. This card is the rest of that hunt: a source half any agent can do, then one run on Windows by the owner. Coverage id: `crates%2Fdaemon%2Fsrc%2Fshell.rs%23rewrite_for_windows_shim::crates%2Fdaemon%2Fsrc%2Fshell.rs%23command_with_windows_shim::crates%2Fdaemon%20%28Windows%20PTY%20spawn%29::ATTACK-CLASSES.md%23Injection`.

Full record: the unit's entry in `coverage-ledger.json` and REPORT.md §6 in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## The unit

On Windows, the daemon passes every command session's line (an agent command plus a POSIX-quoted card prompt, tool bodies, `[worktree] setup` chains) through `shell::rewrite_for_windows_shim` before `sh -c`. When the leading word resolves on `PATH` only to a `.cmd` or `.bat`, with no extensionless sibling and no bundled node pair, the line becomes `<word>.cmd <rest>`, and MSYS `sh` hands the POSIX-quoted arguments to `cmd.exe` through the shim's `%*`. POSIX single quotes are the only control, and `cmd.exe` does not honour them. The boundary is repository-controlled text that gavin quotes into a launch line against `cmd.exe`'s parser: could a quoted argument run as a host command, outside the agent CLI's own permission prompts?

## Open questions

1. When Git for Windows' MSYS runtime spawns a `.cmd`/`.bat`, how does it build the Windows command line from argv, and can a single POSIX-quoted argument holding `"`, `&`, `|`, `%` or `^` escape its quoting once `cmd.exe` parses it?
2. Does any shipped agent profile, on a stock Windows install, resolve to a `.cmd` with no extensionless sibling and no bundled node pair? Cursor Agent is the case named in source, and its node-pair branch avoids the re-parse.
3. Which repository-controlled text can sit on the first line of the launch line (`cmd.exe` truncates at a newline): a direct-prompt card's body, a card's `model:`/`effort:`, anything else?

## What is already known

- `crates/daemon/src/pty.rs:163` (PtySession::spawn_with_env): every command line goes through `rewrite_for_windows_shim`, then `sh -c`.
- `crates/daemon/src/shell.rs:364-379` (command_with_windows_shim): the `.cmd`/`.bat` arm; with no node pair it returns `{word}{ext}<rest>` (378) with no escaping for `cmd.exe`. The node-pair rewrite runs `node.exe` directly and does not re-parse. The doc comment (shell.rs:228-266) says `cmd.exe` splits a bare `&` and truncates an argument at the first newline.
- Standard card prompts start with a fixed gavin line, so with the newline truncation their card text may never reach the parser. A direct-prompt task (`isDirectPrompt`, `app/src/lib/cards/cardRunActions.ts:721`) sends the card body verbatim, so card text can be the first line.
- A card's `model:` and `effort:` reach the first line unvalidated and POSIX-quoted only (`app/src/lib/cards/cardAgent.ts:59`, `app/src/lib/agents/agentModel.ts:52`, `:67`, `:124`), and are not in the review digest (`sec-hardening-review-digest-launch-frontmatter.md`).
- The first-run review shows the composed prompt before launch when `requireReview` is on (the default). With it off, nothing is shown.
- Two hardening cards already narrow this whatever the answer: `sec-hardening-windows-cmd-shim-refuse-specials.md` refuses the `.cmd` fallback for lines holding `cmd.exe` metacharacters, and `sec-hardening-review-digest-launch-frontmatter.md` puts the frontmatter fields under review. Check whether either has landed before you start; if the refusal is in, the Windows run below should show the refusal.

## Method

Source half (any machine): answer question 1 from the MSYS2 runtime's spawn and argument-quoting code for the Git for Windows version gavin documents, question 2 from the agent profiles (`app/src/lib/core/settings.ts`, `app/src-tauri/src/agent_setup.rs`) and each CLI's published Windows install layout, and question 3 by tracing every builder of the launch line to its first newline. Use the pure `command_with_windows_shim` tests in `shell.rs` for anything that can be shown without Windows. Write the findings under a dated "## Comments" heading.

Windows half (the owner): one run on a Windows machine with Git for Windows, against a throwaway workspace and a fake CLI, never a real agent. Nothing in this card should be run against the live daemon.

## Outcome

For each root cause confirmed, by the source half or by the Windows run, file a `sec-fix-<slug>.md` card in the shape of the confirmed audit cards, with a failing regression test named in its Fix. If the re-parse cannot escape, or no shipped profile reaches the `.cmd` branch, close with that evidence under ## Comments.

## Done when

- Questions 1 to 3 each have an answer under ## Comments, with the source lines or test that show it.
- Once the source half is done, file the Windows check with `gavin_request_human(<this card>, "test", …)` using exactly this text: "On a Windows machine with Git for Windows, put a file fake-agent.cmd containing `@echo %*` alone on PATH, set a custom agent profile's command to fake-agent, run a direct-prompt card in a throwaway workspace whose whole body is the single line `x" & echo reparsed> "%TEMP%\gavin-reparse.txt" & rem "`, and confirm that %TEMP%\gavin-reparse.txt does not exist afterwards and the session either echoed the line whole or refused to launch."
- Every confirmed root cause has its own `sec-fix-*` card, linked from the Comments, or the card is closed with the evidence.

## Comments

### 2026-10-19 — source half

Hardening status before the hunt: neither `sec-hardening-windows-cmd-shim-refuse-specials.md` nor `sec-hardening-review-digest-launch-frontmatter.md` has landed. `command_with_windows_shim` still returns `String` (shell.rs:330-384); the `.cmd`/`.bat` fallback at 378 still appends `&command[word_end..]` with no `cmd.exe` escaping or refusal.

#### 1. MSYS → CreateProcess quoting, and whether a POSIX-quoted arg can escape

Git for Windows' `sh.exe` is the MSYS runtime gavin documents (`crates/daemon/src/shell.rs` module docs). When it spawns a native Win32 target (including `.cmd`/`.bat`), `spawn.cc` builds one Windows command line via `linebuf::fromargv` (`winsup/cygwin/winf.cc` in the cygwin/msys2-runtime tree GfW ships). The rule is:

```
if (len != 0 && !strpbrk (a, " \t\n\r\""))
  add (a, len);          // bare — no surrounding quotes
else
  wrap in "...", escaping embedded " and \
```

So after `sh -c` has already stripped gavin's POSIX single quotes, each argv element reaches `cmd.exe` (through the `.cmd` shim's `%*`) either bare or double-quoted by MSYS. POSIX `'` is never a control on that path.

**Yes, a single argv can escape when it holds `cmd.exe` metacharacters but no whitespace and no `"`.** Bare `&` / `|` / `^` / `%…%` then reach `cmd.exe`'s parser. Measured on this product's own Windows pass (2026-09-22), archived at `.gavin-root/plans/archive/fix-npm-cli-shims-are-run-through-cmd-exe-on-windows.md`:

- `sh -c "showone.cmd 'a&b'"` → `%1` was `a`, and `'b'` ran as a command.
- `sh -c "codex.cmd --version 'x&whoami'"` against a real `@openai/codex` npm shim → `whoami` executed.

The pure suite pins the rewrite that used to force that road: `an_extensionless_shim_beside_a_cmd_is_left_alone` keeps `codex --version 'x&whoami'` unrewritten when the extensionless sibling exists (shell.rs:727-737); `a_cmd_only_shim_still_rewrites_when_no_extensionless_sibling` still emits `cursor-agent.cmd …` when it does not (shell.rs:743-752).

**When the argv also contains whitespace or `"`, MSYS double-quotes it.** Whether `cmd.exe` can still break that quoting (the spaced payload in the human test below) is not settled from source alone — that is the Windows half.

#### 2. Do any shipped profiles hit the bare `.cmd` fallback on a stock Windows install?

No. Profile commands are in `AGENT_PROFILES` (`app/src-tauri/src/agent_setup.rs`); Windows layouts:

| Profile | command | Stock Windows shape | Arm taken |
|---|---|---|---|
| claude-code | `claude` | native / winget `claude.exe` | `.exe` / exact match — never `.cmd` |
| codex / gemini / opencode | bare name | npm three-file (`name`, `name.cmd`, `name.ps1`) | extensionless preferred (shell.rs:348-363, 727-737); the 2026-09-22 fix closed the rewrite that forced `.cmd` |
| cursor | `agent --trust` | `%LOCALAPPDATA%\cursor-agent`: `agent.cmd`/`.ps1` only, plus `versions/<ver>/node.exe`+`index.js` | node-pair rewrite (shell.rs:365-376); measured in the same Windows pass |
| kimi-code | `kimi` | install.ps1 native executable, or npm three-file | `.exe` / extensionless — not bare `.cmd` |

Cursor is the `.cmd`-only layout named in source; its bundled-node arm avoids `cmd.exe` entirely (`a_cmd_shim_with_bundled_node_runs_node_directly`, shell.rs:759-777). The bare `{word}.cmd{rest}` fallback remains reachable for a **custom** profile whose command resolves only to `.cmd`/`.bat` with no node pair (the human test's `fake-agent`), or a broken Cursor install missing the node pair — not for any shipped stock profile.

#### 3. Repository-controlled text on the first line of the launch line

`cmd.exe` truncates an argument at the first newline (shell.rs:248-251). Builders:

- **Direct-prompt task body** (`direct: true`): `isDirectPrompt` (`cardRun.ts:169`); launch uses the body verbatim with no name-tab framing (`cardRunActions.ts` around the `verbatim` / `composeCardPrompt` path). The whole body can be one line, so it sits inside the POSIX-quoted prompt on the first line of `buildRunCommand` (`cardRun.ts:291-301` + `shellQuote` at 244-246).
- **`model:` / `effort:` / advisor**: `cardAgentOverride` reads them trimmed and unvalidated (`cardAgent.ts:59-67`). `resolveAgentConfig` → `composeLaunchCommand` / `composeEffort` / `composeAdvisor` put them on the command ahead of the prompt (`settings.ts:605-608`, `agentModel.ts:52`, `:67`, `:124`). A value matching `SHELL_SPECIAL` is single-quoted only (`quoteModel`); on the bare `.cmd` path that is the same inert-for-POSIX / live-for-`cmd.exe` quoting as the prompt. Not in the first-run review digest (hardening card still open).
- **Ordinary (non-direct) prompts**: start with `DEFAULT_NAME_TAB_FIRST` (`actionPromptDefaults.ts:145-147` / `DEFAULT_RUN_TASK` at 18-25), so card body text is after a newline and is truncated away before `cmd.exe` would see it — only the fixed first line and any `model`/`effort` tokens remain.
- **Kimi interactive**: `prompt_args: None` + `prompt_injection: true` (`agent_setup.rs:1621-1629`) — card body is pasted into the PTY, not on the launch line; `model`/`effort` still can be.
- **Command / script tools**: `buildToolCommand` (`cardRun.ts:654-670`) — a `command` tool's body is the launch line as written (not an extra POSIX-quoted prompt); a `script` tool is `bash -c '…'`, whose leading word is MSYS `bash`, not a `.cmd` shim. `[worktree] setup` lines are prompt text for the agent to run, not daemon launch lines.

#### Disposition

Mechanism: on the bare `.cmd` fallback, a no-whitespace metacharacter payload in a POSIX-quoted argv **does** re-parse and run as a host command (source + prior Windows measurement). Reachability: **no shipped stock profile** takes that fallback today. Per this card's Outcome, that closes without a new `sec-fix-*`. The residual custom-agent / broken-install path is what `sec-hardening-windows-cmd-shim-refuse-specials.md` is for; frontmatter visibility is `sec-hardening-review-digest-launch-frontmatter.md`. Human test below still needed for the spaced/`"` payload and to see live refuse-or-echo behaviour (refusal is not in tree yet).

- [ ] Human test: On a Windows machine with Git for Windows, put a file fake-agent.cmd containing `@echo %*` alone on PATH, set a custom agent profile's command to fake-agent, run a direct-prompt card in a throwaway workspace whose whole body is the single line `x" & echo reparsed> "%TEMP%\gavin-reparse.txt" & rem "`, and confirm that %TEMP%\gavin-reparse.txt does not exist afterwards and the session either echoed the line whole or refused to launch.
