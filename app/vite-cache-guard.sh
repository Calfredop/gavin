#!/bin/sh
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
#
# POSIX sh, not zsh: this is started by hand on whatever the developer's
# machine calls a shell, and a Linux box has no /bin/zsh to find. The
# zsh-only line was `APP=${0:a:h}` -- an absolute dirname, which is what
# the cd/pwd below spells out portably. `CDPATH=` so a developer with
# CDPATH exported does not land somewhere else entirely.
APP=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BACKOFF=20
while true; do
  if [ ! -f "$APP/node_modules/.vite/deps/_metadata.json" ]; then
    echo "$(date '+%F %T') dep cache missing - forcing re-optimize (retry in ${BACKOFF}s if it fails)"
    touch "$APP/vite.config.js"
    sleep $BACKOFF
    if [ -f "$APP/node_modules/.vite/deps/_metadata.json" ]; then
      echo "$(date '+%F %T') cache rebuilt"
      BACKOFF=20
    else
      echo "$(date '+%F %T') still missing - a source file in the entry graph does not parse; check the dev server log"
      [ $BACKOFF -lt 120 ] && BACKOFF=$((BACKOFF * 2))
    fi
  fi
  sleep 2
done
