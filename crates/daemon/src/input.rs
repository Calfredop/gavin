//! A session's input side: the bytes bound for the program in its pty,
//! written in order by a thread of the session's own.
//!
//! A write into a pty does not return until the program on the other end
//! has read enough of it. That is fine for a program reading its input
//! and very much not fine for one that has stopped: a macOS pty in raw
//! mode -- the mode every agent TUI runs in -- takes 1022 bytes from a
//! program that is not reading and then blocks (measured 2026-09-26). The
//! write used to happen on whatever thread asked for it, which was the
//! daemon's one thread for a CONNECTION: one paste into a wedged agent
//! parked the app's streaming connection, and every other terminal's
//! keystrokes, resizes and repaints waited behind it. "Send anyway" wrote
//! on the command connection's thread the same way, and it is the button
//! a human reaches for exactly when an agent looks stuck.
//!
//! So a caller hands the bytes over and is answered at once, and the one
//! thing a program that is not reading can hold up is its own input.
//!
//! A queue and a thread rather than non-blocking writes with a buffer:
//! the writer portable-pty hands out is a blocking `Write` on every
//! platform -- a dup of the master fd on unix, a pipe into the
//! pseudoconsole on Windows -- and a thread drives both the same way,
//! where a non-blocking one would be two implementations and a poll loop.
use std::collections::VecDeque;
use std::io::Write;
use std::sync::{Arc, Condvar, Mutex};

/// How much input may wait for one program before more is refused.
///
/// Bounded because nothing else bounds it any more: while the write
/// happened on the caller's thread, a program that did not read pushed
/// back on whoever was writing to it, and now it pushes back on nobody.
/// The daemon holds every session on the machine, so a script that kept
/// writing into a stuck one would otherwise grow it until the machine ran
/// out of memory. Sixteen of the largest requests the wire can carry
/// (`protocol::MAX_LINE_BYTES`) -- no human pastes that much into a
/// program that is not reading, and one that does is told, rather than
/// having it quietly held.
pub const MAX_PENDING_INPUT: usize = 16 * 1024 * 1024;

/// The handle every writer of one session's input shares. Cloning it is
/// cheap and every clone feeds the same queue, so input from anywhere --
/// the human typing, a queued follow-up, "send anyway" -- reaches the
/// program in the order it was handed over.
#[derive(Clone)]
pub struct InputQueue {
    shared: Arc<Shared>,
}

struct Shared {
    state: Mutex<State>,
    /// Signalled when there is input to write, or the queue has closed.
    ready: Condvar,
}

#[derive(Default)]
struct State {
    pending: VecDeque<Vec<u8>>,
    /// Bytes handed over and not yet written, the one being written
    /// included -- what `MAX_PENDING_INPUT` is measured against.
    pending_bytes: usize,
    /// Why the program stopped taking input, once a write has failed.
    /// Nothing further is accepted: the writer is gone, and input
    /// accepted after it would be input silently lost.
    failed: Option<String>,
    /// The session is gone; whatever is still waiting has nobody to go to.
    closed: bool,
}

impl InputQueue {
    /// Starts the writer thread for `writer`, which it owns from here on.
    pub fn spawn(writer: Box<dyn Write + Send>) -> InputQueue {
        let shared = Arc::new(Shared { state: Mutex::new(State::default()), ready: Condvar::new() });
        let worker = Arc::clone(&shared);
        std::thread::spawn(move || write_until_closed(&worker, writer));
        InputQueue { shared }
    }

    /// Hands `data` to the program, behind whatever is already waiting,
    /// and returns without waiting for any of it to be written.
    ///
    /// Refused only when the input could never arrive -- the writer has
    /// failed, or the session has gone -- or when this much is already
    /// waiting on a program that is not reading it.
    pub fn send(&self, data: &[u8]) -> anyhow::Result<()> {
        let mut state = self.shared.state.lock().unwrap();
        if let Some(why) = &state.failed {
            anyhow::bail!("this terminal has stopped taking input: {why}");
        }
        if state.closed {
            anyhow::bail!("this terminal has ended");
        }
        if state.pending_bytes + data.len() > MAX_PENDING_INPUT {
            anyhow::bail!(
                "the program in this terminal is not reading its input, and {} KB are already \
                 waiting for it — nothing more was sent",
                state.pending_bytes / 1024
            );
        }
        if data.is_empty() {
            return Ok(());
        }
        state.pending_bytes += data.len();
        state.pending.push_back(data.to_vec());
        self.shared.ready.notify_one();
        Ok(())
    }

    /// Drops whatever is still waiting and lets the writer thread end.
    ///
    /// A write already under way cannot be recalled: the thread finishes
    /// it, or fails it, when the program reads or goes -- a pty whose
    /// program has exited fails the write -- and ends then.
    pub fn close(&self) {
        let mut state = self.shared.state.lock().unwrap();
        state.closed = true;
        state.pending.clear();
        self.shared.ready.notify_one();
    }
}

