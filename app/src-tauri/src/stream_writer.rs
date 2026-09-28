//! The sending half of a streaming daemon connection -- the local one and
//! each ssh link's -- owned by one writer thread and fed through a FIFO.
//!
//! Keystrokes, resizes, repaints and attaches travel this way, and the
//! commands that send them are plain `fn`s: Tauri runs those on the main
//! thread, and they stay there on purpose (see below). While the send
//! was a write under a `Mutex<Stream>`, a daemon that stopped reading the
//! connection stopped the window with it -- and the daemon DID stop, for
//! as long as any one session's program was not reading its input. The
//! daemon writes each session's input on a thread of its own now, but a
//! wedged daemon, a slow ssh host or a peer that is simply behind can
//! still let the socket's send buffer fill (8 KB for AF_UNIX on macOS,
//! measured), and after that every write blocks until it drains.
//!
//! So a send serializes the request, appends it to an unbounded queue and
//! returns, and the writer thread is the only thing that ever waits on
//! the socket. Order is the queue's, which is the order the commands ran
//! -- and that order is load-bearing: characters of one burst of typing
//! must arrive as typed, and `TerminalPane.svelte` asks for a snapshot
//! once its resize has resolved, counting on the daemon repainting at the
//! new size. That is why the commands are not `async` over
//! `spawn_blocking` instead: the blocking pool runs its tasks on whichever
//! thread is free, and two keystrokes a millisecond apart would race each
//! other to the socket.
//!
//! What a sender gives up is hearing about a failed write. The relay
//! thread reading the other half learns of a dead connection on its own
//! and says so (`RelayOwner::lost`); from the first failed write on, this
//! refuses new sends with that failure, until `replace` puts a fresh
//! connection in.
use serde::Serialize;
use std::collections::VecDeque;
use std::io::Write;
use std::sync::{Arc, Condvar, Mutex};

/// A clonable handle to one streaming connection's writer thread. Every
/// clone feeds the same queue; the thread ends once the last clone is
/// dropped and what was already queued has been written.
#[derive(Clone)]
pub struct StreamWriter {
    handle: Arc<Handle>,
}

/// What the clones share. Its `Drop` is how the thread learns nobody can
/// send any more.
struct Handle {
    shared: Arc<Shared>,
}

struct Shared {
    state: Mutex<State>,
    /// Signalled when there is something to write, or nobody left to send.
    ready: Condvar,
}

enum Item {
    Line(Vec<u8>),
    /// Everything queued after this goes to the new connection.
    Swap(Box<dyn Write + Send>, u64),
}

#[derive(Default)]
struct State {
    queue: VecDeque<Item>,
    /// Which connection the latest `replace` put in. A write failure is
    /// recorded only against the connection that is still current, so an
    /// old one dying after the swap cannot refuse sends meant for the new.
    generation: u64,
    /// Why the current connection stopped taking writes, once it has.
    failed: Option<String>,
    closed: bool,
}

impl StreamWriter {
    /// Starts the writer thread for `stream`, which it owns from here on.
    pub fn spawn(stream: impl Write + Send + 'static) -> StreamWriter {
        let shared = Arc::new(Shared { state: Mutex::new(State::default()), ready: Condvar::new() });
        let worker = Arc::clone(&shared);
        let stream: Box<dyn Write + Send> = Box::new(stream);
        std::thread::Builder::new()
            .name("daemon-stream-writer".to_string())
            .spawn(move || write_until_closed(&worker, stream))
            .expect("could not start the daemon stream writer thread");
        StreamWriter { handle: Arc::new(Handle { shared }) }
    }

    /// Queues `msg` as one protocol line, behind everything already
    /// queued, and returns without waiting for any of it to be written.
    pub fn send<T: Serialize>(&self, msg: &T) -> anyhow::Result<()> {
        let mut line = serde_json::to_vec(msg)?;
        line.push(b'\n');
        let shared = &self.handle.shared;
        let mut state = shared.state.lock().unwrap();
        if let Some(why) = &state.failed {
            anyhow::bail!("the daemon connection is gone: {why}");
        }
        state.queue.push_back(Item::Line(line));
        shared.ready.notify_one();
        Ok(())
    }

    /// Points everything sent from now on at `stream` -- a reconnect's
    /// fresh connection. Lines queued before this still go to the old one,
    /// which is where they were addressed.
    pub fn replace(&self, stream: impl Write + Send + 'static) {
        let shared = &self.handle.shared;
        let mut state = shared.state.lock().unwrap();
        state.generation += 1;
        state.failed = None;
        let generation = state.generation;
        state.queue.push_back(Item::Swap(Box::new(stream), generation));
        shared.ready.notify_one();
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        self.shared.state.lock().unwrap().closed = true;
        self.shared.ready.notify_one();
    }
}

