use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::Write;
use std::sync::{Arc, Mutex};

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn Child + Send + Sync>,
}

impl PtySession {
    /// `session_id` is the daemon's own id for this session. It rides into
    /// the PTY as `GAVIN_SESSION_ID` so anything running inside can name
    /// itself back to the app (gavin-mcp's `gavin_name_session` reads it,
    /// inheriting it through the agent that spawned it).
    ///
    /// `session_token`, when present, rides in beside it as
    /// `GAVIN_SESSION_TOKEN`: the per-session secret gavin-mcp presents in
    /// its `Hello` to take the `agent` role, scoped to this session's
    /// workspace and card (`sec-fix-client-identity.md`). `None` for a
    /// recovered bare shell -- it hosts no agent, so it needs no token,
    /// and the row's original hash (persisted) still covers an orphan that
    /// reconnects with the token it was launched with.
    pub fn spawn(
        cwd: &str,
        command: Option<&str>,
        session_id: &str,
        session_token: Option<&str>,
    ) -> anyhow::Result<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        // A supplied `command` is a shell command LINE, not a program path.
        // config.toml's `[agent].command` is documented as e.g.
        // "claude --model opus", and a card run appends the generated prompt
        // POSIX-single-quoted onto it ("claude 'Read ...'", see
        // app/src/lib/cardRun.ts). Handing that whole string to
        // CommandBuilder::new would make it one argv[0] and fail with
        // "doesn't exist on the filesystem and was not found in PATH".
        //
        // A POSIX shell rather than $SHELL deliberately: the quoting the app
        // emits is POSIX, so the parser has to be too -- a user whose login
        // shell is fish or nushell must not change how an app-generated
        // command line is read. `sh -c` with a single simple command execs it
        // in place, so the agent still owns the PTY (signals, job control,
        // exit status) with no extra process in between. Which sh, and the
        // Windows answer, is `shell`'s decision.
        let mut cmd = match command {
            Some(c) => {
                let mut cmd = CommandBuilder::new(crate::shell::posix_shell().as_os_str());
                cmd.args(["-c", c]);
                cmd
            }
            None => CommandBuilder::new(crate::shell::interactive_shell().as_os_str()),
        };
        cmd.cwd(cwd);
        // A daemon auto-spawned by the GUI (not launched from an interactive
        // terminal) inherits no TERM from its parent, which breaks every
        // full-screen TUI, including the AI coding agents this app hosts.
        //
        // Harmless on Windows, where ConPTY is the terminal and nothing
        // consults TERM to decide what it can draw -- but the MSYS
        // programs running inside sh.exe DO read it, and they are the
        // same programs that read it on a mac.
        cmd.env("TERM", "xterm-256color");

        // Pin the terminal identity instead of letting it leak in from
        // whatever launched the GUI. Tools choose how to signal "I need
        // you" from TERM_PROGRAM: Claude Code, for instance, rings a bare
        // BEL only under Apple_Terminal, sends OSC 9 under iTerm2, OSC 777
        // under ghostty, OSC 99 under kitty -- and sends NOTHING AT ALL
        // when TERM_PROGRAM is unset or unrecognized, which is exactly the
        // case when this app is launched from Finder rather than a
        // terminal. Leaving it inherited makes waiting-for-input detection
        // depend on how the app happened to be started. status.rs decodes
        // the resulting sequences.
        //
        // "ghostty" is chosen deliberately over the alternatives:
        //   - it emits a single, self-describing OSC 777 notification
        //     (kitty splits one notification across three OSC 99 chunks),
        //   - it does not affect color-depth detection, which consults
        //     TERM_PROGRAM_VERSION only for iTerm2 and Apple_Terminal,
        //   - claiming "Apple_Terminal" would make tools shell out to
        //     osascript to talk to a Terminal.app that isn't there,
        //   - and it is what this daemon already inherited in practice
        //     when launched from a terminal, so it is the best-tested
        //     value rather than a new untested identity.
        // Revisit if a hosted tool starts sending sequences xterm.js
        // cannot render (the kitty graphics protocol being the main risk).
        // Identity, not decoration: an agent running in here has no other
        // way to know which tab it occupies, and `gavin_name_session`
        // renames exactly the session this id names.
        cmd.env("GAVIN_SESSION_ID", session_id);
        if let Some(token) = session_token {
            cmd.env("GAVIN_SESSION_TOKEN", token);
        }
        cmd.env("TERM_PROGRAM", "ghostty");
        // An inherited version string from some *other* terminal would
        // contradict the pin above; drop it rather than invent one.
        cmd.env_remove("TERM_PROGRAM_VERSION");

