---
order: 6144
title: [fix] cargo test -p app is nine red on Windows, in six unrelated ways
labels: windows
status: Done
priority: medium
complexity: medium
---
`cargo test -p app` on Windows 11 finishes **444 passed / 9 failed**, and
that count has been stable across every run since 2026-09-10. The
windows-port card recorded them as "all path-shape"; they are not — they
are seven different causes across six sections, and **none of them is a
live user-facing bug**: one is a latent defect in gavin, one belongs to
another card, one is a parallelism artifact, one is still unclassified,
and the rest are tests asserting the wrong shape. Diagnosed 2026-09-11 from
[feat-windows-port-on-a-windows-machine](./feat-windows-port-on-a-windows-machine.md)
§1. Nothing below is flaky: the same nine, every run.

Sorted by what has to change, not by test name.

## Closed 2026-09-22 — 501 passed / 0 failed

Stable over three consecutive full parallel runs. The other crates are
unmoved at their own baselines (`protocol` 3 red, the Linux `XDG`/`HOME`
tests; `gavin-mcp` 1 red, the path-separator assumption).

The nine had become eleven — B, C and E were one test each as described,
but A cost four `agent_setup` tests rather than one once Codex, Cursor
and Gemini grew skill files too, and D had already gone green on its own
when `.gitattributes` pinned the tree to LF.

Two corrections to the diagnosis below, so neither is re-derived from a
wrong premise.

**§A was a live user-facing bug, not a latent one**, and this card's
opening sentence is wrong to say none of them was. It named the wrong
surface: `workspace_delete::scan` already puts every path it reports
through `protocol::wire_path`, so the DELETE wizard was never showing a
mixed path. The one that was is the SETUP wizard's Integration step,
whose `agent_setup::IntegrationResult` stringified with
`to_string_lossy`. And it cost more than an ugly spelling there.
`IntegrationStep.svelte`'s `short()` trims a row down to a relative path
with `path.replace(ws.rootPath + "/", "")` — a forward slash, against a
`rootPath` the daemon has already wire-pathed (`gavin::scan_root`). A
backslash after the root never matched it, so on Windows **every row of
that list rendered as a full absolute path** instead of the relative one
the step is written to show. Fixed by normalising where the string is
made, which is what §A's item asked for.

**§G's premise was wrong too**, and usefully so: the error never came
from a read. See the classification in that section.

## A. gavin emits MIXED separators (latent, not a live bug)

`agent_setup::tests::an_opencode_root_gets_its_skills_agent_file_and_mcp_entry`
reports the files it wrote as

```
".opencode/skills/gavin\\SKILL.md"      ← expected ".opencode/skills/gavin/SKILL.md"
".opencode/agent\\gavin-commit.md"
```

The source is `ManagedFile { dir: ".opencode/skills/gavin", file: "SKILL.md" }`
(agent_setup.rs:799) joined as `root.join(file.dir).join(file.file)`
(agent_setup.rs:1093): a literal holding `/` with a `Path::join`ed
component behind it, so one string carries both separators.

**How far this actually goes, checked rather than assumed.** The second
test it costs —
`workspace_delete::tests::the_agent_file_is_trashed_when_the_plan_names_it`,
failing `".opencode/agent/gavin-commit.md" not reported by the scan —
nothing was removed for it` — looks at first like the delete wizard
silently skipping a file it promised to remove. **It is not.** In
production `buildPlan` fills `trash` from `footprint.agentFile` and
`footprint.skills` (workspaceDelete.ts:262–263), i.e. from the scan's own
output, so both sides of that intersection carry the same spelling and
agree. The test is the only thing that builds the path independently
(`dir.path().join(".opencode/agent/gavin-commit.md")`, all forward
slashes) and so the only thing that diverges.

