---
kind: task
title: gavin-mcp rides out a refused connect and names its cause
parent: tbdeveloped-enforce-mcp-and-relay-singletons.md
complexity: moderate
---
In `crates/gavin-mcp/src/main.rs`, make a failed daemon connect survive a short gap, and make it explain itself when it does not. The symptom is "gavin daemon isn't running — open the gavin app (…: Connection refused)". It hits mid-session at random and stays failed while the app is clearly up. On macOS a refused connect on a Unix socket means the file exists but nothing is accepting, which fits three causes: a dead daemon's leftover socket, a wedged daemon with a full accept queue, or a restart window.

- **Retry.** When the connect fails with ECONNREFUSED or ENOENT, keep retrying for up to about 5 s, backing off from 100 ms to 1 s. Only retry while nothing has been sent on the connection, so gated requests are safe too. This replaces the single instant retry in `request`.
- **Classify.** If it still fails, the error keeps its current opening ("gavin daemon isn't running — open the gavin app") and adds:
  - the socket path, and whether it came from `GAVIN_SESSION_SOCKET` or the default;
  - the errno;
  - whether the path exists;
  - the pid recorded in `daemon{,-dev}.lock` beside the socket, and whether that pid is alive. The lock file comes from the sibling card `daemon-singleton-lock.md` and may not exist yet; tolerate that.

  From those, name exactly one cause:
  - *no daemon*: the path is present and the holder is dead or absent;
  - *daemon alive but not accepting*: the path is present and the holder is alive (accept queue full, or a hung daemon);
  - *socket path missing*.
- **Log.** Append the same line, with a timestamp and `GAVIN_SESSION_ID`, to `app_support_dir()/gavin-mcp{,-dev}.log`.
- **Tests.** Unit-test the classifier against a temp dir holding each of the three states.

gavin-mcp stays one per agent session; this is not a singleton. No protocol bump.
