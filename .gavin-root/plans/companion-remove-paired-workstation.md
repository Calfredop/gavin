---
order: 20480
title: Companion: remove a paired Workstation from the hub with a long press
status: In Progress
priority: medium
---
The hub lists every Workstation this phone ever paired with and offers no way to forget one: a stale pairing (an old dev desk, a reinstalled Mac) sits there Unreachable for good. The native `Workstations.remove` exists on both platforms; nothing in the hub calls it.

- [x] `PairedStore.remove(id)` over the native plugin
- [x] Long-press logic in a pure module (`hub/longPress.ts`) with tests: a held press fires once, moving or lifting early cancels, the click after a fired press is swallowed
- [x] Hub: long-pressing a paired Workstation (never the Demo) asks inline "Remove <name> from this phone?" with Remove / Keep; the cards don't select text or show the iOS callout
- [x] Page: remove the record, drop it from `paired` (the live hub and the handover follow `paired`); its cached bundle is pruned with the next install, since `bundlesToKeep` reads only paired ids
- [x] companion-shell:test + :check green
- [x] Reinstall on the owner's iPhone (hand-signed debug build, no push); a synthetic touch on the device raised the prompt
- [ ] Human test: on the iPhone, long-press the stale MBP16Pro card, press Remove, and it is gone from the hub after a relaunch too; a plain tap on a card still opens it or tries it now
