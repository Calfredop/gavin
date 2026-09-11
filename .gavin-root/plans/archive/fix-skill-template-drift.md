---
order: 8192
title: [fix] the app's embedded skill templates silently overwrite the workspace's own
status: Done
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

- [x] Restore the clobbered file — `git checkout -- .claude/skills/gavin-develop/SKILL.md`
      — and confirm the `complexity:` section is back.
- [x] Bring `app/src-tauri/src/gavin_develop_skill.md` up to what `f772997` put
      in the skill, so the two agree in the direction the history says is
      intended.
- [x] Guard it with a test, because a convention will not hold two files
      together: assert every `ManagedFile` in `agent_setup.rs` equals the
      `.claude/skills/…/SKILL.md` this repo ships. It cannot be a raw byte
      compare — `gavin_skill.md` carries a `{prd}` placeholder the installer
      substitutes per workspace (`.gavin-root/PRD.md` here), so the comparison
      has to run the same substitution the installer does. That placeholder is
      also the reason a "just diff the files" check would have reported a false
      positive on `gavin` and been switched off.
- [x] Decide what installing should do to a skill the workspace has EDITED.
      Unconditional overwrite is today's behaviour and it destroys local work
      with no record; leaving an edited file alone strands a workspace on an old
      skill. Either way the human should be able to see that it happened, which
      today they cannot. **Settled 2026-09-11: gavin still wins the file, but it
      no longer wins silently** — see "What a run does to an edited skill".
- [x] While in there: `gavin_prd_skill.md` and `gavin_agent_file_skill.md` are
      templates with no `.claude/skills/` counterpart in this repo. Confirm
      where they install and whether they need the same guard.

## What the guard actually checks

`every_embedded_document_matches_the_copy_this_repo_ships` builds its pair
list out of `AGENT_PROFILES` itself — every `ManagedFile` under `skills`
and `agent_file`, plus the two `StepSkill` documents that appear in no
table — rather than out of a second list written beside it, because a
hand-maintained list is the same convention that failed the first time.
Each pair this repo ships under `.claude/` is compared against
`with_prd_path(contents, prd_relative_path(repo))`: the installer's own
substitution, through the installer's own PRD lookup, so `gavin_skill.md`'s
`{prd}` resolves the way a real setup run here would resolve it. Line
endings are normalised on both sides — they belong to the checkout
(`core.autocrlf`), not to the document, and `include_str!` bakes in
whichever the build machine had.

Two assertions rather than one, because a loop that skips what it cannot
read guards nothing: the list of files it actually compared is pinned, so a
skill that goes MISSING from the repo fails here as loudly as one that
drifted. A third pins what is left unguarded and why, so a new managed
document cannot be added without a decision about its counterpart.

Proven by failing it: appending a line to `gavin_develop_skill.md` produced
`.claude/skills/gavin-develop/SKILL.md has drifted from the template the
app embeds`, and the file was restored and its sha256 checked back.

## What a run does to an edited skill

Ownership is unchanged: gavin's copy still wins the file. What changes is
that the bytes it displaces survive, and that the run SAYS so. `write_owned`
reads the target first; identical bytes are not a displacement and stay
silent, so an ordinary re-run reports nothing. Anything else is copied to
`<path>.replaced` — one backup per file, holding the most recently displaced
bytes — before gavin writes. It is deliberately not a `.md`: every skill
loader gavin writes for reads one filename per directory, and a second
markdown file beside it is one more thing that could get picked up.

The displacement is reported apart from `written`, because it is the only
line of the result that says something was LOST: `IntegrationResult.replaced`
carries `(file, backup)` pairs, the wizard renders them (`⟳ … — your copy
kept as …`) and the Settings panel gets the same fact through
`integrationNote` in `mcpServerTrust.ts` — a tested function rather than a
template string, since that sentence is the whole of what the human is told.
`compose_agent_prompt` writes its step skills through `write_owned` too: that
flow has no result to report on, so the `.replaced` file beside it is the
whole of the record, which makes preserving the bytes matter more there, not
less.

**The rejected option was holding an edited file back.** It reads as the
safer default and is not: gavin cannot tell a hand edit from a file an older
gavin wrote without recording the sha of every write it has ever made, so a
hold-back either strands a workspace on the first skill it ever installed, or
demands a state file plus a chooser to escape it. Preserving and reporting
gets the same guarantee — nothing is destroyed silently — at the cost of one
sidecar file, and it cannot strand anyone. Weighed against a hash record in
`.gavin-root/installed.toml` with a "keep mine / take gavin's" chooser
(2026-09-11) and rejected as machinery bought for a case the backup already
covers.

## Where the two unpaired templates install

`gavin_prd_skill.md` and `gavin_agent_file_skill.md` are `StepSkill`
documents, not `ManagedFile`s. `compose_agent_prompt` writes them on demand
— when the composer's "write the PRD" or "write the agent file" action runs
— into the profile's own skill slot beside the managed four:
`.claude/skills/gavin-write-prd/SKILL.md` and
`.claude/skills/gavin-write-agent-file/SKILL.md` here,
`.opencode/skills/…` in an opencode workspace. A profile with no skill slot
gets the same document inlined into the prompt and no file is written at
all. The delete wizard already knows about them — `skill_root` is scanned
for gavin-prefixed siblings precisely because they are in no table.

They need no counterpart guard today because they have no counterpart:
this repo commits neither, and the drift this card is about takes two
copies. What they get instead is a named place in the test's `unguarded`
list, so the day one of them is committed here the list changes and the
test demands the pairing. They already run through `with_prd_path`, so the
comparison would work unchanged.

They did share the last item's hazard: `compose_agent_prompt` wrote them
with a bare `fs::write`, so re-running a composer action destroyed an edited
step skill exactly the way setup destroyed an edited managed one. That call
goes through `write_owned` now too, so the decision reaches both.

## Where this landed

Every item above is implemented, and the suites that cover it are green:
`every_embedded_document_matches_the_copy_this_repo_ships`,
`a_run_that_displaces_an_edited_skill_keeps_it_and_reports_it` and
`every_skill_is_written_and_overwritten` all pass, and `npm run check` is
clean (0 errors). The two `agent_setup` reds and the ten `app/` reds on this
machine are the known Windows ones, named verbatim on
[feat-windows-port-on-a-windows-machine](./feat-windows-port-on-a-windows-machine.md)
(`expected /, got \` in the opencode skill paths) and
[fix-source-grep-tests-on-crlf-checkouts](./fix-source-grep-tests-on-crlf-checkouts.md);
both reproduce unchanged at HEAD in a clean worktree.

The work is **uncommitted**, in the `C:/Users/calfr/coding/gavin` checkout
(branch `win/windows-dev-setup`) rather than on a rail worktree —
`agent_setup.rs`, `backend.ts`, `mcpServerTrust.ts`, `mcpServerTrust.test.ts`,
`WorkspaceRootControl.svelte`, `IntegrationStep.svelte`. Committing is the
human's call.
