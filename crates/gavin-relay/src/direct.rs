//! A daemon's direct listener, and what dials it (ADR 0009).
//!
//! The direct path is the Relay path with the Relay deleted
//! (`docs/security/05-remote-access.md` §5): a Device opens a TLS
//! WebSocket straight to its Workstation's daemon and sends the first frame
//! it would send a Relay. The daemon reads the purpose out of it, answers
//! `ready`, and from then on the connection is the same pipe a Relay
//! stream is -- a `RelayStream` -- carrying the same Noise.
//!
//! Two halves, for the two ends, and here for the reason `client` is:
//! they are one pipe.
//!
//! - `answer` is the daemon's: TLS, the WebSocket handshake and the
//!   Device's first frame, all inside one deadline.
//! - `pinned_config` is the dialler's: the one certificate whose hash the
//!   pairing QR carried (`protocol::relay::certificate_pin`), and nothing
//!   else -- no root, no host name.

use crate::client::{ws_config, RelayStream, Transport};
use protocol::relay::{certificate_pin, RefusalReason, RelayHello, RelayReply, MAX_HELLO_BYTES};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tungstenite::{HandshakeError, Message, WebSocket};

/// How long one frame may take to hand to the Device once the pipe is
/// open: the Relay's `write_deadline`.
const WRITE_DEADLINE: Duration = Duration::from_secs(30);

/// The socket under a Device's direct connection, until a deadline:
/// everything read through it has to arrive by then.
///
/// A timeout on each read bounds a peer that says nothing. It does not
/// bound one that says a byte at a time, each inside the timeout -- and
/// TLS, the WebSocket handshake and the hello are a dozen reads. Lifted
/// once the hello is answered (`Answered::ready`), after which the
/// stream sets its own timeout before every read.
pub struct Paced {
    socket: TcpStream,
    until: Option<Instant>,
}

impl Read for Paced {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if let Some(until) = self.until {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "the Device did not say hello in time",
                ));
            }
            self.socket.set_read_timeout(Some(left))?;
        }
        self.socket.read(buf)
    }
}

impl Write for Paced {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.socket.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.socket.flush()
    }
}

/// What `answer` serves a Device's TLS with.
pub type ServerTls = Arc<rustls::ServerConfig>;

/// The listener's TLS: the certificate the pairing QR pins, and its key
/// (PKCS#8, DER).
pub fn server_config(certificate_der: &[u8], private_key_pkcs8: &[u8]) -> Result<ServerTls, String> {
    let config = rustls::ServerConfig::builder_with_provider(crate::tls_provider())
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(certificate_der.to_vec())],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(private_key_pkcs8.to_vec())),
        )
        .map_err(|e| e.to_string())?;
    Ok(Arc::new(config))
}

/// Why a connection to the listener never said hello.
#[derive(Debug)]
pub enum AnswerError {
    /// TLS did not complete: not a Device, or not one that pinned this
    /// certificate.
    Tls(String),
    /// What arrived was not a WebSocket opening with a hello.
    Malformed(String),
    /// Nothing whole arrived by the deadline.
    TimedOut,
    /// The peer hung up first.
    Closed,
    Io(io::Error),
}

impl std::fmt::Display for AnswerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AnswerError::Tls(e) => write!(f, "TLS did not complete: {e}"),
            AnswerError::Malformed(e) => write!(f, "it did not open as a Device does: {e}"),
            AnswerError::TimedOut => write!(f, "it did not say hello in time"),
            AnswerError::Closed => write!(f, "it hung up before saying hello"),
            AnswerError::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for AnswerError {}

impl From<io::Error> for AnswerError {
    fn from(e: io::Error) -> Self {
        if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) {
            return AnswerError::TimedOut;
        }
        // A handshake rustls refused surfaces as an I/O error carrying
        // rustls's own -- a browser's "GET /" to the port among them.
        if let Some(tls) = e.get_ref().and_then(|inner| inner.downcast_ref::<rustls::Error>()) {
            return AnswerError::Tls(tls.to_string());
        }
        if matches!(
            e.kind(),
            io::ErrorKind::UnexpectedEof
                | io::ErrorKind::ConnectionReset
                | io::ErrorKind::ConnectionAborted
                | io::ErrorKind::BrokenPipe
        ) {
            return AnswerError::Closed;
        }
        AnswerError::Io(e)
    }
}

