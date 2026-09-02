---
order: 9216
kind: plan
title: opencode integration
status: Done
---
search the web and adapt Gavin to work with OpenCode

## Decided (2026-09-01)

- **O1 — Full parity.** Every flow a Claude Code workspace gets, an opencode
  workspace gets: a card run that actually carries its prompt, the four gavin
  skills, commit-via-agent, and the step skills that ride on `skill_slot`.
- **O2 — Visible runs go through `--prompt`.** `opencode --prompt '<text>'`
  starts the TUI already seeded. The bare positional is a *project directory*,
  which is why every card run misfires today: `buildRunCommand` builds
  `opencode '<prompt>'` and opencode reads the prompt as a path.
- **O3 — Hidden runs go through `run --agent gavin-commit --`.** `--auto` is in
  opencode's docs but **not in the installed 1.3.13**, so there is no CLI-level
  permission grant to lean on.
- **O4 — The grant lives in a gavin-owned agent file**,
  `.opencode/agent/gavin-commit.md`, carrying
  `permission: { edit: deny, webfetch: deny, bash: { "*": deny, "git *": allow } }`.
  Not in the human's `opencode.json`: that would silently re-scope their own
  interactive sessions, and gavin writes nothing into someone else's config
  beyond the MCP entry.
- **O5 — Skills install to `.opencode/skills/<name>/SKILL.md`.** opencode reads
  `.claude/skills/` too, but a workspace that never chose Claude Code should not
  grow a `.claude/` directory. Gavin's four skill files already carry the
  `name` + `description` frontmatter opencode's validator demands, so they
  install verbatim.
- **O6 — The prompt-arg fix is general, not an opencode special case.**
  `buildRunCommand` ignores `promptArg` on *every* surface
  (`layoutState.ts:921`, `cardRunActions.ts:120,191`,
  `orchestrationState.ts:444,514`); only the wizard's "Ask the agent" checks it.
  **Cursor misfires identically today** — `cursor '<prompt>'` opens the prompt
  as a file path. One mechanism fixes both.
- **O7 — No protocol bump and no `FEATURE_MIN_VERSION` entry.** Agent profiles
  ride Tauri commands, not the daemon socket. Recorded so nobody adds one later.
- **O8 — Verification includes a real opencode run**, not just `--help` output.
  The binary is installed on this machine and authenticated.

## Steps

- [x] The spike lands first ([argv, skill and agent conventions](./opencode-argv-spike.md)) — no row goes into the profile table on a convention it did not verify.
- [x] `agent_setup.rs`: `prompt_arg: bool` becomes `prompt_args: Option<&'static str>` — `Some("")` bare positional (claude-code, codex, gemini), `Some("--prompt")` flagged (opencode), `None` no prompt at all (cursor, custom); `prompt_arg_is_set_only_where_the_convention_is_verified` asserts the whole column with its verification date.
- [x] opencode's row gains `headless_args` from the spike; `models` stays empty (`provider/model` names rot — the table's existing rule). `only_claude_code_runs_headless_and_headless_rows_are_well_formed` asserts the *set*, keeping the "must take a prompt" and trailing-`--` invariants.
- [x] opencode's `McpLayout.skills` gains the four gavin skills under `.opencode/skills/`; the `with_skills == ["claude-code"]` guard becomes the two-profile set. `skill_slot`, `compose_agent_prompt`'s on-demand step skills and `workspace_delete`'s gavin-prefixed sweep then follow for free — pin the last one with a test rather than trusting it.
- [x] New writer for `.opencode/agent/gavin-commit.md`, overwritten wholesale like a `SkillFile` and written only for a profile that declares one; it joins `GavinInstall` so the Integration step lists it and the delete wizard removes it.
- [x] `AgentProfileDto` → `backend.ts` → `settings.ts`'s `ResolvedAgent` carry `promptArgs`; `agentFlowAvailable` reads it instead of `promptArg`.
- [x] `cardRun.ts`: `buildRunCommand(agentCommand, promptArgs, prompt)` returns **null** where the profile takes no prompt, so a mangled argv can never be launched; every call site passes it. Tests cover the flagged case and the Cursor case that misfires today.
- [x] Every surface that can start a card says *why* when the profile takes no prompt — card run actions, Develop, Resume, orchestration steps — in `agentCommitBlocker`'s shape. Hang the reason on a non-disabled ancestor: a disabled element never fires `mouseenter`.
- [x] `smokeChecklist.ts`: `wiz-agent-gate` is now wrong (opencode offers "Ask the agent"; only Cursor is absent). Add items for the seeded TUI, the four skills on disk, commit-via-agent, and the delete wizard listing the agent file.
- [x] Live pass in a scratch workspace: init it on the opencode profile, start a card, confirm the prompt arrives and the `gavin_*` tools are callable from inside the session, then run commit-via-agent against a dirty scratch repo.
- [x] `cargo test --workspace` and `cd app && npm test && npm run check && npm run build` green.

