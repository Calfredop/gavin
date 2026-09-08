---
order: 2048
title: [feat] the notify and email rail tools are macOS-only
status: To Do
---
Two builtin rail tools in `app/src/lib/orchestrationTools.ts` are
AppleScript:

- `builtin:notify` — `osascript -e 'display notification …'`
- `builtin:send-email` — an AppleScript block driving Mail.app

On Linux both fail at the step with `osascript: command not found`. That
is visible rather than silent, and both descriptions already say
"macOS", so the Linux port (`feat-linux-port.md`) deliberately left them
alone rather than quietly changing what a shipped tool does to existing
rails.

What a fix has to decide, which is why this is a card and not a patch:

- `notify-send` is the Linux equivalent and is not always installed
  (`libnotify-bin`). A tool whose whole job is to tell you something
  must not fail quietly when it cannot.
- There is no Mail.app equivalent at all. `xdg-email` opens a composer
  and does not send; sending needs an SMTP account gavin does not have.
  So the email tool may be macOS-only on purpose, in which case the
  honest thing is for the tool list to say so per platform instead of
  offering a step that cannot run.
- Either way a tool's body is a string the human can already edit, so
  the decision is about what the DEFAULT should be, and about whether
  the picker should hide a tool this machine cannot run.
