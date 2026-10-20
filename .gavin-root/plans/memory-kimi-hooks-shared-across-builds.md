---
order: 13312
kind: note
title: A kimi hook runs under every gavin build
labels: memory
topics: kimi, hooks, builds
---
A hook gavin writes into kimi's global config.toml runs in every gavin build's sessions, so it must do nothing unless the hosting daemon sets a variable vouching for its gavin-mcp (GAVIN_SHELL_WRITES, set by v72+ daemons only).
Why: under an older release daemon GAVIN_MCP names a gavin-mcp without the new subcommand, which would start an MCP server on the hook's stdin.
