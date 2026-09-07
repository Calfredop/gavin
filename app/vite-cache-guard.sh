#!/bin/zsh
# Self-heal the vite dep cache.
#
# When a source file in the entry graph fails to parse -- an agent's half-written
# import, or merge conflict markers -- esbuild's dep scan fails and vite leaves
# node_modules/.vite/deps deleted. The running dev server then 504s every
# dependency, svelte included, and the app window goes white with nothing in the
# console to explain it.
#
# Touching the config makes vite restart in-process and re-optimize. No process
# is killed, so agent sessions and the daemon are untouched. If the rebuild keeps
# failing the cause is a broken source file, not the cache, so back off rather
# than restart the server every few seconds under the agents working in it.
APP=${0:a:h}
BACKOFF=20
while true; do
  if [ ! -f "$APP/node_modules/.vite/deps/_metadata.json" ]; then
    echo "$(date '+%F %T') dep cache missing - forcing re-optimize (retry in ${BACKOFF}s if it fails)"
    touch "$APP/vite.config.js"
    /bin/sleep $BACKOFF
    if [ -f "$APP/node_modules/.vite/deps/_metadata.json" ]; then
      echo "$(date '+%F %T') cache rebuilt"
      BACKOFF=20
    else
      echo "$(date '+%F %T') still missing - a source file in the entry graph does not parse; check the dev server log"
      [ $BACKOFF -lt 120 ] && BACKOFF=$((BACKOFF * 2))
    fi
  fi
  /bin/sleep 2
done
