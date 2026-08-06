#!/usr/bin/env bash
# Prints every file-viewer test target to the terminal so each one is
# immediately cmd+clickable. Run this INSIDE a gavin terminal pane --
# cmd+click only works on terminal output, not on rendered file content.
#
#   ./test-fixtures/file-viewer/smoke-test.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The 2 MiB file is generated, never committed -- see .gitignore.
if [ ! -f "$DIR/big.txt" ]; then
  echo "generating big.txt (2 MiB, over the 1 MiB viewer cap)..."
  head -c 2000000 /dev/urandom | base64 > "$DIR/big.txt"
fi

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }

echo
bold "=== OPENS IN A PANE (internal viewer) ==="
dim  "1. Rendered markdown -- headings, table, code block, blue link:"
echo "   $DIR/sample.md"
dim  "2. TypeScript, syntax highlighted (keywords/strings/comments differ):"
echo "   $DIR/sample.ts"
dim  "3. Rust, to prove highlighting is not hardcoded to one language:"
echo "   $DIR/sample.rs"
dim  "4. Viewable but NO language -- plain monospace, all one colour."
dim  "   Also checks HTML escaping (a literal <h1> must NOT become a heading):"
echo "   $DIR/plain.log"
dim  "5. Over the 1 MiB cap -- expect the 'too large to preview in full'"
dim  "   notice plus a working 'Open externally' button:"
echo "   $DIR/big.txt"

echo
bold "=== OPENS IN THE OS DEFAULT APP (not a pane) ==="
dim  "6. Image -- extension not in VIEWABLE_EXTENSIONS:"
echo "   $DIR/tiny.png"
dim  "7. Extensionless -- fileExtension() returns \"\", also not viewable:"
echo "   $DIR/Makefile"

echo
bold "=== OPENS IN THE BROWSER ==="
dim  "8. Plain click does nothing; cmd+click opens the default browser:"
echo "   https://example.com"
echo "   https://github.com/Calfredop/gavin"

echo
bold "=== MUST NOT BECOME CLICKABLE ==="
dim  "9. Hovering this must NOT underline it -- the file does not exist,"
dim  "   so resolve_path_under_cursor returns null and there is no link:"
echo "   $DIR/definitely-not-real.txt"
dim  "10. A directory, not a file -- also must not become clickable:"
echo "   $DIR"

echo
bold "=== RELATIVE PATHS ==="
dim  "11. A ./-prefixed relative path SHOULD resolve (against this pane's cwd)."
dim  "    Run this from the repo root for it to work:"
echo "   ./test-fixtures/file-viewer/sample.ts"
dim  "12. KNOWN LIMITATION -- a BARE relative path (no ./) is not matched as"
dim  "    written. The matcher requires a /, ./, ../ or ~/ start, so the"
dim  "    candidate below is read from its first slash as \"/file-viewer/...\""
dim  "    and fails to resolve. Expect NO underline here:"
echo "   test-fixtures/file-viewer/sample.md"

echo
bold "=== LIVE RELOAD ==="
dim  "13. Open sample.md above, then run this and watch the pane update"
dim  "    within ~1s with no interaction:"
echo "   echo '- appended at '\"\$(date +%T)\" >> $DIR/sample.md"

echo
