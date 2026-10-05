//! Dialling a Relay: a blocking WebSocket, over TLS unless the Relay is
//! on this machine or this network.
//!
//! Shared by the daemon and the test Device, which is the reason it is
//! here and not in either: they are the two ends of one pipe, and the
//! part of each that opens a socket to the Relay is the same part.
//!
//! **Blocking, on purpose.** The daemon is threads and blocking I/O. A
//! pairing stream is strict alternation -- read a message, write one --
//! so `RelayStream` is `Read + Write` over one socket on one thread, which
//! is exactly what the daemon's `pair_over` asks for.

use protocol::relay::{
    RefusalReason, RelayHello, RelayReply, RelayUrl, RelayUrlError, MAX_STREAM_MESSAGE_BYTES,
};
use rustls::pki_types::{CertificateDer, ServerName};
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tungstenite::protocol::WebSocketConfig;
use tungstenite::{Message, WebSocket};

/// How a dial is bounded.
#[derive(Debug, Clone)]
pub struct DialOptions {
    /// How long opening the socket may take, per address tried.
    pub connect_timeout: Duration,
    /// How long the TLS and WebSocket handshakes and the Relay's first
    /// reply may take together. For a Device this covers the wait for a
    /// Workstation to pick the stream up.
    pub hello_timeout: Duration,
    /// Certificates trusted IN ADDITION to the platform's, as DER. Empty
    /// for the daemon, which trusts what the machine trusts; the test
    /// Device names the certificate of the Relay its test just started.
    pub extra_roots: Vec<Vec<u8>>,
}

impl Default for DialOptions {
    fn default() -> Self {
        Self {
            connect_timeout: Duration::from_secs(10),
            hello_timeout: Duration::from_secs(20),
            extra_roots: Vec::new(),
        }
    }
}

/// Why a dial did not produce a connection.
#[derive(Debug)]
pub enum DialError {
    /// The URL may not be dialled.
    Url(RelayUrlError),
    /// No socket: the host did not resolve, or nothing answered.
    Connect(io::Error),
    /// The Relay's certificate was not one this machine trusts.
    Tls(String),
    /// The peer is not a Relay, or stopped being one.
    Protocol(String),
    /// The Relay answered, and the answer was no.
    Refused(RefusalReason),
    /// The Relay hung up without a word.
    Closed,
    /// Nothing arrived in time.
    TimedOut,
}

impl std::fmt::Display for DialError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DialError::Url(e) => write!(f, "{e}"),
            DialError::Connect(e) => write!(f, "could not reach the Relay: {e}"),
            DialError::Tls(e) => write!(f, "could not secure the connection to the Relay: {e}"),
            DialError::Protocol(e) => write!(f, "the Relay did not speak as a Relay does: {e}"),
            DialError::Refused(reason) => write!(f, "{reason}"),
            DialError::Closed => write!(f, "the Relay closed the connection"),
            DialError::TimedOut => write!(f, "the Relay did not answer in time"),
        }
    }
}

impl std::error::Error for DialError {}

/// The socket under the WebSocket: plain to a Relay on this network, TLS
/// to any other.
pub enum Transport {
    Plain(TcpStream),
    Tls(Box<rustls::StreamOwned<rustls::ClientConnection, TcpStream>>),
}

impl Read for Transport {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            Transport::Plain(s) => s.read(buf),
            Transport::Tls(s) => s.read(buf),
        }
    }
}

impl Write for Transport {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            Transport::Plain(s) => s.write(buf),
            Transport::Tls(s) => s.write(buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Transport::Plain(s) => s.flush(),
            Transport::Tls(s) => s.flush(),
        }
    }
}

fn is_timeout(e: &io::Error) -> bool {
    // A socket read that ran out its timeout is `WouldBlock` on unix and
    // `TimedOut` on Windows.
    matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut)
}

fn ws_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(MAX_STREAM_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_STREAM_MESSAGE_BYTES))
}

