---
order: 41984
kind: task
title: [bug] Fallback agent
status: In Progress
---
In Grimoria workspace I had Gemini CLI as first limit hit fallback. On this machine I have gemini installed but no plan, so I went in the app settings and removed Gemini CLI, leaving Cursor as the new first fallback. Getting back to Grimoria an trying to restart the task, gemini kept spawning, even force setting the fallbacks in Grimoria workspace settings. The only solution was to change the main agent (I went for Kimi at the end).

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