## Live pass (2026-09-02, opencode 1.3.13, scratch repo under `mktemp -d`)

Driven through gavin's OWN code, not by hand: the files came from
`run_integration` with the real `gavin-mcp` path injected, and both command
lines were printed by `cardRun.ts`'s `buildRunCommand` / `buildHeadlessCommand`
fed from `resolveAgentConfig` against the opencode row. The visible run went
through a pty running `sh -c <line>`, which is how the daemon starts every
session.

**L1 — Integration writes the opencode layout and nothing else.** `AGENTS.md`,
the four skills under `.opencode/skills/`, `opencode.json`, and
`.opencode/agent/gavin-commit.md`; no `.claude/` and no `.mcp.json`. The
instructions block names `.opencode/skills/gavin/SKILL.md`, not Claude Code's
path — the literal that `workflow_skill_path` replaced.

**L2 — opencode reads all of it.** `opencode agent list` shows `gavin-commit`
with the grant normalized exactly as written (`edit: deny`, `webfetch: deny`,
`bash */git *`), and the four skill directories appear in every agent's
`external_directory` allow-list. `opencode mcp list` reports `✓ gavin connected`
against the built binary.

**L3 — a card run arrives seeded.** `opencode --model <m> --prompt='<prompt>'`
opened the TUI with the composed card prompt already posted as a user message,
byte for byte — leading text, embedded newlines and the two `'`s in "card's" all
intact through `shellQuote`. This is the bug the card was filed for: the same
card on the old builder printed "Failed to change directory to …".