impl From<tungstenite::Error> for AnswerError {
    fn from(e: tungstenite::Error) -> Self {
        match e {
            tungstenite::Error::Io(e) => e.into(),
            tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed => {
                AnswerError::Closed
            }
            other => AnswerError::Malformed(other.to_string()),
        }
    }
}

/// A Device that has said hello, and is waiting to be told yes or no.
pub struct Answered {
    ws: WebSocket<Transport>,
    socket: TcpStream,
    /// What it said. Read by the caller, which alone knows whose key it
    /// is and whether a pairing is on offer.
    pub hello: RelayHello,
}

/// Takes a Device's connection as far as its first frame: TLS, the
/// WebSocket handshake, and a hello -- all of it `within` of being
/// called, however slowly it arrives.
///
/// Nothing here reads the hello for meaning. A frame that is not one at
/// all is refused (`malformed`) before this returns, the way a Relay
/// refuses it; whether the one that is names this Workstation is the
/// caller's to say.
pub fn answer(socket: TcpStream, tls: ServerTls, within: Duration) -> Result<Answered, AnswerError> {
    let until = Instant::now() + within;
    let _ = socket.set_nodelay(true);
    socket.set_write_timeout(Some(within))?;
    let handle = socket.try_clone()?;
    let session =
        rustls::ServerConnection::new(tls).map_err(|e| AnswerError::Tls(e.to_string()))?;
    let transport = Transport::Answering(Box::new(rustls::StreamOwned::new(
        session,
        Paced { socket, until: Some(until) },
    )));
    let mut ws = tungstenite::accept_with_config(transport, Some(ws_config())).map_err(|e| {
        match e {
            // A read that ran out its timeout, half-way through.
            HandshakeError::Interrupted(_) => AnswerError::TimedOut,
            HandshakeError::Failure(e) => e.into(),
        }
    })?;

    loop {
        match ws.read() {
            Ok(Message::Text(text)) => {
                let hello = (text.len() <= MAX_HELLO_BYTES)
                    .then(|| RelayHello::from_frame(text.as_str()).ok())
                    .flatten();
                let mut answered = Answered { ws, socket: handle, hello: RelayHello::Unknown };
                return match hello {
                    Some(hello) => {
                        answered.hello = hello;
                        Ok(answered)
                    }
                    None => {
                        answered.refuse(RefusalReason::Malformed);
                        Err(AnswerError::Malformed("the first frame was not a hello".into()))
                    }
                };
            }
            // Answered by tungstenite on the next read.
            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {}
            Ok(Message::Close(_)) => return Err(AnswerError::Closed),
            Ok(_) => {
                let answered = Answered { ws, socket: handle, hello: RelayHello::Unknown };
                answered.refuse(RefusalReason::Malformed);
                return Err(AnswerError::Malformed("the first frame was not text".into()));
            }
            Err(e) => return Err(e.into()),
        }
    }
}

impl Answered {
    /// Says `ready`. From here the connection is a pipe, and the hello's
    /// deadline no longer applies: the stream bounds each of its own
    /// reads.
    pub fn ready(mut self) -> io::Result<RelayStream> {
        self.ws.send(Message::text(RelayReply::Ready.to_frame())).map_err(|e| match e {
            tungstenite::Error::Io(e) => e,
            other => io::Error::new(io::ErrorKind::BrokenPipe, other.to_string()),
        })?;
        if let Transport::Answering(tls) = self.ws.get_mut() {
            tls.sock.until = None;
        }
        self.socket.set_write_timeout(Some(WRITE_DEADLINE))?;
        Ok(RelayStream::over(self.ws, self.socket))
    }

    /// Says no, and why, and hangs up.
    pub fn refuse(mut self, reason: RefusalReason) {
        let _ = self.ws.send(Message::text(RelayReply::Refused { reason }.to_frame()));
        let _ = self.ws.close(None);
        let _ = self.ws.flush();
        let _ = self.socket.shutdown(Shutdown::Both);
    }
}