        let child = pair.slave.spawn_command(cmd)?;
        let writer = pair.master.take_writer()?;

        Ok(Self {
            master: pair.master,
            writer: Arc::new(Mutex::new(writer)),
            child,
        })
    }

    pub fn reader(&self) -> anyhow::Result<Box<dyn std::io::Read + Send>> {
        Ok(self.master.try_clone_reader()?)
    }

    /// A clonable handle to the PTY's input side, so a caller can write to it
    /// without holding whatever lock guards the collection this session
    /// lives in (see SessionManager::write_input).
    pub fn writer_handle(&self) -> Arc<Mutex<Box<dyn Write + Send>>> {
        Arc::clone(&self.writer)
    }

    /// Direct write to this PTY. Callers holding a lock over a collection of
    /// sessions should use `writer_handle()` instead, so the blocking write
    /// happens after that lock is released (see SessionManager::write_input) —
    /// which leaves this method used only by this module's own tests.
    #[allow(dead_code)]
    pub fn write_input(&self, data: &[u8]) -> anyhow::Result<()> {
        self.writer.lock().unwrap().write_all(data)?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        self.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    /// A handle to the OS process in this PTY, for the registry to store
    /// so a LATER daemon can ask whether it is still there (see `proc`).
    ///
    /// Two ways to get `None`, and both mean the same thing to a caller:
    /// portable-pty declines to expose a pid, or the child had already
    /// exited by the time this was asked -- a command that fails to exec
    /// is gone in microseconds. Either way there is no process to
    /// remember, which is the correct thing to record.
    ///
    /// There is a theoretical window between `spawn` and this call in
    /// which the child could exit AND its pid be recycled, which would
    /// record a stranger's start time. Closing it would need the kernel
    /// to hand back pid and start time atomically at fork, which no API
    /// here offers; it needs the entire pid space to wrap inside a few
    /// microseconds, and the same uid to win the race.
    pub fn process_handle(&self) -> Option<crate::proc::ProcessHandle> {
        crate::proc::identify(self.child.process_id()?)
    }

    pub fn try_wait(&mut self) -> anyhow::Result<Option<i32>> {
        match self.child.try_wait()? {
            Some(status) => Ok(Some(status.exit_code() as i32)),
            None => Ok(None),
        }
    }

    pub fn kill(&mut self) -> anyhow::Result<()> {
        self.child.kill()?;
        Ok(())
    }

    /// Ends this session and hands the WAITING to a thread of its own.
    ///
    /// `kill` is not the cheap syscall its name suggests. portable-pty
    /// sends SIGHUP and then gives the process a grace period to act on
    /// it -- `try_wait` in five attempts, sleeping 50ms between them --
    /// before escalating to SIGKILL, and dropping the session pays that
    /// same loop a second time through `Drop`. Measured against this
    /// daemon: ~55ms per session when a client is draining the pty,
    /// ~430ms when nothing is, every millisecond of it on the connection
    /// thread that owes the caller a reply.
    ///
    /// That reply is what the app blocks on. Its `kill_session` is a
    /// synchronous Tauri command, so it runs on the thread that draws
    /// the window, and every close that ends more than one session --
    /// the task manager's batches, archiving a card with live agents,
    /// closing a page or a workspace -- issues them one after another.
    /// A page of eight tabs froze the window for half a second; a
    /// workspace could freeze it for several.
    ///
    /// So the signal goes out here, on the caller's thread, because it
    /// is only a `kill(2)` and the process must learn its terminal is
    /// gone NOW; everything that waits for it to act moves off. A thread
    /// per session rather than one shared reaper, deliberately: a queue
    /// would make each session's SIGKILL escalation and pty close wait
    /// out every grace period ahead of it, and the pty closing is what
    /// gives the pump its EOF -- which is the `session-exited` push a
    /// rail step's completion is read from. These threads live a few
    /// hundred milliseconds and are spawned only by an explicit close.
    ///
    /// Consuming `self` is the guarantee that nothing observes the gap:
    /// a retired session cannot be read, written or resized afterwards,
    /// so "the reply came back before the process died" is not a state
    /// any caller can reach.
    pub fn retire(self) {
        self.hangup();
        std::thread::spawn(move || {
            let mut session = self;
            // Escalates to SIGKILL once the grace period has passed, and
            // the drop that follows closes the pty master.
            let _ = session.kill();
        });
    }

    /// SIGHUP and return -- portable-pty's own signaller, which is the
    /// first half of `Child::kill` without the grace loop bolted onto
    /// it. Re-sending it from `kill` on the reaper thread is harmless:
    /// a process that already acted on the first one is gone, and one
    /// that ignored it ignores the second too.
    fn hangup(&self) {
        let _ = self.child.clone_killer().kill();
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // Best-effort: don't leave an orphaned/zombie child behind when a
        // session is dropped without an explicit kill() (e.g. create_session
        // failing after spawn, or a session replaced during recover()).
        let _ = self.child.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::time::{Duration, Instant};

    fn read_until_contains(
        reader: &mut dyn Read,
        needle: &str,
        timeout: Duration,
    ) -> String {
        let start = Instant::now();
        let mut collected = String::new();
        let mut buf = [0u8; 4096];
        while start.elapsed() < timeout {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    collected.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if collected.contains(needle) {
                        return collected;
                    }
                }
                Err(_) => break,
            }
        }
        collected
    }

    // `std::env::set_var` mutates the whole process's environment, which
    // every test in this binary shares -- cargo test runs tests on many
    // threads by default, so an unsynchronized set_var here could race a
    // concurrent std::env::var read anywhere else in the suite. Only the
    // two tests below touch real process env vars; they take this lock for
    // the duration of the mutation so they can't race *each other*, and
    // restore the var afterward so no polluted value leaks into any test
    // that runs later. This does not (and cannot, without a much larger
    // change) guard against every other concurrently-running test in the
    // binary -- accepted as a low-probability residual risk, same as any
    // other project's typical tolerance for this well-known Rust hazard.
    static ENV_MUTEX: Mutex<()> = Mutex::new(());

    #[test]
    fn spawn_pins_term_program_regardless_of_what_the_daemon_inherited() {
        // The daemon inherits its environment from whatever launched the
        // GUI, so without this pin a session's TERM_PROGRAM is "iTerm.app"
        // when started from iTerm, absent when started from Finder, and so
        // on. Tools pick their notification mechanism from this variable --
        // Claude Code emits OSC 777 under ghostty, OSC 9 under iTerm2, and
        // NOTHING AT ALL when it is unset -- so leaving it inherited makes
        // waiting-for-input detection silently depend on how the app was
        // launched. See status.rs for the detection side.
        let _guard = ENV_MUTEX.lock().unwrap();
        std::env::set_var("TERM_PROGRAM", "some-other-terminal");

        let mut session = PtySession::spawn("/tmp", Some("/bin/sh"), "test-session", None).unwrap();
        let mut reader = session.reader().unwrap();
        // The marker is assembled by printf at runtime, so the literal
        // needle below cannot appear in the shell's own echo of this
        // command -- otherwise the read would return on the echo and the
        // assertion would race the real output.
        session
            .write_input(b"printf 'TP%s=[%s]\\n' MARK \"$TERM_PROGRAM\"\n")
            .unwrap();

        let output = read_until_contains(&mut *reader, "TPMARK=[", Duration::from_secs(3));
        session.kill().unwrap();
        std::env::remove_var("TERM_PROGRAM");
        assert!(output.contains("TPMARK=[ghostty]"), "got: {output}");
    }

    #[test]
    fn spawn_clears_an_inherited_term_program_version() {
        // TERM_PROGRAM is pinned above, so a TERM_PROGRAM_VERSION left over
        // from a different terminal would be an incoherent pair. It is not
        // replaced with a fake version because the only thing that reads it
        // (color-depth detection) consults it solely for iTerm2 and
        // Apple_Terminal, neither of which we claim to be.
        let _guard = ENV_MUTEX.lock().unwrap();
        std::env::set_var("TERM_PROGRAM_VERSION", "9.9.9-inherited");

        let mut session = PtySession::spawn("/tmp", Some("/bin/sh"), "test-session", None).unwrap();
        let mut reader = session.reader().unwrap();
        session
            .write_input(b"printf 'TPV%s=[%s]\\n' MARK \"$TERM_PROGRAM_VERSION\"\n")
            .unwrap();

        let output = read_until_contains(&mut *reader, "TPVMARK=[", Duration::from_secs(3));
        session.kill().unwrap();
        std::env::remove_var("TERM_PROGRAM_VERSION");
        assert!(output.contains("TPVMARK=[]"), "got: {output}");
    }

    #[test]
    fn spawn_exports_the_session_id_into_the_pty() {
        // The only way anything running inside a session can name the tab
        // it occupies: gavin-mcp reads GAVIN_SESSION_ID (inherited through
        // the agent that spawned it) and hands it to gavin_name_session.
        let mut session = PtySession::spawn("/tmp", Some("/bin/sh"), "sid-42", None).unwrap();
        let mut reader = session.reader().unwrap();
        session
            .write_input(b"printf 'SID%s=[%s]\\n' MARK \"$GAVIN_SESSION_ID\"\n")
            .unwrap();

        let output = read_until_contains(&mut *reader, "SIDMARK=[", Duration::from_secs(3));
        session.kill().unwrap();
        assert!(output.contains("SIDMARK=[sid-42]"), "got: {output}");
    }

    #[test]
    fn spawns_shell_and_captures_output() {
        let mut session = PtySession::spawn("/tmp", Some("/bin/sh"), "test-session", None).unwrap();
        let mut reader = session.reader().unwrap();

        session.write_input(b"echo hello_pty_test\n").unwrap();

        let output = read_until_contains(&mut *reader, "hello_pty_test", Duration::from_secs(2));
        assert!(output.contains("hello_pty_test"), "got: {output}");

        session.kill().unwrap();
    }

    #[test]
    fn spawn_runs_a_command_line_not_a_bare_program_path() {
        // The launch command is a shell command LINE: config.toml's
        // `[agent].command` is documented as e.g. "claude --model opus",
        // and a card run appends a POSIX single-quoted prompt
        // ("claude 'Read ...'"). Handing that whole string to
        // CommandBuilder::new treats it as one argv[0] and fails with
        // "doesn't exist on the filesystem and was not found in PATH" --
        // the error the app surfaced as "Couldn't start the agent".
        let mut session = PtySession::spawn("/tmp", Some("/bin/echo 'ARGMARK=[one two]'"), "test-session", None).unwrap();
        let mut reader = session.reader().unwrap();

        let output = read_until_contains(&mut *reader, "ARGMARK=[", Duration::from_secs(3));
        session.kill().unwrap();
        assert!(output.contains("ARGMARK=[one two]"), "got: {output}");
    }

    #[test]
    fn spawn_honours_the_posix_quoting_the_app_generates() {
        // shellQuote (app/src/lib/cardRun.ts) closes and reopens the quote
        // around each embedded apostrophe -- '\'' -- which is what a card
        // run's prompt is full of ("keep the plan's status current"). The
        // parser on this side has to be POSIX for that to survive, which
        // is why the command goes to /bin/sh rather than to $SHELL.
        const CMD: &str = r"/bin/echo 'QMARK=[the plan'\''s]'";
        let mut session = PtySession::spawn("/tmp", Some(CMD), "test-session", None).unwrap();
        let mut reader = session.reader().unwrap();

        let output = read_until_contains(&mut *reader, "QMARK=[", Duration::from_secs(3));
        session.kill().unwrap();
        assert!(output.contains("QMARK=[the plan's]"), "got: {output}");
    }

    #[test]
    fn resize_does_not_error() {
        let session = PtySession::spawn("/tmp", Some("/bin/sh"), "test-session", None).unwrap();
        session.resize(100, 40).unwrap();
    }

    #[test]
    fn kill_causes_exit() {
        let mut session = PtySession::spawn("/tmp", Some("/bin/sh"), "test-session", None).unwrap();
        session.kill().unwrap();

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(_code) = session.try_wait().unwrap() {
                break;
            }
            assert!(Instant::now() < deadline, "process did not exit in time");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}
