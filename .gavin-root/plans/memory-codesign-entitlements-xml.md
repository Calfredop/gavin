---
order: 3072
kind: note
title: codesign's plist parser is stricter than plutil
labels: memory
status: To Do
---
An XML comment containing a double hyphen passes `plutil -lint` and fails
`codesign`, which reports `Failed to parse entitlements:
AMFIUnserializeXML: syntax error near line N` and fails the whole bundle.

Why: XML forbids `--` inside a comment; plutil tolerates it, AMFI does
not. The repo's house style uses `--` as an em dash, so any commented
`.plist` is one sentence away from an unbuildable bundle.