/// Trusts the one certificate whose pin it holds.
///
/// The handshake's signature is still checked with that certificate's
/// key, so what is trusted is a peer that HOLDS the key, not one that has
/// seen the certificate -- which anyone who opened the port has.
#[derive(Debug)]
struct Pinned {
    pin: String,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if certificate_pin(end_entity.as_ref()) == self.pin {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::InvalidCertificate(
                rustls::CertificateError::ApplicationVerificationFailure,
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

/// A client configuration that trusts `pin`'s certificate and no other.
pub(crate) fn pinned_config(pin: &str) -> Result<Arc<rustls::ClientConfig>, String> {
    let pin = pin.trim().to_ascii_lowercase();
    if pin.len() != 64 || !pin.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("the pinned certificate's hash is not 64 hex digits".into());
    }
    let provider = crate::tls_provider();
    let config = rustls::ClientConfig::builder_with_provider(Arc::clone(&provider))
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pinned { pin, provider }))
        .with_no_client_auth();
    Ok(Arc::new(config))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::{dial, DialError, DialOptions};
    use protocol::relay::{rendezvous_id, PURPOSE_CONNECT};
    use std::net::TcpListener;

    struct Listener {
        listener: TcpListener,
        tls: Arc<rustls::ServerConfig>,
        pin: String,
    }

    fn listener() -> Listener {
        let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
        let params = rcgen::CertificateParams::new(vec!["gavin-workstation".to_string()]).unwrap();
        let certificate = params.self_signed(&key).unwrap();
        let tls = server_config(certificate.der(), &key.serialize_der()).unwrap();
        Listener {
            listener: TcpListener::bind("127.0.0.1:0").unwrap(),
            tls,
            pin: certificate_pin(certificate.der()),
        }
    }

    impl Listener {
        fn url(&self) -> String {
            format!("wss://127.0.0.1:{}", self.listener.local_addr().unwrap().port())
        }

        /// Answers the next connection, and says yes to whatever it said.
        fn answer_one(
            &self,
            within: Duration,
        ) -> std::thread::JoinHandle<Result<RelayHello, AnswerError>> {
            let (socket, _) = self.listener.accept().unwrap();
            let tls = Arc::clone(&self.tls);
            std::thread::spawn(move || {
                let answered = answer(socket, tls, within)?;
                let hello = answered.hello.clone();
                let mut stream = answered.ready()?;
                // Echo one message, so the dialler can see the pipe.
                stream.set_read_timeout(Some(Duration::from_secs(5)))?;
                let mut buf = [0u8; 64];
                let n = stream.read(&mut buf)?;
                stream.write_all(&buf[..n])?;
                stream.flush()?;
                Ok(hello)
            })
        }
    }

    fn hello() -> RelayHello {
        RelayHello::device("", &rendezvous_id(&[7u8; 32]), PURPOSE_CONNECT)
    }

    fn pinned(pin: &str) -> DialOptions {
        DialOptions { pin: Some(pin.to_string()), ..DialOptions::default() }
    }

    #[test]
    fn a_device_that_pinned_the_certificate_is_answered_and_gets_a_pipe() {
        let listener = listener();
        let url = listener.url();
        let pin = listener.pin.clone();
        let dialling = std::thread::spawn(move || {
            let mut stream = dial(&url, &hello(), &pinned(&pin)).unwrap().into_stream();
            stream.write_all(b"noise").unwrap();
            stream.flush().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut buf = [0u8; 5];
            stream.read_exact(&mut buf).unwrap();
            buf
        });
        let answered = listener.answer_one(Duration::from_secs(5)).join().unwrap().unwrap();
        assert_eq!(answered, hello());
        assert_eq!(&dialling.join().unwrap(), b"noise");
    }

    #[test]
    fn a_certificate_other_than_the_pinned_one_is_not_trusted() {
        let listener = listener();
        let url = listener.url();
        let dialling = std::thread::spawn(move || dial(&url, &hello(), &pinned(&"00".repeat(32))));
        let answered = listener.answer_one(Duration::from_secs(5)).join().unwrap();
        assert!(matches!(answered, Err(AnswerError::Tls(_) | AnswerError::Closed)), "{answered:?}");
        assert!(matches!(dialling.join().unwrap(), Err(DialError::Tls(_))));
    }

    /// The certificate is not one a machine trusts, and must not become
    /// one by being dialled without a pin.
    #[test]
    fn without_the_pin_the_listener_is_not_trusted() {
        let listener = listener();
        let url = listener.url();
        let dialling = std::thread::spawn(move || dial(&url, &hello(), &DialOptions::default()));
        let _ = listener.answer_one(Duration::from_secs(5)).join().unwrap();
        assert!(matches!(dialling.join().unwrap(), Err(DialError::Tls(_))));
    }

