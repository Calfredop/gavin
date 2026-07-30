use protocol::{read_message, write_message, Request, Response, SessionSummary};
use crate::pty::PtySession;
use crate::registry::{Registry, SessionRecord, SessionStatus};
use std::collections::{HashMap, VecDeque};
use std::io::{BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

/// Cap on how much recent output is retained per session for replay to a
/// client that reattaches after missing it (e.g. app closed, daemon still
/// running). A rolling window, not a per-attach diff — every Attach replays
/// whatever's currently buffered, regardless of what a previous Attach saw.
const OUTPUT_BUFFER_CAP: usize = 64 * 1024;

pub struct SessionManager {
    registry: Mutex<Registry>,
    sessions: Mutex<HashMap<String, PtySession>>,
    attached_writers: Mutex<HashMap<String, Arc<Mutex<UnixStream>>>>,
    output_buffers: Mutex<HashMap<String, VecDeque<u8>>>,
}

impl SessionManager {
    pub fn new(registry: Registry) -> Self {
        Self {
            registry: Mutex::new(registry),
            sessions: Mutex::new(HashMap::new()),
            attached_writers: Mutex::new(HashMap::new()),
            output_buffers: Mutex::new(HashMap::new()),
        }
    }

    pub fn create_session(
        &self,
        workspace_path: &str,
        cwd: &str,
        command: Option<&str>,
    ) -> anyhow::Result<String> {
        if !std::path::Path::new(cwd).is_dir() {
            anyhow::bail!("cwd does not exist or is not a directory: {cwd}");
        }

        let id = Uuid::new_v4().to_string();
        let pty = PtySession::spawn(cwd, command)?;

        self.registry.lock().unwrap().insert(&SessionRecord {
            id: id.clone(),
            workspace_path: workspace_path.to_string(),
            cwd: cwd.to_string(),
            command: command.map(|c| c.to_string()),
            status: SessionStatus::Idle,
            restored: false,
        })?;

        self.sessions.lock().unwrap().insert(id.clone(), pty);
        Ok(id)
    }

    pub fn list_sessions(&self) -> anyhow::Result<Vec<SessionSummary>> {
        let records = self.registry.lock().unwrap().list()?;
        Ok(records
            .into_iter()
            .map(|r| SessionSummary {
                id: r.id,
                workspace_path: r.workspace_path,
                cwd: r.cwd,
                status: r.status.as_str().to_string(),
                restored: r.restored,
            })
            .collect())
    }

    pub fn write_input(&self, id: &str, data: &[u8]) -> anyhow::Result<()> {
        let writer = {
            let sessions = self.sessions.lock().unwrap();
            let session = sessions
                .get(id)
                .ok_or_else(|| anyhow::anyhow!("unknown session: {id}"))?;
            session.writer_handle()
        };
        writer.lock().unwrap().write_all(data)?;
        Ok(())
    }

    pub fn resize_session(&self, id: &str, cols: u16, rows: u16) -> anyhow::Result<()> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("unknown session: {id}"))?;
        session.resize(cols, rows)
    }

    pub fn kill_session(&self, id: &str) -> anyhow::Result<()> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(id) {
            session.kill()?;
        }
        self.registry.lock().unwrap().remove(id)?;
        sessions.remove(id);
        Ok(())
    }

    pub fn reader_for(&self, id: &str) -> anyhow::Result<Box<dyn std::io::Read + Send>> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("unknown session: {id}"))?;
        session.reader()
    }

    pub fn exit_code_for(&self, id: &str) -> anyhow::Result<Option<i32>> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(id)
            .ok_or_else(|| anyhow::anyhow!("unknown session: {id}"))?;
        session.try_wait()
    }

    pub fn recover(&self) -> anyhow::Result<()> {
        let records = self.registry.lock().unwrap().list()?;
        let mut sessions = self.sessions.lock().unwrap();
        for record in records {
            if record.status == SessionStatus::Exited {
                continue;
            }
            if !std::path::Path::new(&record.cwd).is_dir() {
                eprintln!(
                    "skipping recovery of session {} — cwd no longer exists: {}",
                    record.id, record.cwd
                );
                continue;
            }
            // A single bad leftover record (e.g. its command is no longer
            // executable) must not abort recovery of every session after it
            // in the list. Log and move on instead of propagating with `?`.
            match PtySession::spawn(&record.cwd, record.command.as_deref()) {
                Ok(pty) => {
                    sessions.insert(record.id.clone(), pty);
                    if let Err(e) = self.registry.lock().unwrap().mark_restored(&record.id) {
                        eprintln!("failed to mark session {} restored: {e}", record.id);
                    }
                }
                Err(e) => {
                    eprintln!(
                        "failed to recover session {} (cwd {}): {e}",
                        record.id, record.cwd
                    );
                }
            }
        }
        Ok(())
    }

    pub fn attach(self: &Arc<Self>, id: &str, writer: Arc<Mutex<UnixStream>>) {
        // Replay buffered output BEFORE registering the writer, so a
        // concurrently-running pump thread (this session may already be
        // attached elsewhere) can't interleave live output ahead of history.
        let buffered: Vec<u8> = {
            let buffers = self.output_buffers.lock().unwrap();
            buffers
                .get(id)
                .map(|b| b.iter().copied().collect())
                .unwrap_or_default()
        };
        if !buffered.is_empty() {
            let data = String::from_utf8_lossy(&buffered).into_owned();
            let _ = write_message(
                &mut *writer.lock().unwrap(),
                &Response::Output { id: id.to_string(), data },
            );
        }

        let already_running = {
            let mut writers = self.attached_writers.lock().unwrap();
            let existed = writers.contains_key(id);
            writers.insert(id.to_string(), writer);
            existed
        };
        if !already_running {
            self.spawn_pump(id.to_string());
        }
    }

    fn spawn_pump(self: &Arc<Self>, id: String) {
        let manager = Arc::clone(self);
        std::thread::spawn(move || {
            let mut reader = match manager.reader_for(&id) {
                Ok(r) => r,
                Err(e) => {
                    // Atomically take-and-remove in one lock acquisition. Getting the
                    // writer and removing the entry as two separate lock acquisitions
                    // would leave a window where a concurrent Attach for this same id
                    // registers a new writer in between — and this cleanup would then
                    // delete that fresh registration, stranding the new client with no
                    // pump thread ever spawned for it again. `.remove()` returns
                    // whatever is currently registered (possibly a writer from a
                    // concurrent Attach that raced in first), so the right writer
                    // always gets notified no matter how the race lands.
                    let removed = manager.attached_writers.lock().unwrap().remove(&id);
                    if let Some(w) = removed {
                        let _ = write_message(&mut *w.lock().unwrap(), &Response::Error { message: e.to_string() });
                    }
                    return;
                }
            };

            let mut buf = [0u8; 4096];
            // Bytes read but not yet forwarded because they end mid-way
            // through a multi-byte UTF-8 character — carried to the next
            // read instead of being lossily corrupted at the chunk boundary.
            let mut pending: Vec<u8> = Vec::new();

            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        // Scrollback buffer stores raw bytes — never affected by
                        // the UTF-8 chunking concern below, since it isn't decoded
                        // to a String until replay time (attach(), a rare event).
                        {
                            let mut buffers = manager.output_buffers.lock().unwrap();
                            let ring = buffers.entry(id.clone()).or_insert_with(VecDeque::new);
                            ring.extend(buf[..n].iter().copied());
                            while ring.len() > OUTPUT_BUFFER_CAP {
                                ring.pop_front();
                            }
                        }

                        pending.extend_from_slice(&buf[..n]);
                        let (consume_len, force_flush) = match std::str::from_utf8(&pending) {
                            Ok(_) => (pending.len(), false),
                            Err(e) => (e.valid_up_to(), e.error_len().is_some()),
                        };
                        if consume_len == 0 && !force_flush {
                            // Genuinely incomplete multi-byte sequence at the very
                            // end — wait for more bytes instead of corrupting it.
                            continue;
                        }
                        let take = if force_flush { pending.len() } else { consume_len };
                        let data = if force_flush {
                            // Not just incomplete — genuinely invalid bytes. Don't
                            // wait forever for a completion that will never come.
                            String::from_utf8_lossy(&pending[..take]).into_owned()
                        } else {
                            String::from_utf8(pending[..take].to_vec())
                                .expect("consume_len is a valid utf8 boundary")
                        };
                        pending.drain(..take);

                        // No writer currently attached, or a write to it failed
                        // (dead connection): drop this chunk from live forwarding
                        // and keep reading — it's already in the scrollback buffer
                        // above, so a future Attach will still see it.
                        let target = manager.attached_writers.lock().unwrap().get(&id).cloned();
                        if let Some(w) = target {
                            let _ = write_message(&mut *w.lock().unwrap(), &Response::Output { id: id.clone(), data });
                        }
                    }
                    Err(_) => break,
                }
            }

            let exit_code = manager.exit_code_for(&id).ok().flatten().unwrap_or(-1);
            if let Err(e) = manager.registry.lock().unwrap().update_status(&id, SessionStatus::Exited) {
                eprintln!("failed to persist exited status for session {id}: {e}");
            }
            // Same atomic take-and-remove as the error path above, and for the same
            // reason: a single `.remove()` call closes the race window a separate
            // get-then-remove would leave open.
            let removed = manager.attached_writers.lock().unwrap().remove(&id);
            if let Some(w) = removed {
                let _ = write_message(&mut *w.lock().unwrap(), &Response::SessionExited { id: id.clone(), exit_code });
            }
        });
    }
}

