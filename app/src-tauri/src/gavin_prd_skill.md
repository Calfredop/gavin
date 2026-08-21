---
name: gavin-write-prd
description: Use when the owner asks you to write or revise this workspace's PRD — interview them, then write .gavin-root/PRD.md.
---

# Writing this workspace's PRD

`.gavin-root/PRD.md` is the lead document for this repo. Every plan should
trace back to a line in it, so it has to say what is actually being built —
not what sounds good.

## How to do it

1. **Read the repo first.** README, package manifests, the largest source
   directories. Form your own view of what this project is before asking:
   questions you could have answered yourself waste the owner's time.
2. **Interview the owner.** One question at a time. Start with what the
   project is for and who uses it; then what the current push is; then what
   they have deliberately decided *not* to do. That last one is the section
   people skip and later regret.
3. **Write the file**, keeping its existing headings exactly: `## Vision`,
   `## Current focus`, `## Out of scope`. Replace the italic placeholder
   under each with real prose.
4. **Show them what you wrote** and let them correct it.

## Rules

- Never invent scope. If they have not decided something, ask — or leave the
  placeholder in place. A placeholder is honest; a guess is not.
- Keep it short. A PRD nobody rereads is worthless; aim for one screen.
- Do not restructure the file. Those three headings are what gavin's home
  screen reads.