fn tls_config(extra_roots: &[Vec<u8>]) -> Result<Arc<rustls::ClientConfig>, DialError> {
    let mut roots = rustls::RootCertStore::empty();
    // The platform's store. A certificate in it that does not parse is
    // skipped rather than fatal -- one malformed entry in a keychain
    // should not be what stops a daemon reaching its Relay -- and the
    // dial fails later, by name, if what is left does not cover the
    // Relay's certificate.
    let native = rustls_native_certs::load_native_certs();
    let _ = roots.add_parsable_certificates(native.certs);
    for der in extra_roots {
        roots
            .add(CertificateDer::from(der.clone()))
            .map_err(|e| DialError::Tls(format!("an extra root certificate is not one: {e}")))?;
    }
    let config = rustls::ClientConfig::builder_with_provider(crate::tls_provider())
        .with_safe_default_protocol_versions()
        .map_err(|e| DialError::Tls(e.to_string()))?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Arc::new(config))
}

fn connect(url: &RelayUrl, timeout: Duration) -> Result<TcpStream, DialError> {
    let addrs = (url.host.as_str(), url.port).to_socket_addrs().map_err(DialError::Connect)?;
    let mut last = io::Error::new(io::ErrorKind::NotFound, "the Relay's host has no address");
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, timeout) {
            Ok(socket) => return Ok(socket),
            Err(e) => last = e,
        }
    }
    Err(DialError::Connect(last))
}

/// A connection the Relay has admitted.
pub struct RelayConnection {
    ws: WebSocket<Transport>,
    /// A second handle to the socket, for the two things that must not
    /// wait on the WebSocket: changing the read timeout, and closing it
    /// from under a read.
    socket: TcpStream,
    last_heard: Instant,
}

/// Opens a connection to the Relay at `url`, presents `hello`, and
/// returns once the Relay has said `Ready`.
///
/// For a Workstation that is as soon as it is registered. For a Device,
/// and for a daemon picking a stream up, it is when the other end is
/// there -- from then on the connection is a pipe.
pub fn dial(
    url: &str,
    hello: &RelayHello,
    options: &DialOptions,
) -> Result<RelayConnection, DialError> {
    let url = RelayUrl::parse(url).map_err(DialError::Url)?;
    let socket = connect(&url, options.connect_timeout)?;
    let _ = socket.set_nodelay(true);
    // One deadline for everything up to the first reply. A socket timeout
    // bounds each read rather than the sum of them, which is close enough
    // for a handshake of a few round trips and keeps a Relay that accepts
    // and then says nothing from holding a thread for ever.
    socket.set_read_timeout(Some(options.hello_timeout)).map_err(DialError::Connect)?;
    socket.set_write_timeout(Some(options.hello_timeout)).map_err(DialError::Connect)?;
    let handle = socket.try_clone().map_err(DialError::Connect)?;

    let transport = if url.secure {
        let name = ServerName::try_from(url.host.clone())
            .map_err(|e| DialError::Tls(format!("{:?} is not a host name: {e}", url.host)))?;
        let session = rustls::ClientConnection::new(tls_config(&options.extra_roots)?, name)
            .map_err(|e| DialError::Tls(e.to_string()))?;
        Transport::Tls(Box::new(rustls::StreamOwned::new(session, socket)))
    } else {
        Transport::Plain(socket)
    };

    let (ws, _) = tungstenite::client::client_with_config(
        url.url.as_str(),
        transport,
        Some(ws_config()),
    )
    .map_err(|e| match e {
        tungstenite::HandshakeError::Failure(tungstenite::Error::Io(e)) if is_timeout(&e) => {
            DialError::TimedOut
        }
        tungstenite::HandshakeError::Failure(tungstenite::Error::Io(e)) => {
            // A certificate the machine does not trust surfaces here, as
            // an I/O error carrying rustls's own.
            match e.get_ref().and_then(|inner| inner.downcast_ref::<rustls::Error>()) {
                Some(tls) => DialError::Tls(tls.to_string()),
                None => DialError::Connect(e),
            }
        }
        tungstenite::HandshakeError::Failure(e) => DialError::Protocol(e.to_string()),
        tungstenite::HandshakeError::Interrupted(_) => DialError::TimedOut,
    })?;

    let mut connection = RelayConnection { ws, socket: handle, last_heard: Instant::now() };
    connection
        .ws
        .send(Message::text(hello.to_frame()))
        .map_err(|e| DialError::Protocol(e.to_string()))?;

    match connection.next_reply(options.hello_timeout)? {
        Some(RelayReply::Ready) => Ok(connection),
        Some(RelayReply::Refused { reason }) => Err(DialError::Refused(reason)),
        Some(other) => Err(DialError::Protocol(format!("expected ready, got {other:?}"))),
        None => Err(DialError::TimedOut),
    }
}