    #[test]
    fn a_pin_on_a_plain_address_is_refused_rather_than_ignored() {
        let refused = dial("ws://127.0.0.1:9", &hello(), &pinned(&"00".repeat(32)));
        assert!(matches!(refused, Err(DialError::Tls(_))));
    }

    #[test]
    fn something_that_is_not_tls_is_refused_before_any_hello() {
        let listener = listener();
        let addr = listener.listener.local_addr().unwrap();
        let mut browser = TcpStream::connect(addr).unwrap();
        browser.write_all(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
        let (socket, _) = listener.listener.accept().unwrap();
        let answered = answer(socket, Arc::clone(&listener.tls), Duration::from_secs(5));
        assert!(matches!(answered, Err(AnswerError::Tls(_))), "{:?}", answered.err());
    }

    /// The deadline is for the whole hello, not for each read of it: a
    /// peer that sends a byte inside every timeout still runs out of time.
    #[test]
    fn a_peer_that_trickles_runs_out_of_time_all_the_same() {
        let listener = listener();
        let addr = listener.listener.local_addr().unwrap();
        let trickling = std::thread::spawn(move || {
            let mut peer = TcpStream::connect(addr).unwrap();
            // The first bytes of a TLS ClientHello, one at a time.
            for byte in [0x16u8, 0x03, 0x01, 0x02, 0x00].iter().cycle().take(40) {
                if peer.write_all(&[*byte]).is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        let (socket, _) = listener.listener.accept().unwrap();
        let started = Instant::now();
        let answered = answer(socket, Arc::clone(&listener.tls), Duration::from_millis(600));
        let took = started.elapsed();
        assert!(matches!(answered, Err(AnswerError::TimedOut) | Err(AnswerError::Tls(_))), "{:?}", answered.err());
        assert!(took < Duration::from_secs(2), "every byte renewed the wait: {took:?}");
        trickling.join().unwrap();
    }

    #[test]
    fn a_peer_that_says_nothing_runs_out_of_time() {
        let listener = listener();
        let addr = listener.listener.local_addr().unwrap();
        let _silent = TcpStream::connect(addr).unwrap();
        let (socket, _) = listener.listener.accept().unwrap();
        let started = Instant::now();
        let answered = answer(socket, Arc::clone(&listener.tls), Duration::from_millis(300));
        assert!(matches!(answered, Err(AnswerError::TimedOut)), "{:?}", answered.err());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    /// A WebSocket whose first frame is not a hello is refused by name,
    /// as a Relay refuses it.
    #[test]
    fn a_first_frame_that_is_not_a_hello_is_refused_as_malformed() {
        let listener = listener();
        let url = listener.url();
        let pin = listener.pin.clone();
        let dialling = std::thread::spawn(move || {
            // A hello the Relay contract has never heard of is still
            // text; send one with a role this build reads as Unknown and
            // see the listener treat it as a hello it can refuse later.
            // Here: not JSON at all.
            let options = pinned(&pin);
            let url = protocol::relay::RelayUrl::parse(&url).unwrap();
            let socket = TcpStream::connect((url.host.as_str(), url.port)).unwrap();
            let config = pinned_config(&options.pin.unwrap()).unwrap();
            let name = ServerName::try_from(url.host.clone()).unwrap();
            let session = rustls::ClientConnection::new(config, name).unwrap();
            let tls = rustls::StreamOwned::new(session, socket);
            let (mut ws, _) = tungstenite::client::client(url.url.as_str(), tls).unwrap();
            ws.send(Message::text("hello there")).unwrap();
            match ws.read().unwrap() {
                Message::Text(text) => RelayReply::from_frame(text.as_str()).unwrap(),
                other => panic!("expected a refusal, got {other:?}"),
            }
        });
        let (socket, _) = listener.listener.accept().unwrap();
        let answered = answer(socket, Arc::clone(&listener.tls), Duration::from_secs(5));
        assert!(matches!(answered, Err(AnswerError::Malformed(_))), "{:?}", answered.err());
        assert_eq!(
            dialling.join().unwrap(),
            RelayReply::Refused { reason: RefusalReason::Malformed }
        );
    }
}
