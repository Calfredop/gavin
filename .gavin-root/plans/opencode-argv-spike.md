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

Where something cannot be verified, say so explicitly rather than guessing. An
unverified convention stays out of the profile table — that is the table's whole
rule.
