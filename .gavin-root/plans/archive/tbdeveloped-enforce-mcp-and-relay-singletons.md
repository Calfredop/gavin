---
complexity: moderate
order: 1280
kind: plan
title: [enforce] daemon singleton + gavin-mcp connect diagnosis
status: Done
---
My guess was that the "gavin daemon isn't running — open the gavin app (…: Connection refused)" errors, which hit mid-session at random and stay failed, came from duplicate daemon, mcp or relay processes. Reading the code settled three things. The relay is out of scope, because nothing in the product spawns one. gavin-mcp is one per agent session by design. The daemon is the one real singleton hole: a second copy of the same build runs `Registry::open`, `recover()`, the browser sweep and Headroom resume, and rewrites the token, before it finds out at `bind_server` that the socket is taken. So this plan closes that hole and makes the next connect failure name its own cause.

- [x] Daemon singleton lock: child card `daemon-singleton-lock.md`
- [x] gavin-mcp rides out a refused connect and names its cause: child card `gavin-mcp-connect-diagnosis.md`
- [ ] Human test: after both land and the app is rebuilt and restarted, the next time a session shows "daemon isn't running", open `gavin-mcp.log` and check that the line classifies the cause (no daemon / daemon alive but not accepting / socket path missing). File a follow-up card for that cause.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
