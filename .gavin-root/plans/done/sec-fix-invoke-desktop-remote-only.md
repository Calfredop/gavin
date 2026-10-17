---
order: 39936
kind: task
title: "[sec] InvokeDesktop lets an untokened local connection run privileged desk commands past the require_local_token narrowing"
status: Done
priority: low
complexity: simple
---
Fix a low-severity finding from the 2026-10-15 security audit (run-1). Fingerprint: `crates/daemon/src/server.rs:is_privileged:InvokeDesktop-open-to-narrowed-local-role`.

Full record: `findings.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

When the require_local_token marker is present, an untokened same-uid connection (role local) is refused the privileged set: CreateSession, SetRootConfigField, RunGit, BeginPairing/ConfirmPairing, the Headroom and Playwright installs, and the rest. InvokeDesktop is not in that set, so it is served for every role that authorize lets through. The daemon judges it only against the Remote role's command table, by name, and the desk host runs the forwarded call as the desk, with no allowlist of its own. The narrowed connection can therefore have the desk run create_session (a shell), set_root_config_field, git_*, detect_headroom/install_headroom and playwright_install. It can also run set_require_local_token(false), which deletes the marker and gives back every direct privileged request, pairing included. No desk, agent or MCP client sends InvokeDesktop: it appears nowhere in app/src-tauri/src, crates/gavin-mcp/src or crates/companion-core/src. Opening it to roles other than Device therefore serves no client. AD-1 bounds the impact. The narrowed principal is the same OS user, and that user can read the 0600 daemon-dev.token or delete the marker file directly. This bypasses a documented defence-in-depth narrowing whose stated purpose is "you must authenticate to start a shell" (server.rs:7673) and "you must authenticate to pair a phone" (server.rs:7699). It is not a privilege gain across OS users.

## Root cause

authorize lets Role::Local through everything except is_privileged requests while the marker is on (server.rs:7762). is_privileged (server.rs:7676-7744) omits Request::InvokeDesktop, which is a second path to the same effects. The InvokeDesktop intercept in serve_connection (server.rs:8227) serves any role that passed authorize. invoke_desktop (server.rs:2707-2723) checks only the command name with allowance_for, skips the ownership gate when device_id is None, and calls forward_to_desktop/ask_desktop. ask_desktop writes ForwardCommand to the desk's forwarding connection.

## The invariant to enforce

InvokeDesktop is the Remote role's door to the desk. Only a connection whose identity the Device transport fixed should reach invoke_desktop. When the marker is present, an untokened local connection should get Forbidden for InvokeDesktop, exactly as it does for CreateSession.

## Trace (lines as of 2026-10-16; re-read before editing)

- `crates/daemon/src/server.rs:8160` (serve_connection authorization gate): An untokened connection on the local socket (no Hello, or Hello{auth:none}) is authorized as Role::Local on every request, with require_local_token() read live from the marker file (server.rs:7828).
- `crates/daemon/src/server.rs:7762` (authorize): Role::Local => !require_local_token || !is_privileged(req): the marker refuses only what is_privileged lists.
- `crates/daemon/src/server.rs:7676` (is_privileged): Lists CreateSession, SpawnAgentSession, SetRootConfigField, RunGit*, BeginPairing/ConfirmPairing, Set*Access, Headroom, PlaywrightEndpoint and InstallPlaywrightBrowser, but not InvokeDesktop.
- `crates/daemon/src/server.rs:8227` (serve_connection InvokeDesktop intercept): Served for any role that passed authorize. A local connection has identity.device_id None.
- `crates/daemon/src/server.rs:2707` (SessionManager::invoke_desktop): Checks only protocol::allowance_for(command). device_input ownership runs only when device_id is Some, so an Allowed name goes straight to forward_to_desktop (2726).
- `crates/daemon/src/server.rs:2657` (SessionManager::ask_desktop): Writes ForwardCommand{call_id, command, args} to the registered desk forwarding connection and waits for its ForwardResult.
- `app/src-tauri/src/forwarding.rs:292` (forwarding::dispatch): The host runs the named command through its webview's invoke handler as the desk, adding only the gavin-forwarded header and applying no host-side allowlist. set_require_local_token (session.rs:3431) does not consult is_forwarded and removes the marker file.

## Fix

Make InvokeDesktop a Device-only request. Either add it to is_privileged so a narrowed local connection gets Forbidden, or, more strictly, refuse it in the serve_connection intercept unless the identity was fixed by the Device transport (role Remote). No desk, agent or MCP client sends it today. Regression test: with the marker present, an untokened InvokeDesktop{create_session} is answered Forbidden, role local, and a Device's InvokeDesktop still forwards. Optionally refuse set_require_local_token on the host when is_forwarded(request) is true.

`crates/daemon/src/server.rs`, as a sketch only:

```
// in is_privileged(): the Remote role's door to the desk runs desk commands
// as the desk, the same reach as CreateSession and the rest of this list.
            | Request::InvokeDesktop { .. }

// or, stricter, in serve_connection before invoke_desktop:
if let Request::InvokeDesktop { command, args } = req {
    if identity.role != Role::Remote {
        write_message(&mut *writer.lock().unwrap(), &Response::Forbidden {
            request_type: "InvokeDesktop".to_string(),
            role: role_name(&identity.role).to_string(),
        })?;
        continue;
    }
    // ... unchanged ...
}
```

## Same root cause: the narrowed local role

Later audit work showed that `InvokeDesktop` is one instance of a wider gap. With `require_local_token` on, `is_privileged` still leaves out several requests that lead to a shell or to a launch the human will later replay:

- `LinkCardSession`. Verifier v44 observed an untokened local connection storing an arbitrary replayable command on any card.
- `WriteInput` and `QueueInput`.
- `SaveTool` and `StartToolRun`.
- `SetOrchestration` and `SetRailRun`.

Audit the whole list against the stated purpose ("you must authenticate to start a shell"), not just `InvokeDesktop`. Add a regression test that walks every `Request` variant, and fails when a variant whose handler can spawn a session, write PTY input or set a replayable launch is still allowed for an untokened local connection with the marker on.

## Done when

- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests in the touched crate or module, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched.
- The audit reproduction no longer works. It is the record's `execution` field in `findings.json`.
- Follow the CLAUDE.md traps that apply: a new SQLite column needs its own `ALTER TABLE`, a widened request needs a compat-gate entry, and you commit only your own files.