So this is a **latent** hazard, not a live bug: the day any consumer
constructs one of these paths itself, or splits it on `/`, it silently
misses — which is the exact shape of the trap CLAUDE.md records about
card ids being compared and split as strings. It is also already visible,
in the wizard's own confirmation list: `Move to Trash:
C:\…\.opencode/agent\gavin-commit.md`.

- [x] Normalise to forward slashes where these relative paths are built,
      not at each comparison. `protocol::normalize_separators` already
      exists and is what the daemon boundary uses.
- [x] Then check every other producer of a relative path the UI or a plan
      compares — the join-behind-a-literal shape is what to grep for.

## B. Tests hand-write Windows paths into TOML

`fileviewer::tests::extra_context_roots_reads_registered_folders_and_skips_a_stale_one`
(expects one root, gets `[]`) and
`workspace_delete::tests::the_scan_finds_nested_contexts_and_marks_the_outside_ones`
(expects 1 outside context, gets 0) both build their fixture with

```rust
format!("name = \"ws\"\nextra_contexts = [\"{}\"]\n", path.display())
```

On Windows that is `extra_contexts = ["C:\Users\..."]`, and `\U` is not a
legal TOML escape — the whole file fails to parse, both functions return
empty by design, and the assertion reads like a lookup bug. **The product
is correct here**: `gavin::add_external_context` writes the array through
`toml_edit`, which escapes properly.

- [x] Build the fixture the way the product does rather than by
      `format!` — `toml::Value::String(..).to_string()` emits the escaped
      literal — so the test cannot drift from the writer again.

## C. A test expects `display()` where the product normalises

`workspace_delete::tests::the_scan_follows_the_profile_to_the_opencode_layout`

```
left:  "C:/Users/calfr/AppData/Local/Temp/.tmpQyVdgs/opencode.json"   ← what gavin returns
right: "C:\\Users\\calfr\\AppData\\Local\\Temp\\.tmpQyVdgs\\opencode.json" ← what the test wants
```

The product is doing the right thing and the expectation is the wrong
shape.

- [x] Expect the normalised spelling.

## D. CRLF in `include_str!`'d markdown

`agent_setup::tests::the_opencode_agent_file_carries_the_git_only_grant`
fails `must open with frontmatter` because
`app/src-tauri/src/opencode_commit_agent.md` is CRLF on disk (23 of 23
lines) and is compiled in verbatim, so the file gavin writes starts
`---\r\n`. **Owned by
[fix-source-grep-tests-on-crlf-checkouts](./fix-source-grep-tests-on-crlf-checkouts.md)**,
which now records the evidence and why only the `.gitattributes` option
reaches it. Nothing to do here.

## E. A unix-only assumption in a test that is not gated

`memory::tests::pid_file_sits_under_the_user_state_directory` calls
`watchman_pid_file().expect("USER and HOME are set in a test run")`. On
Windows neither is (`USERNAME` and `USERPROFILE` are), so it panics on
the `expect`. `watchman_pid_file`'s only non-test caller is
`#[cfg(target_os = "macos")] fn watchman_pid`, so the function is
unreachable off macOS — and the test also asserts `ends_with("-state/pid")`,
a forward slash a `PathBuf::join` never produces on Windows.

- [x] Gate the test (and the function) to where it is actually used.

## F. One parallelism artifact

`program::tests::a_command_child_does_not_share_this_console` fails in
the full parallel run and passes serially — it inspects
`GetConsoleProcessList` for the whole runner, which other tests' children
are also attached to. It is the 9th failure in a parallel run and absent
from a serial one, which is why the recorded baseline says "8 or 9".

- [x] Either make it not depend on what else is running, or mark it
      `#[serial]`-equivalent. Do not "fix" it by weakening the assertion:
      it is the guard against the console-flash bug coming back.

## G. A Windows named-pipe teardown that reports an error instead of EOF

`session::command_connection_tests::a_command_the_daemon_predates_never_reaches_the_wire`

```
panicked at session.rs:3064: Os { code: 232, kind: BrokenPipe,
                                 message: "The pipe is being closed." }
```

This one is **not** classified yet, and is the only one that might be a
real transport gap rather than a test. On unix a peer that closes gives
the reader a clean EOF; a Windows named pipe gives `ERROR_NO_DATA` (232)
on the closing side. If the fake daemon in this test is simply racing its
own shutdown, it is a test fix; if `transport`'s Windows arm reports an
error where the unix arm reports end-of-stream, every caller that treats
EOF as "the daemon went away" behaves differently on Windows.

**Classified 2026-09-22: the transport.** And not where this section
guessed — the 232 never came from a read at all. `session.rs:3320:42` is
`listener.accept().unwrap()`, so the failing call was **`accept`**. The
reads were already right: `read_ref` maps `ERROR_BROKEN_PIPE` and
`ERROR_PIPE_NOT_CONNECTED` to `Ok(0)`.

What happens is that the client connects, the compat gate declines to
send anything, and the client closes — all before the server thread
reaches `accept`. Windows then completes `ConnectNamedPipe` with
`ERROR_NO_DATA`, and `connect_instance` handled only
`ERROR_PIPE_CONNECTED`, so a hung-up client surfaced as a failed accept.
Unix `accept` hands back a good fd in exactly this case and lets the
first read report EOF, which is what every connection loop here is
written against. So on Windows alone, `run_server` logs a transport fault
for a client that merely had nothing to send — and every compat-gated
request takes that path by construction.

Proved before it was touched, with a transport-level repro that fails
with the same code 232 and needs no session machinery: bind, connect and
drop, then accept. Two earlier hypotheses were refuted first and are
worth not re-running — the 512-entry `GetConsoleProcessList`-style buffer
theory (n was 7), and "the read was in flight when the peer closed"
(passes either way).

- [x] Decide which it is before touching it, and if it is the transport,
      say so on the windows-port card — it would be the second structural
      finding of that pass.
      Fixed in `transport::connect_instance`, both on the synchronous
      return and on the overlapped completion, since which one carries it
      depends on how the client's close races the accept. Guarded by
      `transport::tests::a_client_that_hangs_up_before_accept_is_still_accepted`,
      which also asserts the accepted handle then reads `Ok(0)` — the
      unix shape end to end. Recorded on
      [feat-windows-port-on-a-windows-machine](./feat-windows-port-on-a-windows-machine.md)
      §1 as that pass's third structural finding.
