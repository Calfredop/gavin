#!/bin/zsh
# Self-heal the vite dep cache. If node_modules/.vite/deps vanishes, the running
# dev server 504s every dependency (svelte included) and the app window goes
# white. Touching the config makes vite restart in-process and re-optimize --
# no process is killed, so agent sessions and the daemon are untouched.
APP=${0:a:h}
while true; do
  if [ ! -f "$APP/node_modules/.vite/deps/_metadata.json" ]; then
    echo "$(date '+%F %T') dep cache missing - forcing re-optimize"
    touch "$APP/vite.config.js"
    /bin/sleep 20
  fi
  /bin/sleep 2
done