pub fn handle_request(manager: &SessionManager, req: Request) -> Response {
    let result = match req {
        Request::CreateSession { workspace_path, cwd, command } => manager
            .create_session(&workspace_path, &cwd, command.as_deref())
            .map(|id| Response::SessionCreated { id }),
        Request::ListSessions => manager
            .list_sessions()
            .map(|sessions| Response::SessionList { sessions }),
        Request::WriteInput { id, data } => manager
            .write_input(&id, data.as_bytes())
            .map(|_| Response::Ok),
        Request::ResizeSession { id, cols, rows } => manager
            .resize_session(&id, cols, rows)
            .map(|_| Response::Ok),
        Request::KillSession { id } => manager.kill_session(&id).map(|_| Response::Ok),
        Request::Attach { .. } => unreachable!("Attach is intercepted in handle_connection"),
    };

    result.unwrap_or_else(|e| Response::Error { message: e.to_string() })
}

pub fn run_server(socket_path: &std::path::Path, manager: Arc<SessionManager>) -> anyhow::Result<()> {
    if socket_path.exists() {
        if UnixStream::connect(socket_path).is_ok() {
            anyhow::bail!(
                "another gavin-daemon is already listening on {}",
                socket_path.display()
            );
        }
        std::fs::remove_file(socket_path)?;
    }
    let listener = UnixListener::bind(socket_path)?;
    std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o600))?;

    for stream in listener.incoming() {
        let stream = match stream {
            Ok(s) => s,
            Err(e) => {
                eprintln!("accept error: {e}");
                continue;
            }
        };
        let manager = Arc::clone(&manager);
        std::thread::spawn(move || {
            if let Err(e) = handle_connection(stream, manager) {
                eprintln!("connection error: {e}");
            }
        });
    }
    Ok(())
}