fn write_until_closed(shared: &Shared, mut writer: Box<dyn Write + Send>) {
    loop {
        let chunk = {
            let mut state = shared.state.lock().unwrap();
            loop {
                if state.closed {
                    return;
                }
                if let Some(chunk) = state.pending.pop_front() {
                    break chunk;
                }
                state = shared.ready.wait(state).unwrap();
            }
        };
        // Outside the lock: this is the write that may not return for as
        // long as the program is not reading, and `send` must not wait
        // on it.
        let written = writer.write_all(&chunk).and_then(|()| writer.flush());
        let mut state = shared.state.lock().unwrap();
        state.pending_bytes -= chunk.len();
        if let Err(e) = written {
            eprintln!("a session's pty stopped taking input: {e}");
            state.failed = Some(e.to_string());
            state.pending.clear();
            state.pending_bytes = 0;
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    /// A `Write` that only takes a chunk when the test lets it: every
    /// write reports what it was given and then waits for a go-ahead, so
    /// a test can hold the "program" not reading for as long as it likes.
    struct GatedWriter {
        seen: mpsc::Sender<Vec<u8>>,
        go: mpsc::Receiver<std::io::Result<()>>,
    }

    impl Write for GatedWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let _ = self.seen.send(buf.to_vec());
            match self.go.recv() {
                Ok(Ok(())) => Ok(buf.len()),
                Ok(Err(e)) => Err(e),
                Err(_) => Err(std::io::Error::other("the test went away")),
            }
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn gated() -> (InputQueue, mpsc::Receiver<Vec<u8>>, mpsc::Sender<std::io::Result<()>>) {
        let (seen, writes) = mpsc::channel();
        let (release, go) = mpsc::channel();
        (InputQueue::spawn(Box::new(GatedWriter { seen, go })), writes, release)
    }

    const PROMPTLY: Duration = Duration::from_secs(5);

    #[test]
    fn a_send_returns_while_the_program_is_not_reading() {
        let (input, writes, release) = gated();
        input.send(b"first").unwrap();
        // The writer is now parked inside the first write...
        assert_eq!(writes.recv_timeout(PROMPTLY).unwrap(), b"first");
        // ...and a second send is answered all the same.
        input.send(b"second").unwrap();
        release.send(Ok(())).unwrap();
        assert_eq!(writes.recv_timeout(PROMPTLY).unwrap(), b"second");
        release.send(Ok(())).unwrap();
    }

    #[test]
    fn input_reaches_the_program_in_the_order_it_was_sent() {
        let (input, writes, release) = gated();
        for word in ["a", "b", "c", "d"] {
            input.send(word.as_bytes()).unwrap();
        }
        let mut got = Vec::new();
        for _ in 0..4 {
            got.push(String::from_utf8(writes.recv_timeout(PROMPTLY).unwrap()).unwrap());
            release.send(Ok(())).unwrap();
        }
        assert_eq!(got, ["a", "b", "c", "d"]);
    }

    #[test]
    fn more_than_the_cap_waiting_on_one_program_is_refused() {
        let (input, writes, release) = gated();
        input.send(&vec![b'x'; MAX_PENDING_INPUT - 1]).unwrap();
        writes.recv_timeout(PROMPTLY).unwrap();
        // The chunk being written still counts: the program has not read it.
        input.send(b"y").unwrap();
        let refused = input.send(b"z").unwrap_err().to_string();
        assert!(refused.contains("not reading"), "{refused}");
        // Once the program catches up, there is room again.
        release.send(Ok(())).unwrap();
        writes.recv_timeout(PROMPTLY).unwrap();
        release.send(Ok(())).unwrap();
        let deadline = std::time::Instant::now() + PROMPTLY;
        while input.send(b"z").is_err() {
            assert!(std::time::Instant::now() < deadline, "the queue never drained");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn a_failed_write_refuses_what_comes_after_it() {
        let (input, writes, release) = gated();
        input.send(b"doomed").unwrap();
        writes.recv_timeout(PROMPTLY).unwrap();
        release.send(Err(std::io::Error::other("input/output error"))).unwrap();
        let deadline = std::time::Instant::now() + PROMPTLY;
        let refused = loop {
            match input.send(b"after") {
                Err(e) => break e.to_string(),
                Ok(()) => {
                    assert!(std::time::Instant::now() < deadline, "the failure was never recorded");
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        };
        assert!(refused.contains("input/output error"), "{refused}");
    }

    #[test]
    fn closing_drops_what_was_still_waiting() {
        let (input, writes, release) = gated();
        input.send(b"under way").unwrap();
        writes.recv_timeout(PROMPTLY).unwrap();
        input.send(b"never written").unwrap();
        input.close();
        release.send(Ok(())).unwrap();
        assert!(
            writes.recv_timeout(Duration::from_millis(300)).is_err(),
            "input queued for a session that has gone was still written"
        );
        assert!(input.send(b"later").is_err(), "a closed queue took more input");
    }
}
