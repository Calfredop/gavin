---
kind: note
title: Phase 3: the device pushes reach the app COMMAND connection too
status: To Do
priority: medium
---
Found while wiring the three device pushes into the app (the settings-panel task).

`server.rs`'s `handle_connection` registers EVERY connection whose `Hello` proves the daemon token into `app_connections`, and the desktop opens TWO: the streaming one that carries pushes, and the command one that `send_command` drives request-then-response over. So `push_to_apps` writes each device push to both.

`send_command` takes the FIRST message it reads as the reply. A `DevicePairingRequested` arriving on the command connection while a request is in flight is therefore read as that request's answer -- and the reply it displaced is then read as the answer to the NEXT request, so the connection stays one message out of step until something fails.

**It cannot fire in phase 2.** Nothing in the daemon binary produces any of the three pushes yet: `pair_over` and `register_device_connection` are `#[allow(dead_code)]` and reached only from tests, because there is no transport. Phase 3's `remote.rs` is exactly what makes them routine.

**Not fixed in the settings task**, deliberately: the fix is the daemon's, not the app's. The two connections are indistinguishable to `resolve_hello` today, so telling them apart needs a field on `Hello` (which connection this is) or a separate subscribe request -- a protocol change, and one that belongs with the transport that needs it.

Worth folding into `docs/security/05-remote-access.md` §7 when the spec pass runs: 'push to every live app connection' is not the same as 'push to the connection the app reads pushes on', and the design says the former.
