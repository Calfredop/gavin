---
kind: task
title: "[sec] Any local connection can answer a Device's pending forwarded call by its sequential call id"
status: To Do
priority: low
complexity: simple
---
Fix a low-severity finding from the 2026-10-15 security audit (run-1). Fingerprint: `crates/daemon/src/server.rs:complete_forward:ForwardResult-not-bound-to-forwarding-connection`.

Full record: `findings.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

Each forwarded call gets an id from a process-wide counter that starts at 0, and the pending entry records the token of the forwarding connection the call was written to. serve_connection still accepts ForwardResult, AttentionResult and BundleResult from any connection that passes authorize. That includes an untokened `local` connection even when the require_local_token marker is present, because none of the three is in is_privileged. complete_forward, complete_attention and complete_bundle settle the waiter by call_id alone. A same-uid process can therefore guess the next id and race the desk's real answer: the waiting caller (a Device's InvokeDesktop, GetAttention or GetCompanionBundle) receives the forger's value or error, and the desk's later genuine answer is dropped silently. On a Device's create_session, the forged value goes to note_device_activity. That records the Device as the Started owner of whatever session id the forger names, and updates its presence. Impact is bounded by AD-1: the forger runs as the same OS user, who can read the 0600 daemon token and take the forwarding slot outright.

## Root cause

Settlement is not bound to the forwarding connection. The ForwardResult/AttentionResult/BundleResult intercepts in serve_connection (server.rs:8273, 8293, 8308) run for any App or Local connection. They do not check that the connection holds `_forwarding_slot`. complete_forward (2737-2741) and its two siblings remove pending_forwards[call_id] without comparing the stored forwarding token (inserted at 2680) to the sender. Call ids come from fetch_add on next_forward_call starting at 0 (2678), so they are predictable.

## The invariant to enforce

Only the forwarding connection a call was written to can settle it. A ForwardResult, AttentionResult or BundleResult from any other connection is refused and leaves the pending call untouched, so the desk's real answer still completes it.

## Trace (lines as of 2026-10-16; re-read before editing)

- `crates/daemon/src/server.rs:8160` (serve_connection authorization gate): An untokened local connection's ForwardResult/AttentionResult/BundleResult passes authorize. Role::Local is refused only is_privileged requests when the marker is present, and these three are not in that set (7676-7746). agent_allows and remote_allows exclude them, so Agents and Devices cannot send them.
- `crates/daemon/src/server.rs:2678` (SessionManager::ask_desktop): call_id = next_forward_call.fetch_add(1) is a process-wide counter starting at 0, so the forger can guess it without seeing the ForwardCommand.
- `crates/daemon/src/server.rs:8273` (serve_connection ForwardResult intercept): Served on any connection that reached this point. Nothing checks `_forwarding_slot`, though the comment above says these are the desktop's answers on the forwarding connection.
- `crates/daemon/src/server.rs:2737` (SessionManager::complete_forward): Removes pending_forwards[call_id] and sends ForwardOutcome::Done with the sender's value and error. The forwarding token stored beside the waiter is ignored (`(_, tx)`).

## Fix

Bind settlement to the forwarding connection. In serve_connection, answer ForwardResult/AttentionResult/BundleResult with an Error unless this connection holds `_forwarding_slot`, and pass that slot's token into complete_forward/complete_attention/complete_bundle. Those functions settle a pending call only when the token stored with it matches; otherwise they leave it pending. Regression test: a ForwardResult from a non-forwarding connection (untokened local, and a second app connection) gets an Error, and the pending call still completes with the desk's answer.

`crates/daemon/src/server.rs`, as a sketch only:

```
fn complete_forward(&self, from: u64, call_id: u64, value: Option<serde_json::Value>, error: Option<String>) -> bool {
    let mut pending = self.pending_forwards.lock().unwrap();
    if !pending.get(&call_id).is_some_and(|(to, _)| *to == from) {
        return false;
    }
    if let Some((_, tx)) = pending.remove(&call_id) {
        let _ = tx.send(ForwardOutcome::Done { value, error });
    }
    true
}
// complete_attention / complete_bundle take `from` and check it the same way.

// serve_connection:
if let Request::ForwardResult { call_id, value, error } = req {
    let resp = match _forwarding_slot.as_ref() {
        Some(slot) => { manager.complete_forward(slot.token, call_id, value, error); Response::Ok }
        None => Response::Error { message: "gavin-daemon: only the desktop's forwarding connection answers a forwarded call".into() },
    };
    write_message(&mut *writer.lock().unwrap(), &resp)?;
    continue;
}
// likewise for AttentionResult and BundleResult
```

## Done when

- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests in the touched crate or module, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched.
- The audit reproduction no longer works. It is the record's `execution` field in `findings.json`.
- Follow the CLAUDE.md traps that apply: a new SQLite column needs its own `ALTER TABLE`, a widened request needs a compat-gate entry, and you commit only your own files.