fn handle_connection(stream: UnixStream, manager: Arc<SessionManager>) -> anyhow::Result<()> {
    let writer = Arc::new(Mutex::new(stream.try_clone()?));
    let mut reader = BufReader::new(stream);

    loop {
        let req: Option<Request> = read_message(&mut reader)?;
        let req = match req {
            Some(r) => r,
            None => break,
        };

        if let Request::Attach { id } = req {
            manager.attach(&id, Arc::clone(&writer));
            continue;
        }

        let response = handle_request(&manager, req);
        write_message(&mut *writer.lock().unwrap(), &response)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn start_test_server() -> (std::path::PathBuf, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let socket_path = dir.path().join("daemon.sock");
        let db_path = dir.path().join("registry.sqlite");

        let registry = Registry::open(&db_path).unwrap();
        let manager = Arc::new(SessionManager::new(registry));

        let server_socket_path = socket_path.clone();
        std::thread::spawn(move || {
            run_server(&server_socket_path, manager).unwrap();
        });

        // Give the listener a moment to bind.
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while !socket_path.exists() {
            assert!(std::time::Instant::now() < deadline, "server never bound");
            std::thread::sleep(Duration::from_millis(20));
        }

        (socket_path, dir)
    }

    fn request(stream: &mut UnixStream, req: &Request) -> Response {
        write_message(stream, req).unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        read_message(&mut reader).unwrap().unwrap()
    }

    #[test]
    fn create_list_and_kill_session_over_socket() {
        let (socket_path, _dir) = start_test_server();
        let mut stream = UnixStream::connect(&socket_path).unwrap();

        let created = request(
            &mut stream,
            &Request::CreateSession {
                workspace_path: "/tmp/ws".to_string(),
                cwd: "/tmp".to_string(),
                command: Some("/bin/sh".to_string()),
            },
        );
        let id = match created {
            Response::SessionCreated { id } => id,
            other => panic!("expected SessionCreated, got {other:?}"),
        };

        let listed = request(&mut stream, &Request::ListSessions);
        match listed {
            Response::SessionList { sessions } => {
                assert_eq!(sessions.len(), 1);
                assert_eq!(sessions[0].id, id);
                assert_eq!(sessions[0].status, "idle");
                assert_eq!(sessions[0].restored, false);
            }
            other => panic!("expected SessionList, got {other:?}"),
        }

        let killed = request(&mut stream, &Request::KillSession { id: id.clone() });
        assert!(matches!(killed, Response::Ok));

        let listed_after = request(&mut stream, &Request::ListSessions);
        match listed_after {
            Response::SessionList { sessions } => assert_eq!(sessions.len(), 0),
            other => panic!("expected SessionList, got {other:?}"),
        }
    }

    #[test]
    fn write_input_to_unknown_session_returns_error() {
        let (socket_path, _dir) = start_test_server();
        let mut stream = UnixStream::connect(&socket_path).unwrap();

        let resp = request(
            &mut stream,
            &Request::WriteInput {
                id: "does-not-exist".to_string(),
                data: "echo hi\n".to_string(),
            },
        );
        assert!(matches!(resp, Response::Error { .. }));
    }

    #[test]
    fn attach_from_a_new_connection_streams_output_of_an_existing_session() {
        let (socket_path, _dir) = start_test_server();

        // Connection 1: create the session, then drop the connection
        // (simulating the GUI app closing).
        let id = {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        // Connection 2: attach to the same session and drive it.
        let mut stream2 = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
        write_message(
            &mut stream2,
            &Request::WriteInput {
                id: id.clone(),
                data: "echo attached_ok\n".to_string(),
            },
        )
        .unwrap();

        let mut reader = BufReader::new(stream2.try_clone().unwrap());
        let mut collected = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            let resp: Response = read_message(&mut reader).unwrap().unwrap();
            if let Response::Output { data, .. } = resp {
                collected.push_str(&data);
                if collected.contains("attached_ok") {
                    break;
                }
            }
            assert!(std::time::Instant::now() < deadline, "got: {collected}");
        }
    }

    #[test]
    fn reattaching_after_detach_delivers_output_to_the_new_connection_only() {
        let (socket_path, _dir) = start_test_server();

        let id = {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        // First attach, then drop the connection without the session exiting.
        {
            let mut stream2 = UnixStream::connect(&socket_path).unwrap();
            write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
            // Give the pump thread a moment to start before we drop the connection.
            std::thread::sleep(Duration::from_millis(100));
        }

        // Reattach from a third connection and drive the session — this must
        // not race with, or lose output to, the now-disconnected first pump.
        let mut stream3 = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream3, &Request::Attach { id: id.clone() }).unwrap();
        write_message(
            &mut stream3,
            &Request::WriteInput {
                id: id.clone(),
                data: "echo reattached_ok\n".to_string(),
            },
        )
        .unwrap();

        let mut reader = BufReader::new(stream3.try_clone().unwrap());
        let mut collected = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            let resp: Response = read_message(&mut reader).unwrap().unwrap();
            if let Response::Output { data, .. } = resp {
                collected.push_str(&data);
                if collected.contains("reattached_ok") {
                    break;
                }
            }
            assert!(std::time::Instant::now() < deadline, "got: {collected}");
        }
    }

    #[test]
    fn reattach_replays_buffered_output_produced_while_detached() {
        let (socket_path, _dir) = start_test_server();

        let id = {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let created = request(
                &mut stream,
                &Request::CreateSession {
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                },
            );
            match created {
                Response::SessionCreated { id } => id,
                other => panic!("expected SessionCreated, got {other:?}"),
            }
        };

        // First attach starts the pump (and the scrollback buffer), then detach.
        {
            let mut stream2 = UnixStream::connect(&socket_path).unwrap();
            write_message(&mut stream2, &Request::Attach { id: id.clone() }).unwrap();
            std::thread::sleep(Duration::from_millis(100));
        }

        // Produce output while nobody is attached; the pump is still running
        // and keeps appending to the scrollback buffer even with no writer.
        {
            let mut stream = UnixStream::connect(&socket_path).unwrap();
            let resp = request(
                &mut stream,
                &Request::WriteInput {
                    id: id.clone(),
                    data: "echo while_detached\n".to_string(),
                },
            );
            assert!(matches!(resp, Response::Ok));
        }
        std::thread::sleep(Duration::from_millis(300));

        // Reattach: the replay must include output produced while detached.
        let mut stream3 = UnixStream::connect(&socket_path).unwrap();
        write_message(&mut stream3, &Request::Attach { id: id.clone() }).unwrap();

        let mut reader = BufReader::new(stream3.try_clone().unwrap());
        let mut collected = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            let resp: Response = read_message(&mut reader).unwrap().unwrap();
            if let Response::Output { data, .. } = resp {
                collected.push_str(&data);
                if collected.contains("while_detached") {
                    break;
                }
            }
            assert!(std::time::Instant::now() < deadline, "got: {collected}");
        }
    }

    #[test]
    fn create_session_rejects_nonexistent_cwd() {
        let (socket_path, _dir) = start_test_server();
        let mut stream = UnixStream::connect(&socket_path).unwrap();

        let resp = request(
            &mut stream,
            &Request::CreateSession {
                workspace_path: "/tmp/ws".to_string(),
                cwd: "/tmp/definitely-does-not-exist-xyz".to_string(),
                command: Some("/bin/sh".to_string()),
            },
        );
        assert!(matches!(resp, Response::Error { .. }));
    }

    #[test]
    fn resize_session_returns_ok_for_existing_session() {
        let (socket_path, _dir) = start_test_server();
        let mut stream = UnixStream::connect(&socket_path).unwrap();

        let created = request(
            &mut stream,
            &Request::CreateSession {
                workspace_path: "/tmp/ws".to_string(),
                cwd: "/tmp".to_string(),
                command: Some("/bin/sh".to_string()),
            },
        );
        let id = match created {
            Response::SessionCreated { id } => id,
            other => panic!("expected SessionCreated, got {other:?}"),
        };

        let resp = request(&mut stream, &Request::ResizeSession { id, cols: 120, rows: 40 });
        assert!(matches!(resp, Response::Ok));
    }

    #[test]
    fn resize_session_returns_error_for_unknown_session() {
        let (socket_path, _dir) = start_test_server();
        let mut stream = UnixStream::connect(&socket_path).unwrap();

        let resp = request(
            &mut stream,
            &Request::ResizeSession { id: "does-not-exist".to_string(), cols: 80, rows: 24 },
        );
        assert!(matches!(resp, Response::Error { .. }));
    }

    #[test]
    fn recover_spawns_fresh_shells_for_leftover_registry_entries() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");

        // Simulate a previous daemon process: a registry entry exists,
        // but there is no live PTY for it (this new process just started).
        {
            let registry = Registry::open(&db_path).unwrap();
            registry
                .insert(&SessionRecord {
                    id: "leftover-1".to_string(),
                    workspace_path: "/tmp/ws".to_string(),
                    cwd: "/tmp".to_string(),
                    command: Some("/bin/sh".to_string()),
                    status: SessionStatus::Idle,
                    restored: false,
                })
                .unwrap();
        }

        let registry = Registry::open(&db_path).unwrap();
        let manager = SessionManager::new(registry);

        manager.recover().unwrap();

        let sessions = manager.list_sessions().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "leftover-1");
        assert_eq!(sessions[0].restored, true);

        // The recovered session must have a real, live PTY behind it.
        manager
            .write_input("leftover-1", b"echo recovered_ok\n")
            .unwrap();
        let mut reader = manager.reader_for("leftover-1").unwrap();

        let mut collected = String::new();
        let mut buf = [0u8; 4096];
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !collected.contains("recovered_ok") {
            let n = reader.read(&mut buf).unwrap();
            collected.push_str(&String::from_utf8_lossy(&buf[..n]));
            assert!(std::time::Instant::now() < deadline, "got: {collected}");
        }
    }
}
