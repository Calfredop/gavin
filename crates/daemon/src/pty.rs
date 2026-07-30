use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::Write;
use std::sync::{Arc, Mutex};

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Box<dyn Child + Send + Sync>,
}

impl PtySession {
    pub fn spawn(cwd: &str, command: Option<&str>) -> anyhow::Result<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let shell = command
            .map(|c| c.to_string())
            .unwrap_or_else(|| std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string()));
        let mut cmd = CommandBuilder::new(shell);
        cmd.cwd(cwd);
        // A daemon auto-spawned by the GUI (not launched from an interactive
        // terminal) inherits no TERM from its parent, which breaks every
        // full-screen TUI, including the AI coding agents this app hosts.
        cmd.env("TERM", "xterm-256color");

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

    #[test]
    fn spawns_shell_and_captures_output() {
        let mut session = PtySession::spawn("/tmp", Some("/bin/sh")).unwrap();
        let mut reader = session.reader().unwrap();

        session.write_input(b"echo hello_pty_test\n").unwrap();

        let output = read_until_contains(&mut *reader, "hello_pty_test", Duration::from_secs(2));
        assert!(output.contains("hello_pty_test"), "got: {output}");

        session.kill().unwrap();
    }

    #[test]
    fn resize_does_not_error() {
        let session = PtySession::spawn("/tmp", Some("/bin/sh")).unwrap();
        session.resize(100, 40).unwrap();
    }

    #[test]
    fn kill_causes_exit() {
        let mut session = PtySession::spawn("/tmp", Some("/bin/sh")).unwrap();
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
