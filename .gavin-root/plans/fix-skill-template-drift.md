---
order: 8192
title: [fix] the app's embedded skill templates silently overwrite the workspace's own
status: To Do
priority: medium
complexity: moderate
---
Opening this repo as a workspace reverted `.claude/skills/gavin-develop/SKILL.md`
to an older version — 15 lines in, 64 out, the whole `complexity:` rating
section among them — with no prompt, and nothing on screen to say it had
happened. The file is now byte-for-byte identical to
`app/src-tauri/src/gavin_develop_skill.md`, which is how it was identified.

`agent_setup.rs` installs each skill as a `ManagedFile` whose `contents` are
`include_str!`'d into the binary, and writes it unconditionally. Whatever the
workspace had is gone. Four skills are managed per agent profile — `gavin`,
`gavin-orchestrate`, `gavin-resume`, `gavin-develop` — and the list is repeated
for each profile, so the same write happens whichever agent the workspace uses.

The two copies had drifted, and the app reinstated the stale side over the
current one:

- `6eb92c4` changed the template and the installed skill together.
- `f772997` ("group the composer's agent actions and let one develop the card")
  added the `complexity:` section to `.claude/skills/gavin-develop/SKILL.md`
  and **did not touch** `app/src-tauri/src/gavin_develop_skill.md`.

Nothing links the two files. One is Rust-adjacent, one is prose; they are edited
by different kinds of work, and only luck keeps `gavin-orchestrate` and
`gavin-resume` matching their templates today.

This is worse than one lost file, because gavin's own checkout **is** a gavin
workspace. Every developer who runs the app against it gets an uncommitted
revert in a shared tree, and the obvious reading of an unexplained edit to a
skill file is that an agent did it.

- [ ] Restore the clobbered file — `git checkout -- .claude/skills/gavin-develop/SKILL.md`
      — and confirm the `complexity:` section is back.
- [ ] Bring `app/src-tauri/src/gavin_develop_skill.md` up to what `f772997` put
      in the skill, so the two agree in the direction the history says is
      intended.
- [ ] Guard it with a test, because a convention will not hold two files
      together: assert every `ManagedFile` in `agent_setup.rs` equals the
      `.claude/skills/…/SKILL.md` this repo ships. It cannot be a raw byte
      compare — `gavin_skill.md` carries a `{prd}` placeholder the installer
      substitutes per workspace (`.gavin-root/PRD.md` here), so the comparison
      has to run the same substitution the installer does. That placeholder is
      also the reason a "just diff the files" check would have reported a false
      positive on `gavin` and been switched off.
- [ ] Decide what installing should do to a skill the workspace has EDITED.
      Unconditional overwrite is today's behaviour and it destroys local work
      with no record; leaving an edited file alone strands a workspace on an old
      skill. Either way the human should be able to see that it happened, which
      today they cannot.
- [ ] While in there: `gavin_prd_skill.md` and `gavin_agent_file_skill.md` are
      templates with no `.claude/skills/` counterpart in this repo. Confirm
      where they install and whether they need the same guard.
