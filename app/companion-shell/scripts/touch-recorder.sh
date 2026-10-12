#!/usr/bin/env bash
# The touch recorder (touch-recorder.js) on a physical iPhone, over USB:
# what each swipe on the Companion's terminal did -- whether rows moved,
# whether they kept moving after the finger lifted, whether the page
# scrolled instead, and how long the frames took.
#
#   scripts/touch-recorder.sh <udid> on        # install it in the open bundle
#   scripts/touch-recorder.sh <udid> report    # one line per swipe since
#   scripts/touch-recorder.sh <udid> clear
#
# Needs a debug build of the shell on the phone, unlocked, connected and
# trusted, with Settings > Apps > Safari > Advanced > Web Inspector on, and
# a Workstation's bundle open (the Demo's is `gavin-bundle://demo/`). The
# recorder lives in the page, so reopening the bundle needs `on` again.
#
# It evaluates through `device-drive.sh ios-device <udid> eval`, which
# opens no port.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
usage="usage: touch-recorder.sh <udid> on|report|clear"
udid=${1:?$usage}
action=${2:?$usage}

page() {
  "$here/device-drive.sh" ios-device "$udid" eval "gavin-bundle://"
}

case "$action" in
  on)
    page < "$here/touch-recorder.js"
    ;;
  clear)
    echo 'window.__touchrec ? window.__touchrec.clear() : "the recorder is not on"' | page
    ;;
  report)
    echo 'window.__touchrec ? window.__touchrec.report() : "the recorder is not on"' | page | python3 -I -c '
import json, sys
raw = sys.stdin.read().strip()
try:
    swipes = json.loads(raw)
except ValueError:
    print(raw)
    sys.exit(1)
print("%d swipes" % len(swipes))
for i, s in enumerate(swipes, 1):
    s = dict(s, i=i, page="SCROLLED" if s["pageScrolled"] else "still")
    line = ("%(i)2d  %(target)-14s %(moves)3d moves %(swipePx)+5d px  rows changed %(rowChanges)3d"
            " (%(changesAfterLift)d after lift)  %(rowsBefore)s -> %(rowsAfter)s  page %(page)s"
            "  frames p95 %(p95)d worst %(worst)d ms, %(over33)d over 33 ms") % s
    print(line + ("  ZOOM %s" % s["scale"] if s["scale"] != 1 else ""))
'
    ;;
  *)
    echo "$usage" >&2
    exit 64
    ;;
esac
