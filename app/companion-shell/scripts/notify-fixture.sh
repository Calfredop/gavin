#!/bin/sh
# The iOS Notification Service Extension's open, held to the daemon's seal.
#
#   scripts/notify-fixture.sh
#
# Builds ios/App/NotificationService/NotifyOpen.swift for this Mac with a
# small runner (scripts/notify-fixture/main.swift) and runs it over the table
# the daemon's own tests seal from (test-fixtures/companion-notify/cases.json).
# Exits 0 only when every case opens, or is refused, and lands where the table
# says. macOS only: it needs swiftc and CryptoKit. src/shell/push/fixture.test.ts
# runs it as part of `npm run companion-shell:test` on a Mac.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
shell=$(dirname "$here")
repo=$(cd "$shell/../.." && pwd)

command -v swiftc >/dev/null 2>&1 || { echo "notify-fixture.sh: needs swiftc (Xcode or its command line tools)" >&2; exit 2; }

work=$(mktemp -d "${TMPDIR:-/tmp}/notify-fixture.XXXXXX")
trap 'rm -rf "$work"' EXIT

swiftc -O -o "$work/notify-fixture" \
  "$shell/ios/App/NotificationService/NotifyOpen.swift" \
  "$here/notify-fixture/main.swift"
"$work/notify-fixture" "$repo/test-fixtures/companion-notify/cases.json"
