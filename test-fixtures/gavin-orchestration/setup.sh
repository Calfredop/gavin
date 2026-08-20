#!/bin/sh
# Creates the gavin-orchestration smoke-test playground (idempotent).
# The playground is git-ignored: binding it as a workspace root keeps all
# .gavin-root scaffolding out of the real repo's working tree.
#
# This only makes the empty folder. Everything inside it -- plans, docs,
# specs, the three contexts, the plain .rs file and the over-cap log --
# is written by the hub's "Seed demo data" button, so the fixture has one
# definition (SEED_FILES in app/src-tauri/src/session.rs) rather than two
# that drift apart.
cd "$(dirname "$0")" || exit 1
mkdir -p playground
echo "playground ready at: $(pwd)/playground"
echo ""
echo "Next: in gavin, open the dev Smoke Test workspace, bind this folder as its"
echo "root (Set root… → Initialize), then click Seed demo data. See README.md."
