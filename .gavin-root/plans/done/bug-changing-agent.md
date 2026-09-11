---
order: 8192
kind: plan
title: [bug] changing agent
status: Done
complexity: moderate
---

Changing the workspace Profile in Settings writes immediately and never
realigns complexity. App-level complexity pins stay the fall-through for
unset workspace rows, so a level that looked like "this workspace's
agent" can keep launching the previous profile after the switch. Fix:
gate the profile change behind a confirm mini-wizard.

Out of scope: `ui-settings-order`, `feat-fallback-agent`. App Settings
keeps editing the global complexity table as today — no agent-switch
wizard there.

- [x] Pure helpers: given old profile, new profile, and the workspace
      complexity table, implement keep / remap (rows naming old → new) /
      clear (drop workspace overrides so unset means true workspace
      agent, still falling through to app pins). Unit-test all three.
- [x] Settings Profile select no longer calls `setAgentField` on change;
      it opens the confirm mini-wizard with the pending profile.
- [x] Wizard step: complexity realign — keep pins / remap to new agent /
      clear workspace overrides. Default recommendation: remap when any
      row names the old profile, else clear.
- [x] Wizard steps (reuse init-wizard agent-adjacent work, not Git/PRD/
      Review/Launch): Integration (MCP), Superpowers, and skills /
      agent-file status for the **pending** profile; offer install /
      fix-up where missing.
- [x] Commit only after the human finishes the wizard: write profile
      (+ any complexity table change from the choice), then close.
      Cancel leaves config and complexity untouched.
- [ ] Owner check in the running app: switch Profile → wizard → each
      complexity choice → MCP/Superpowers/skills for the new agent →
      rated cards resolve as expected; Cancel writes nothing.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you
touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