**L4 — the `gavin_*` tools are reachable from inside that session.** The agent
called `gavin_gavin_name_session` (opencode's server-key namespacing, V9) and
then `gavin_gavin_read_prd`. The read came back with gavin-mcp's own
version-skew refusal — this worktree's binary against the human's running
daemon, the documented fail-closed state — so the call was dispatched and
answered, not lost. The agent then read the PRD file directly and reported its
codeword.

**L5 — commit-via-agent works headless, and `--model` survives the subcommand.**
`opencode --model <m> run --agent gavin-commit -- '<COMMIT_PROMPT>'` — the exact
line `buildHeadlessCommand` produces — committed a dirty scratch tree in two
logical chunks, left `git status` clean, and exited 0 on its own in 22s. The
global flag ahead of `run` is accepted, which V5 had not covered.

**L6 — one caveat, not gavin's.** In L4 the interactive agent reacted to the
version-skew message by running `npm install -g gavin`, which installed an
unrelated `gavin@0.0.0` from the registry. An interactive session has no tool
restrictions by design; the hidden commit run cannot do this, because its agent
file denies every bash command but `git *`.

## Verified (2026-09-02, opencode 1.3.13, macOS, scratch repo under `mktemp -d`)

Every line below names the command that was run and what it printed. Nothing
here is inferred from documentation.

**V1 — the bare positional really is a directory.** `opencode 'Fix the login
flow and commit'` printed `Error: Failed to change directory to
/private/tmp/oc-spike-YfIg/Fix the login flow and commit` and exited. O2/O6 hold:
every card run on this profile dies before a session exists.

**V2 — `--prompt` seeds AND submits.** `opencode --prompt '<text>'` opened the
TUI with the text already posted as a user message and the agent working on it
(rendered transcript captured from a pty). The stored message is the prompt
**verbatim** — no wrapper, no trailing newline.

**V3 — `--prompt` must be written `--prompt=<value>`, not `--prompt <value>`.**
With a value whose first character is `-`, the space-separated form printed the
usage banner and refused to start; the attached form ran. Through gavin's real
path (`sh -c` on a line built by `cardRun.ts`'s `shellQuote`), this prompt —
leading `-`, embedded newlines, `'`, and `\"` — round-tripped as an exact byte
match:
`-First, before anything else: call gavin_name_session.\n\nCard at .gavin-root/plans/x.md ("O'Brien's \"card\"").\nReply only VERBATIMOK.`
So the profile's prompt argv is the **prefix** `--prompt=`, concatenated with the
shell-quoted prompt. That unifies the whole column: `""` is the bare positional,
`"--prompt="` is the flagged one, and the builder is one concatenation either way.

**V4 — `opencode run … -- '<prompt>'`: the `--` is required and does not leak.**
Without it, `opencode run '-x ARGVPROBE leading dash'` printed the usage banner
and created no session. With it, the stored message was
`"-x ARGVPROBE leading dash"`. Comparing bare and `--` forms on an identical
prompt gave byte-identical storage, so `--` separates and never lands in the
message.

**V4a — but `run` JSON-stringifies the message.** `opencode run -- 'You are
executing the card ("my title") — done? yes.'` stored
`"You are executing the card (\"my title\") — done? yes."` plus a trailing
newline: opencode wraps the joined `message..` array in double quotes and escapes
inner ones. It does this with **and** without `--`, so it is not the separator's
doing. Harmless for the one prompt gavin sends this way (`COMMIT_PROMPT` has no
quotes), and it is another reason visible runs go through `--prompt`, which does
not do it.

**V5 — headless argv.** `opencode run --agent gavin-commit -- '<prompt>'` is the
verified shape, so `headless_args` is `run --agent gavin-commit --`. Proven end
to end against a dirty scratch repo with gavin's real `COMMIT_PROMPT`: the agent
ran `git add` / `git commit` three times, left the tree clean, and the process
exited on its own in 87s.

**V6 — the agent-file directory: both work, so gavin picks one.** 1.3.13 reads
`.opencode/agent/` **and** `.opencode/agents/`; a file dropped in each showed up
in `opencode agent list`. That is why the docs disagree. O4's singular
`.opencode/agent/` is verified good.

**V7 — the permission block is honoured, and a denial FAILS rather than hangs.**
The O4 frontmatter (`edit: deny`, `webfetch: deny`,
`bash: { "*": deny, "git *": allow }`) came back from `opencode agent list`
normalized exactly as written. A non-interactive run told to `ls -la /tmp`
answered immediately with
`✗ bash failed / Error: The user has specified a rule which prevents you from
using this specific tool call`, and an `ask`-level permission printed
`permission requested: external_directory (/tmp/*); auto-rejecting`. The run
exited 0 in 18.8s. Non-interactive opencode auto-rejects rather than waiting, so
a hidden run cannot become a spinner with no end.

**V8 — skills install verbatim.** All four gavin skill files, copied unchanged
into `.opencode/skills/<name>/SKILL.md`, are listed by the server's `/skill`
endpoint with their `name`, `description` and full body. opencode's validator
takes gavin's existing frontmatter as-is. Discovery happens at process start, so
a fresh launch always sees a freshly written skill.

**V9 — MCP works, but the tools are renamed.** The exact entry gavin writes —
`mcp.gavin = { type: "local", command: ["…/gavin-mcp"], enabled: true }` in
`opencode.json` — reported `✓ gavin connected` from `opencode mcp list`, and a
real session called the tool and returned the scratch PRD's codeword. **opencode
namespaces MCP tools by server key**, so `gavin_read_prd` is exposed as
`gavin_gavin_read_prd`. Every gavin document that names a tool by its bare name
(the four skills, `NAME_TAB_FIRST`, every composed prompt) is therefore naming a
tool that does not exist under this profile. The model coped by matching on the
suffix, but this should not be left to luck.

**V10 — `--model` takes `provider/model` only.** `--model sonnet` and
`--model gpt-5` both died with
`ProviderModelNotFoundError { providerID: "sonnet", modelID: "" }`. The catalogue
is per-user (445 rows here, built from this machine's configured providers), so
the profile's empty `models` list stands.

### Resume (spike item 7 — for `bug-agent-connection-failure.md`, Root 3)

**V11a — the id CANNOT be fixed at launch.** There is no `--session-id`
equivalent. `--session <unknown-id>` is a read: it failed with
`NotFoundError: Session not found: ses_gavinmint0000000000000001` and created
nothing. It fails loudly, which is the safe half of the answer.

**V11b — learning the id after launch: yes headless, racy interactive.**
`opencode run --format json` prints `sessionID` on **every** event, so a hidden
run always knows its own session. A TUI launch prints the id nowhere. The only
route is `opencode session list --format json`, which returns
`{id, title, created, updated, projectId, directory}` — scoped to the **project**
(a hash of the git root), never to a process. Two gavin sessions in one worktree
share a `projectId`, so newest-wins is exactly the race the card names.
`opencode --port <n>` does give a launch its own HTTP server on a known port, but
that server's `/session` is project-scoped too, so it narrows nothing by itself.

**V11c — resume by id works INTERACTIVELY.** `opencode --session <id>
--prompt=<text>` (the TUI, not `run`) reopened the session with its full prior
transcript rendered and the new prompt queued; the project's session count was
unchanged, so nothing was forked or created. Headless
`opencode run --session <id>` likewise answered a question that could only be
answered from the earlier turn (`BLUEHERON`) and reported the **same**
`sessionID`. So resume is not a headless-only flag — it covers the case gavin
actually has.

**V11d — extend is the default; fork is explicit and real.** Adding `--fork`
returned a **different** `sessionID` that still answered `BLUEHERON`, so the
prior conversation is carried, not lost. Nothing silently starts fresh.

**V11e — `--continue` is unusable, demonstrated rather than assumed.** From the
scratch project, `opencode run -c` resumed the most-recently-*updated* session in
the project — not the one under test — and answered with **that other
conversation's** codeword. In gavin's shared checkout it would resume whichever
agent touched the repo last.

**Verdict for Root 3:** opencode can resume an interactive session by id, and
forking is opt-in — but gavin cannot know a TUI session's id without a
project-scoped scan it has no way to disambiguate. Resume on this profile needs
that gap closed first; it is not this card's work.
