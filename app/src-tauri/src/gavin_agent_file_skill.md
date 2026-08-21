---
name: gavin-write-agent-file
description: Use when the owner asks you to write this repo's agent instructions file (CLAUDE.md, AGENTS.md, or whatever it is configured as).
---

# Writing this repo's agent instructions file

This file is what every agent reads before working here. It should carry
what is *not* obvious from the code: how to build and test, the conventions
that are load-bearing, and the traps that have already caught someone.

## How to do it

1. **Read the repo.** Build files, test config, CI workflows, the existing
   README. Run the test command once to confirm it actually works — writing
   down a command you have not run is how these files start lying.
2. **Write the file** with: the build, test and lint commands; the
   architecture in a few sentences; and the conventions a newcomer would
   otherwise violate.
3. **Show the owner what you wrote.**

## Rules

- **Never touch anything between `<!-- gavin:start -->` and
  `<!-- gavin:end -->`.** That block belongs to gavin and is rewritten on
  every setup run, so edits there are silently lost.
- Do not restate what the code already makes obvious. Density beats length.
- No secrets, tokens, or absolute paths from your machine.
