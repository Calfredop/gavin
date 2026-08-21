---
kind: note
title: Nested plan in demo data
status: Done
---
# Nested plan in demo data

Seed demo data now covers card nesting: a parent plan (`auth-rework.md`,
2/4 checklist, two labels), two tasks nested inside it (parent + no
status), one freed into its column wearing the parent chip, a task whose
parent does not exist, and a note — the kind that must refuse to nest.

Covers the smoke items `nest-inside`, `nest-freed`, `nest-refuse`,
`composer-plan` progress and the label chips, which previously had no
fixtures to run against.