impl RelayConnection {
    /// The Relay's next word, or `None` if `wait` passed without one.
    ///
    /// A Workstation's connection is read with this and nothing else:
    /// all it ever carries is `Incoming`.
    pub fn next_reply(&mut self, wait: Duration) -> Result<Option<RelayReply>, DialError> {
        let deadline = Instant::now() + wait;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Ok(None);
            }
            self.socket.set_read_timeout(Some(left)).map_err(DialError::Connect)?;
            match self.ws.read() {
                Ok(Message::Text(text)) => {
                    self.last_heard = Instant::now();
                    return serde_json_reply(text.as_str()).map(Some);
                }
                Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => self.last_heard = Instant::now(),
                Ok(Message::Close(_)) => return Err(DialError::Closed),
                Ok(other) => {
                    return Err(DialError::Protocol(format!(
                        "the Relay sent {} bytes that were not a reply",
                        other.len()
                    )))
                }
                Err(tungstenite::Error::Io(e)) if is_timeout(&e) => return Ok(None),
                Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                    return Err(DialError::Closed)
                }
                Err(tungstenite::Error::Io(e)) => return Err(DialError::Connect(e)),
                Err(e) => return Err(DialError::Protocol(e.to_string())),
            }
        }
    }

    /// Asks the Relay whether it is still there. The answer arrives
    /// through `next_reply`, which notes that something was heard.
    pub fn ping(&mut self) -> Result<(), DialError> {
        self.ws.send(Message::Ping(Vec::new().into())).map_err(|e| match e {
            tungstenite::Error::Io(e) => DialError::Connect(e),
            tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed => {
                DialError::Closed
            }
            other => DialError::Protocol(other.to_string()),
        })
    }

    /// How long since the Relay last said anything at all, a pong
    /// included.
    pub fn silence(&self) -> Duration {
        self.last_heard.elapsed()
    }

    /// The pipe. Every frame from here on is the other end's.
    pub fn into_stream(self) -> RelayStream {
        RelayStream {
            ws: self.ws,
            socket: self.socket,
            read_timeout: None,
            inbox: Vec::new(),
            read: 0,
            outbox: Vec::new(),
        }
    }

    /// Says goodbye and lets go. Best effort: a Relay that is already
    /// gone has nothing to be told.
    pub fn close(mut self) {
        let _ = self.ws.close(None);
        let _ = self.ws.flush();
        let _ = self.socket.shutdown(Shutdown::Both);
    }
}

fn serde_json_reply(text: &str) -> Result<RelayReply, DialError> {
    RelayReply::from_frame(text)
        .map_err(|e| DialError::Protocol(format!("the Relay's reply was not one: {e}")))
}

/// A stream the Relay is copying to the other end, as bytes.
///
/// WebSocket messages have boundaries and a byte stream has none, so the
/// boundaries are dropped on the way in -- whatever arrived is appended
/// to what is waiting to be read -- and chosen on the way out: everything
/// written since the last `flush` leaves as one message. The Device
/// wire's own framing is what is read out of the bytes.
pub struct RelayStream {
    ws: WebSocket<Transport>,
    socket: TcpStream,
    /// How long one `read` may wait for BYTES. Kept here and turned into
    /// a deadline per read, rather than left as the socket's own timeout:
    /// see `read`.
    read_timeout: Option<Duration>,
    inbox: Vec<u8>,
    read: usize,
    outbox: Vec<u8>,
}

/// What arrived on a stream that was not bytes for its reader.
enum Arrived {
    /// Bytes, now in the inbox.
    Bytes,
    /// Nothing, by the deadline.
    Nothing,
    /// The other end closed.
    End,
}

impl RelayStream {
    /// Bounds every read. A Device that walked out of range mid-handshake
    /// must not hold a thread for ever.
    pub fn set_read_timeout(&mut self, timeout: Option<Duration>) -> io::Result<()> {
        self.read_timeout = timeout;
        Ok(())
    }

