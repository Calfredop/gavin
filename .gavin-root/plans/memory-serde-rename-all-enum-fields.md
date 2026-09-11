---
order: 5120
kind: note
labels: memory
title: An enum's rename_all never reaches its fields
status: To Do
---
On a Rust enum, `#[serde(rename_all = "camelCase")]` renames the VARIANTS
and leaves every struct-variant field in snake_case. A report the frontend
reads needs `rename_all_fields = "camelCase"` beside it.

Why: `UsageReport` and `PrReport` both looked camelCased and were not, so
`observedAt`, `prState`, `reviewDecision`, `isDraft` and `createdAt` all
arrived `undefined`. Nothing failed loudly — the usage projection stamped
every sample NaN and said "measuring" for a year, and a MERGED pull
request never read as merged. Rust tests cannot see it: the parse is
right and only the wire names are wrong, so the guard has to be a
`serde_json::to_value` test asserting the exact keys TS reads.
