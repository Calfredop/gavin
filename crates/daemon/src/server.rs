use crate::protocol::{read_message, write_message, Request, Response, SessionSummary};
use crate::pty::PtySession;
use crate::registry::{Registry, SessionRecord, SessionStatus};
use std::collections::HashMap;
use std::io::BufReader;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

pub struct SessionManager {
    registry: Mutex<Registry>,
    sessions: Mutex<HashMap<String, PtySession>>,
}

impl SessionManager {
    pub fn new(registry: Registry) -> Self {
        Self {
            registry: Mutex::new(registry),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn create_session(
        &self,
        workspace_path: &str,
        cwd: &str,
        command: Option<&str>,
    ) -> anyhow::Result<String> {
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
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(id)
            .ok_or_else(|| anyhow::anyhow!("unknown session: {id}"))?;
        session.write_input(data)
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
        Request::ResizeSession { .. } => Ok(Response::Ok),
        Request::KillSession { id } => manager.kill_session(&id).map(|_| Response::Ok),
        Request::Attach { .. } => Ok(Response::Error {
            message: "Attach is not handled yet".to_string(),
        }),
    };

    result.unwrap_or_else(|e| Response::Error { message: e.to_string() })
}

pub fn run_server(socket_path: &std::path::Path, manager: Arc<SessionManager>) -> anyhow::Result<()> {
    if socket_path.exists() {
        std::fs::remove_file(socket_path)?;
    }
    let listener = UnixListener::bind(socket_path)?;

    for stream in listener.incoming() {
        let stream = stream?;
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
    let mut writer = stream.try_clone()?;
    let mut reader = BufReader::new(stream);

    loop {
        let req: Option<Request> = read_message(&mut reader)?;
        let req = match req {
            Some(r) => r,
            None => break,
        };
        let response = handle_request(&manager, req);
        write_message(&mut writer, &response)?;
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
}
