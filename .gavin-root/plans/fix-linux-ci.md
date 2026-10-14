---
title: [fix] Linux CI red: headless browser and session memory tests
status: In Progress
priority: high
complexity: moderate
---
`ci.yml`'s Linux job has been red on every run since at least 38266360595, so no commit on `main` passes CI, and the Preview build (`feat-installers.md`) cannot publish without `--force`. macOS, Windows, WASM and the audit are green.

Failing on ubuntu-latest, from run 38542951802 on `054f04d0`:

- Every test that drives the headless browser over CDP gets `ConnectionReset` on its first reply: `browser_view::tests::a_hosts_browser_reaches_a_device_at_the_phones_size_over_a_bridge_of_its_own`, `device_wire` `a_real_agent_browsers_phone_frame_reaches_the_device`, and `playwright` `a_sessions_browser_launches_on_first_use_streams_frames_and_dies_with_the_session` and `over_an_ssh_bridge_the_browser_runs_on_the_host_and_its_frames_cross_the_link`.
- `server::tests::session_processes_measures_a_live_session_and_names_its_command`: `rss_bytes` is 0 ("a live process occupies memory").
- Once, in run 38536217513: `a_restart_that_waits_for_the_old_pid_does_not_race_the_lock`.

- [x] Reproduce the Linux job in Docker (`ubuntu:24.04`, non-root `runner`, the job's apt list) and capture the headless shell's own log for the CDP reset
- [x] Fix the headless-browser launch on Linux. A product fix if real Ubuntu users hit it too, not only a CI workaround
- [x] Fix the zero RSS reading for a just-started session on Linux
- [x] Check whether `a_restart_that_waits_for_the_old_pid_does_not_race_the_lock` is flaky, and fix it or record why
- [x] The whole Linux job passes in the container
- [ ] Push and see `ci.yml` green on `main`

## Findings

- **Browser: Chromium could not create its sandbox.** Ubuntu 23.10+ blocks unprivileged user namespaces for any binary without its own AppArmor profile. Playwright's downloaded headless shell has none, so it aborted with `FATAL ... No usable sandbox!` before listening, and the daemon's proxy closed the CDP connection. Real Ubuntu 24.04 users hit this too. Fix (`browser/launch.rs`): launch sandboxed first. Only after that exact abort, launch again with `--no-sandbox` and log a line saying so. Playwright itself defaults to `--no-sandbox`. Reproduced and fixed in `ubuntu:24.04`.
- **Session RSS read 0:** the test sampled the instant the session spawned. Just after exec, a process's RSS in `/proc/<pid>/stat` on Linux 6.2+ is a per-CPU counter read without its per-CPU deltas, so a barely-started process reads 0. It is intermittent: it first failed alone on 09-26 and passed in later runs. It never reproduced locally, even on 4 loaded CPUs. Fix: the test waits up to 10 s for the first non-zero sample. The product is unchanged, since 0 for one sample of a process that just started is the honest reading.
- **Restart race was a real bug in `pid_alive`:** on Linux it read a zombie thread-group LEADER as exited. While a multithreaded process exits, the leader turns `Z` first, and the process's files stay open until the last thread is gone. Shown in the container: a zombie leader with one live thread still held its `flock`. So a restart could spawn the new daemon while the old one still held the lock and its socket. In CI's case, `wait_listening` connected to the dying daemon's backlog before the new daemon had taken the lock. Fix (`protocol::daemon_lock`): a zombie leader is alive while any of its tasks is running. Proven on Linux with a C program whose leader calls `pthread_exit`.

**Container verification (2026-10-14):** a clean `ubuntu:24.04` container (`--init`, root pid 1, a real clone, the default target dir, browser deps installed) ran every step of the Linux job. All of them pass, including the four browser tests (playwright 5/5 runs). One container-only failure remains: on arm64, onnxruntime prints `Unknown CPU vendor`, which adds a line to `singleton`'s one-line stderr check. That line never appears on the x86_64 runner, where the test passes.