    /// Waits until `deadline` for bytes, answering the Relay's keepalives
    /// meanwhile.
    ///
    /// The deadline is for the WAIT, not for each frame. The Relay asks
    /// every leg whether it is still there, and a ping is a frame: a wait
    /// that started over whenever one arrived would be renewed by the
    /// Relay every twenty seconds, and a peer that had gone quiet would
    /// never be given up on.
    fn arrive(&mut self, deadline: Option<Instant>) -> io::Result<Arrived> {
        loop {
            let left = match deadline {
                None => None,
                Some(deadline) => {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        return Ok(Arrived::Nothing);
                    }
                    Some(left)
                }
            };
            self.socket.set_read_timeout(left)?;
            match self.ws.read() {
                Ok(Message::Binary(bytes)) => {
                    // What has been read already is let go; what has not
                    // is kept in front of what just arrived.
                    self.inbox.drain(..self.read);
                    self.read = 0;
                    if self.inbox.len() + bytes.len() > MAX_STREAM_MESSAGE_BYTES {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "more arrived on a Relay stream than anyone was reading",
                        ));
                    }
                    self.inbox.extend_from_slice(&bytes);
                    if !bytes.is_empty() {
                        return Ok(Arrived::Bytes);
                    }
                }
                // Answered by tungstenite, on the next read or write.
                Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {}
                // End of stream, the way a closed socket says it.
                Ok(Message::Close(_))
                | Err(tungstenite::Error::ConnectionClosed)
                | Err(tungstenite::Error::AlreadyClosed) => return Ok(Arrived::End),
                Ok(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "a frame on a Relay stream was not binary",
                    ))
                }
                Err(tungstenite::Error::Io(e)) if is_timeout(&e) => return Ok(Arrived::Nothing),
                Err(tungstenite::Error::Io(e)) => return Err(e),
                Err(e) => return Err(io::Error::new(io::ErrorKind::InvalidData, e.to_string())),
            }
        }
    }

    /// Keeps the stream alive while nothing is being read from it, for
    /// up to `wait`, and says whether the other end is still there.
    ///
    /// The Relay drops a leg that has said nothing for a minute, and the
    /// answer to its keepalive is written when the socket is next READ --
    /// so a caller that holds a stream open while it waits on something
    /// else, as the daemon does while the human compares six digits, has
    /// to keep reading it or lose it. Bytes that arrive meanwhile are
    /// kept for the next `read`.
    pub fn stay_alive(&mut self, wait: Duration) -> io::Result<bool> {
        let deadline = Instant::now() + wait;
        loop {
            match self.arrive(Some(deadline))? {
                Arrived::Bytes => {}
                Arrived::Nothing => return Ok(true),
                Arrived::End => return Ok(false),
            }
        }
    }

    /// Closes the stream, saying so to the other end first.
    pub fn close(mut self) {
        let _ = self.flush();
        let _ = self.ws.close(None);
        let _ = self.ws.flush();
        let _ = self.socket.shutdown(Shutdown::Both);
    }
}

impl Read for RelayStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.read == self.inbox.len() {
            let deadline = self.read_timeout.map(|timeout| Instant::now() + timeout);
            match self.arrive(deadline)? {
                Arrived::Bytes => {}
                Arrived::End => return Ok(0),
                Arrived::Nothing => {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "nothing arrived on the Relay stream in time",
                    ))
                }
            }
        }
        let n = buf.len().min(self.inbox.len() - self.read);
        buf[..n].copy_from_slice(&self.inbox[self.read..self.read + n]);
        self.read += n;
        Ok(n)
    }
}

impl Write for RelayStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.outbox.len() + buf.len() > MAX_STREAM_MESSAGE_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "a message for a Relay stream is larger than the Relay copies",
            ));
        }
        self.outbox.extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        if self.outbox.is_empty() {
            return Ok(());
        }
        let message = Message::Binary(std::mem::take(&mut self.outbox).into());
        self.ws.send(message).map_err(|e| match e {
            tungstenite::Error::Io(e) => e,
            tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed => {
                io::Error::new(io::ErrorKind::BrokenPipe, "the Relay stream is closed")
            }
            other => io::Error::new(io::ErrorKind::InvalidData, other.to_string()),
        })
    }
}
