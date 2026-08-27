---
kind: plan
title: Pickable PRD / agent file paths
status: Done
---
Execution plan for `prd-file-picker.md` — let an existing project point gavin
at the PRD and agent-instructions files it already has, and make every
reference to those files follow the configured path.

The PRD path is a top-level `prd` key in `.gavin-root/config.toml` (relative
to the root), NOT part of `[agent]`: which document leads the workspace does
not change when the CLI does. Absent keeps today's `.gavin-root/PRD.md`. The
agent file was already configurable by name; what it lacked was a picker.

- [x] protocol: `DEFAULT_PRD_PATH` + `usable_prd_path`, `GavinContext.prd`, PROTOCOL_VERSION 17
- [x] daemon: parse the key, `read_prd` and `has_prd` follow it, `set_root_config_field` writes/clears it
- [x] host: the gavin block, both skill files and `compose_agent_prompt` name the configured PRD
- [x] frontend pure: `resolvePrdPath`, `validatePrdPath`, root-relative pick conversion + tests
- [x] frontend UI: a path strip with Pick… on both hub tabs, both rows in Settings, `prdPath: 17` gate
- [x] frontend readers: Home excerpt, wizard and PRD step read the resolved path
- [x] smoke items + full suites (cargo, npm test/check/build) — all green

**Left for the human.** PROTOCOL_VERSION went 16 → 17, so the PRD picker stays
disabled (with the reason) until the daemon is rebuilt and restarted, and
`gavin-mcp` fails closed until it is rebuilt too. Five smoke items are filed:
`prd-pick`, `prd-pick-outside`, `agent-file-pick`, `set-prd-path`,
`set-prd-integration`.
