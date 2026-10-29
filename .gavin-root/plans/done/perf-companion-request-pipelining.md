---
order: 10240
title: [perf] companion: time the wire, pipeline the shell's requests
status: Done
---
Follow-up to `done/perf-companion-workspace-sync.md`. A connect is ~35 round trips answered one at a time, because the shell's `liveConnection` keeps one request in flight. The daemon answers one connection's requests strictly in order, so the shell can send them all and pair replies FIFO.

- [x] Confirm companion-core's exchange takes several outgoing frames before a reply
- [x] Confirm every `answers` predicate is strict enough to pair FIFO with pushes interleaved
- [x] Timing: per-request round trip + connect total, measured in the shell
- [x] Pipeline `liveConnection.request` (FIFO waiters, per-request timeouts, failure on end)
- [x] Tests in companion-shell; run its test/check/build
- [ ] Human test on a real phone
- [ ] Human test: Debug shell on the iPhone over the Relay: open a Workstation and enter a workspace with Safari Web Inspector on the shell — the `[gavin-visit] N calls in X ms` lines appear, the open feels clearly faster than before, and terminals, board and cards still answer normally

## Notes

- The daemon already takes a burst: `device_wire.rs`'s
  `a_great_many_requests_in_one_frame_are_each_answered` sends 5000 in one frame. Only
  `DesktopEvent` and `RelayAdmissionChanged` are pushed to a Device, and the latter
  never reaches a request.
- `connection.ts`: every request is sent at once into a FIFO; an answer goes to the
  oldest. A request's clock starts when the daemon reaches it (everything before it
  answered or timed out), as it did when it was only sent then. A request that timed
  out, or was answered from the inbox, stays in the FIFO to take its own late answer,
  which before this went to the NEXT request.
- `visit/wireTiming.ts`: bursts of calls (first call while none out → none out) logged
  as `[gavin-visit] N calls in X ms; slowest <cmd> (Y ms)` in a debug build's console
  (Safari Web Inspector on the shell's webview). Bursts under 5 calls and 1 s are not said.
- Found on the way: since bb5dc36b (10-19) the shell's build and 7 of its test files
  failed, because `$lib/core/settings.ts` imported `cursorMcpApproval` from
  `mcpServerTrust.ts` (→ backend → Tauri). The pure half now lives in
  `$lib/workspace/mcpForeignChoice.ts`, re-exported by `mcpServerTrust.ts`.
- Green: companion-shell test 42/42 files (407), check 0 errors, build OK; app `npm test`
  373 files, `npm run check` 0 errors; companion test 926, check 0 errors.
