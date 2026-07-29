use serde::{Deserialize, Serialize};
use std::io::{BufRead, Write};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Request {
    CreateSession {
        workspace_path: String,
        cwd: String,
        command: Option<String>,
    },
    ListSessions,
    WriteInput {
        id: String,
        data: String,
    },
    ResizeSession {
        id: String,
        cols: u16,
        rows: u16,
    },
    KillSession {
        id: String,
    },
    Attach {
        id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Response {
    SessionCreated { id: String },
    SessionList { sessions: Vec<SessionSummary> },
    Output { id: String, data: String },
    SessionExited { id: String, exit_code: i32 },
    Ok,
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionSummary {
    pub id: String,
    pub workspace_path: String,
    pub cwd: String,
    pub status: String,
    pub restored: bool,
}

pub fn write_message<W: Write, T: Serialize>(writer: &mut W, msg: &T) -> anyhow::Result<()> {
    let line = serde_json::to_string(msg)?;
    writer.write_all(line.as_bytes())?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

pub fn read_message<R: BufRead, T: for<'de> Deserialize<'de>>(
    reader: &mut R,
) -> anyhow::Result<Option<T>> {
    let mut line = String::new();
    let bytes_read = reader.read_line(&mut line)?;
    if bytes_read == 0 {
        return Ok(None);
    }
    let msg = serde_json::from_str(line.trim_end())?;
    Ok(Some(msg))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn request_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let req = Request::CreateSession {
            workspace_path: "/tmp/ws".to_string(),
            cwd: "/tmp/ws".to_string(),
            command: None,
        };
        write_message(&mut buf, &req).unwrap();

        let mut cursor = Cursor::new(buf);
        let decoded: Request = read_message(&mut cursor).unwrap().unwrap();

        match decoded {
            Request::CreateSession { workspace_path, cwd, command } => {
                assert_eq!(workspace_path, "/tmp/ws");
                assert_eq!(cwd, "/tmp/ws");
                assert_eq!(command, None);
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn response_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let resp = Response::Output {
            id: "s1".to_string(),
            data: "hello\n".to_string(),
        };
        write_message(&mut buf, &resp).unwrap();

        let mut cursor = Cursor::new(buf);
        let decoded: Response = read_message(&mut cursor).unwrap().unwrap();

        match decoded {
            Response::Output { id, data } => {
                assert_eq!(id, "s1");
                assert_eq!(data, "hello\n");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn read_message_returns_none_at_eof() {
        let mut cursor = Cursor::new(Vec::<u8>::new());
        let decoded: Option<Request> = read_message(&mut cursor).unwrap();
        assert!(decoded.is_none());
    }

    #[test]
    fn two_messages_on_same_stream_read_independently() {
        let mut buf = Vec::new();
        write_message(&mut buf, &Request::ListSessions).unwrap();
        write_message(&mut buf, &Request::KillSession { id: "s1".to_string() }).unwrap();

        let mut cursor = Cursor::new(buf);
        let first: Request = read_message(&mut cursor).unwrap().unwrap();
        let second: Request = read_message(&mut cursor).unwrap().unwrap();

        assert!(matches!(first, Request::ListSessions));
        assert!(matches!(second, Request::KillSession { .. }));
    }
}
