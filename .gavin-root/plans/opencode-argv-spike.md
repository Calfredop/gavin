---
kind: task
title: [spike] opencode argv, skill and agent conventions
parent: opencode-integration.md
---
Verify, against the opencode binary installed on this machine (1.3.13) and a
scratch workspace, every convention gavin is about to hard-code into the
opencode row of `AGENT_PROFILES` (`app/src-tauri/src/agent_setup.rs`). Write
nothing into `app/` — your deliverable is a `## Verified` block appended to
`.gavin-root/plans/opencode-integration.md`, one line per row, each naming the
command you ran and what it printed.

Work in a throwaway directory (`mktemp -d`), never in this repo's tree: the
checkout is shared with other agent sessions.

1. `opencode --prompt '<text>'` starts the TUI already carrying the prompt, and
   the bare positional is still a project directory. Confirm a prompt containing
   single quotes, newlines and a leading `-` survives `shellQuote`
   (`app/src/lib/cardRun.ts`) intact.
2. `opencode run --agent <name> -- '<prompt>'`: does `--` separate, or does it
   land in the message? If it is wrong, find the argv that is right — gavin's
   headless contract needs the prompt to be unmistakable.
3. The agent-file directory: `.opencode/agent/` or `.opencode/agents/` — the
   docs disagree. Ask the binary (`opencode agent`). Then confirm a `permission`
   block with `bash: { "*": deny, "git *": allow }` is honoured in a
   non-interactive `run`, and that a denied tool makes the run **fail** rather
   than hang waiting for an approval nobody can give. A hidden session that
   never exits is a spinner with no end.
4. `.opencode/skills/<name>/SKILL.md` is discovered, using gavin's real
   `app/src-tauri/src/gavin_skill.md` copied in unchanged — its frontmatter must
   satisfy opencode's validator as-is.
5. MCP: write the entry gavin writes (`mcp.gavin = { type: "local",
   command: [...], enabled: true }`) pointing at a built `gavin-mcp`, and
   confirm from inside a session that the `gavin_*` tools are listed and
   callable.
6. Whether `--model` always wants `provider/model`, and whether any stable alias
   exists that would justify filling the profile's empty `models` list.
7. Conversation resume, which gavin now needs from every profile
   (`.gavin-root/plans/bug-agent-connection-failure.md`, Root 3). Three things,
   in order — each is useless without the one before it:
   a. **Fixing the id at launch.** Claude Code takes `--session-id <uuid>`, so
      gavin mints the id and always knows it. Ask the binary whether opencode
      has an equivalent. If it does not, the fallback question is whether the id
      can be learned deterministically right after launch — printed, or written
      to a known path — because guessing it by scanning a session directory for
      the newest entry races every other agent on this machine.
   b. **Resuming by that id**, in the same cwd, for an INTERACTIVE session.
      This is the case gavin actually has: rail steps and card runs are TUI
      sessions, not `run` invocations, so a session flag that exists only on the
      headless subcommand does not close this out. Check both and say which.
   c. **Whether resuming extends the original conversation or forks a new one**,
      and whether that is selectable (Claude Code has `--fork-session`).
   Any cwd-keyed "continue the last conversation here" flag is unusable
   regardless of what it is called: this checkout is shared, several agent
   sessions run in one worktree, and gavin would resume the wrong one.
   The failure to watch for is a resume that silently starts a FRESH
   conversation instead of erroring. That is worse than having no resume at
   all — it is the from-scratch second attempt that
   `.gavin-root/plans/archive/bug-interrupted-agent-runs.md` exists to stop,
   wearing a better name. Verify by resuming a session and asking it what it
   already did, not by watching the command exit 0.

Where something cannot be verified, say so explicitly rather than guessing. An
unverified convention stays out of the profile table — that is the table's whole
rule.
