---
title: Relay deploy and mobile compile guide
status: In Progress
---
Write a full operator guide for deploying the Relay and compiling the Companion mobile app, plus any missing helper scripts the guide needs.

- [x] Inventory existing Relay env, binary, and any deploy docs/scripts
- [x] Inventory companion-shell build/sync/store scripts and gaps
- [x] Draft guide covering Relay deploy (TLS, tokens, systemd/Docker, verify)
- [x] Draft guide covering mobile compile (prereqs, sync, iOS/Android, release)
- [x] Add related scripts the guide relies on
- [x] Link from existing READMEs where operators look first
- [ ] Human test: follow docs/relay.md to build and run the Relay image (or systemd unit), then docs/companion-mobile.md to compile one platform with scripts/compile.sh; confirm a phone/Simulator can pair through that Relay
