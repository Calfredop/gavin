//! Blocking websockets split into a read half and a write half, for the
//! two places the browser module speaks CDP: the proxy, which copies both
//! ways at once, and the screencaster, which reads events on one thread
//! while another sends commands.
//!
//! `tungstenite`'s `WebSocket` is one object that both reads and writes,
//! and its `read` writes too: it answers a ping and a close on its own.
//! Two objects over clones of one socket would then interleave those
//! replies with the other half's frames. So the read half reads through
//! [`ReadHalf`], whose writes go nowhere once the handshake is done, and
//! the code that owns both halves forwards a ping or a close to whoever
//! should answer it. The handshake itself runs on the read half, so any
//! bytes the peer sent right behind it stay in that half's buffer.

use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tungstenite::protocol::{Role, WebSocketConfig};
use tungstenite::WebSocket;

/// What both ends accept: Playwright's own 256 MiB ceiling, in frames of
/// any size. A full-page screenshot of a long article crosses as one
/// message, and the spike carried one through.
pub fn config() -> WebSocketConfig {
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(256 << 20);
    config.max_frame_size = None;
    config
}

/// A socket that writes only until [`ReadHalf::stop_writing`].
pub struct ReadHalf {
    tcp: TcpStream,
    writes: Arc<AtomicBool>,
}

impl ReadHalf {
    fn new(tcp: TcpStream) -> Self {
        Self { tcp, writes: Arc::new(AtomicBool::new(true)) }
    }

    fn stop_writing(&self) {
        self.writes.store(false, Ordering::SeqCst);
    }
}

impl Read for ReadHalf {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.tcp.read(buf)
    }
}

impl Write for ReadHalf {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.writes.load(Ordering::SeqCst) {
            self.tcp.write(buf)
        } else {
            Ok(buf.len())
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        if self.writes.load(Ordering::SeqCst) {
            self.tcp.flush()
        } else {
            Ok(())
        }
    }
}

/// One websocket as two halves, plus a socket to shut it with from any
/// thread -- which is how a blocked read on the other half is ended.
pub struct Split {
    pub read: WebSocket<ReadHalf>,
    pub write: WebSocket<TcpStream>,
    pub shut: TcpStream,
}

impl Split {
    fn from_handshake(read: WebSocket<ReadHalf>, role: Role) -> std::io::Result<Self> {
        read.get_ref().stop_writing();
        let tcp = &read.get_ref().tcp;
        let write = WebSocket::from_raw_socket(tcp.try_clone()?, role, Some(config()));
        let shut = tcp.try_clone()?;
        Ok(Self { read, write, shut })
    }
}

/// Ends a split websocket's socket in both directions; both halves'
/// next read or write fails.
pub fn shut(tcp: &TcpStream) {
    let _ = tcp.shutdown(Shutdown::Both);
}

/// Accepts a websocket on `tcp` when `admit` says yes to the request
/// path, and answers 404 otherwise. Returns what `admit` returned.
pub fn accept<T>(tcp: TcpStream, admit: impl FnOnce(&str) -> Option<T>) -> anyhow::Result<(Split, T)> {
    tcp.set_nodelay(true).ok();
    let mut admitted = None;
    let callback = |req: &tungstenite::handshake::server::Request,
                    resp: tungstenite::handshake::server::Response| {
        match admit(req.uri().path()) {
            Some(found) => {
                admitted = Some(found);
                Ok(resp)
            }
            None => {
                let mut refusal = tungstenite::handshake::server::ErrorResponse::new(None);
                *refusal.status_mut() = tungstenite::http::StatusCode::NOT_FOUND;
                Err(refusal)
            }
        }
    };
    let read = tungstenite::accept_hdr_with_config(ReadHalf::new(tcp), callback, Some(config()))
        .map_err(|e| anyhow::anyhow!("websocket handshake: {e}"))?;
    let admitted = admitted.ok_or_else(|| anyhow::anyhow!("websocket handshake admitted nothing"))?;
    Ok((Split::from_handshake(read, Role::Server)?, admitted))
}

/// Dials `url`, a `ws://127.0.0.1:<port>/…` the browser itself wrote.
pub fn connect(url: &str, timeout: Duration) -> anyhow::Result<Split> {
    let authority = url
        .strip_prefix("ws://")
        .and_then(|rest| rest.split('/').next())
        .ok_or_else(|| anyhow::anyhow!("not a ws:// url: {url}"))?;
    let addr: std::net::SocketAddr = authority
        .parse()
        .map_err(|_| anyhow::anyhow!("not a loopback ip:port: {authority}"))?;
    let tcp = TcpStream::connect_timeout(&addr, timeout)?;
    tcp.set_nodelay(true).ok();
    let (read, _) = tungstenite::client::client_with_config(url, ReadHalf::new(tcp), Some(config()))
        .map_err(|e| anyhow::anyhow!("websocket handshake with {url}: {e}"))?;
    Ok(Split::from_handshake(read, Role::Client)?)
}