fn write_until_closed(shared: &Shared, mut stream: Box<dyn Write + Send>) {
    let mut generation = 0;
    // Set once a write to `stream` fails: what is still queued for it is
    // dropped rather than tried, until a swap brings a working one.
    let mut broken = false;
    loop {
        let item = {
            let mut state = shared.state.lock().unwrap();
            loop {
                if let Some(item) = state.queue.pop_front() {
                    break item;
                }
                if state.closed {
                    return;
                }
                state = shared.ready.wait(state).unwrap();
            }
        };
        match item {
            Item::Swap(fresh, to) => {
                stream = fresh;
                generation = to;
                broken = false;
            }
            Item::Line(_) if broken => {}
            // Outside the lock: this is the write that may not return for
            // as long as the peer is not reading, and `send` must not
            // wait on it.
            Item::Line(line) => {
                if let Err(e) = stream.write_all(&line).and_then(|()| stream.flush()) {
                    broken = true;
                    let mut state = shared.state.lock().unwrap();
                    if state.generation == generation {
                        state.failed = Some(e.to_string());
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::transport::Stream;
    use protocol::{read_message, Request};
    use std::io::BufReader;
    use std::time::{Duration, Instant};

    const PROMPTLY: Duration = Duration::from_secs(5);

    fn input(id: &str, data: &str) -> Request {
        Request::WriteInput { id: id.to_string(), data: data.to_string() }
    }

    /// Reads `n` requests off `stream`, failing the test instead of
    /// hanging it if they never come.
    fn read_requests(stream: Stream, n: usize) -> Vec<Request> {
        stream.set_read_timeout(Some(PROMPTLY)).unwrap();
        let mut reader = BufReader::new(stream);
        (0..n).map(|_| read_message(&mut reader).unwrap().expect("the connection ended early")).collect()
    }

    /// The verdict every send in these tests is gated against: a daemon
    /// at this build's own version, which refuses nothing.
    fn parity() -> crate::session::DaemonCompat {
        crate::session::DaemonCompat {
            daemon_version: protocol::PROTOCOL_VERSION,
            app_version: protocol::PROTOCOL_VERSION,
            degraded: false,
        }
    }

    /// The bug: a peer that stopped reading let the socket's buffer fill,
    /// and from then on every send -- on the main thread -- waited for it.
    /// Through `send_request`, the door every streaming command uses.
    #[test]
    fn send_request_returns_while_the_peer_is_not_reading() {
        let (app_side, daemon_side) = Stream::pair().unwrap();
        let writer = StreamWriter::spawn(app_side);
        // Far more than any socket buffer holds, with nobody reading. On
        // a thread, so a send that blocks fails the wait below instead of
        // hanging the suite.
        let (done, finished) = std::sync::mpsc::channel();
        let sender = writer.clone();
        std::thread::spawn(move || {
            let paste = "x".repeat(64 * 1024);
            for _ in 0..32 {
                crate::session::send_request(&sender, &input("a", &paste), &parity()).unwrap();
            }
            let resize = Request::ResizeSession { id: "b".into(), cols: 80, rows: 24 };
            crate::session::send_request(&sender, &resize, &parity()).unwrap();
            crate::session::send_request(&sender, &Request::Snapshot { id: "b".into() }, &parity()).unwrap();
            let _ = done.send(());
        });
        finished.recv_timeout(PROMPTLY).expect("sending waited on a peer that was not reading");

        // And none of it was lost or reordered once the peer caught up --
        // the resize still ahead of the snapshot that counts on it.
        let got = read_requests(daemon_side, 34);
        assert!(got[..32].iter().all(|r| matches!(r, Request::WriteInput { id, .. } if id == "a")));
        assert!(matches!(&got[32], Request::ResizeSession { id, .. } if id == "b"));
        assert!(matches!(&got[33], Request::Snapshot { id } if id == "b"));
    }

    #[test]
    fn requests_arrive_in_the_order_they_were_sent() {
        let (app_side, daemon_side) = Stream::pair().unwrap();
        let writer = StreamWriter::spawn(app_side);
        let typed: Vec<String> = (0..200).map(|i| i.to_string()).collect();
        for key in &typed {
            crate::session::send_request(&writer, &input("a", key), &parity()).unwrap();
        }
        let got: Vec<String> = read_requests(daemon_side, typed.len())
            .into_iter()
            .map(|r| match r {
                Request::WriteInput { data, .. } => data,
                other => panic!("expected WriteInput, got {other:?}"),
            })
            .collect();
        assert_eq!(got, typed);
    }

    /// A reconnect's writes go to the new daemon, and a send made after a
    /// write to the old one failed is taken again once the new one is in.
    #[test]
    fn a_replaced_connection_takes_everything_sent_after_the_swap() {
        let (old_app_side, old_daemon_side) = Stream::pair().unwrap();
        let writer = StreamWriter::spawn(old_app_side);
        // The old daemon goes away; the next write to it fails.
        drop(old_daemon_side);
        let deadline = Instant::now() + PROMPTLY;
        let refused = loop {
            match writer.send(&input("a", "lost")) {
                Err(e) => break e.to_string(),
                Ok(()) => {
                    assert!(Instant::now() < deadline, "a dead connection kept taking sends");
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        };
        assert!(refused.contains("gone"), "{refused}");

        let (new_app_side, new_daemon_side) = Stream::pair().unwrap();
        writer.replace(new_app_side);
        writer.send(&Request::Attach { id: "a".into() }).unwrap();
        let got = read_requests(new_daemon_side, 1);
        assert!(matches!(&got[0], Request::Attach { id } if id == "a"), "{got:?}");
    }

    /// What was queued before the last handle went is still written: the
    /// thread drains, then ends, and the peer then reads end of stream.
    #[test]
    fn dropping_the_last_handle_writes_what_was_queued_and_then_ends() {
        let (app_side, daemon_side) = Stream::pair().unwrap();
        // Before the drop: macOS refuses the option, EINVAL, on a socket
        // whose peer has already closed.
        daemon_side.set_read_timeout(Some(PROMPTLY)).unwrap();
        let writer = StreamWriter::spawn(app_side);
        writer.send(&input("a", "last words")).unwrap();
        drop(writer);
        let mut reader = BufReader::new(daemon_side);
        let got: Option<Request> = read_message(&mut reader).unwrap();
        assert!(matches!(got, Some(Request::WriteInput { data, .. }) if data == "last words"));
        let end: Option<Request> = read_message(&mut reader).unwrap();
        assert!(end.is_none(), "the writer thread kept the connection open");
    }
}
