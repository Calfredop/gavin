---
title: InvokeDesktop Device-only + narrowed local
status: Done
priority: low
complexity: simple
---
Working checklist for sec-fix-invoke-desktop-remote-only (absolute card under `.gavin-root/plans/`).

- [x] Keep `narrowed_local_allows` as the marker-on gate; InvokeDesktop and shell/PTY/launch variants refused
- [x] Refuse InvokeDesktop in serve_connection unless Role::Remote
- [x] Regression: marker on + untokened InvokeDesktop{create_session} => Forbidden; Remote still authorized
- [x] Exhaustive test: every Request that can spawn / write PTY / store a launch is Forbidden for narrowed local
- [x] Refuse set_require_local_token on the host when is_forwarded
- [x] Run daemon tests for the authorize / InvokeDesktop paths
- [x] Set the task card to Done when green
