#!/bin/sh
# Creates the gavin-orchestration smoke-test playground (idempotent).
# The playground is git-ignored: binding it as a workspace root keeps all
# .gavin-root scaffolding out of the real repo's working tree.
cd "$(dirname "$0")" || exit 1
mkdir -p playground/src/auth
mkdir -p playground/docs
echo "playground ready at: $(pwd)/playground"
echo ""
echo "Next: in gavin, create a workspace named 'smoke-test' and follow README.md."
