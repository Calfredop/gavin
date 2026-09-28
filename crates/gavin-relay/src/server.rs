//! The Relay: admission, matching, and the copy.
//!
//! Three kinds of connection arrive, each naming itself in its first
//! frame (`protocol::relay`):
//!
//! - a **Workstation** registers under its rendezvous id and then waits.
//!   Its connection carries announcements and never traffic;
//! - a **Device** asks for the Workstation at a rendezvous id. The Relay
//!   announces it, as a stream, to every registration under that id;
//! - a **stream** is the daemon picking that announcement up, on a
//!   connection of its own. The Relay joins it to the Device's and copies
//!   binary frames in both directions until either side goes.
//!
//! **Announced to every registration, claimed by one.** One Workstation
//! can be registered more than once: the dev build and the release build
//! of the daemon share one trust store, so one key, so one rendezvous id.
//! Replacing the older registration would set the two fighting over it,
//! and refusing the newer would leave whichever started second unable to
//! pair. So both are told, and the one that wants the stream -- the one
//! whose desk is showing the QR -- picks it up.
//!
//! **What the Relay never does** is read a frame it is copying, keep one,
//! or answer one. There is nothing in here that could.

use futures_util::{SinkExt, StreamExt};
use protocol::relay::{
    self, RefusalReason, RelayHello, RelayReply, MAX_HELLO_BYTES, MAX_PURPOSE_BYTES,
    MAX_STREAM_MESSAGE_BYTES, RELAY_WIRE_VERSION,
};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, Semaphore};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

/// The certificate the Relay serves and the key it serves it with, as
/// PEM.
#[derive(Clone)]
pub struct Tls {
    pub certificate_chain_pem: Vec<u8>,
    pub private_key_pem: Vec<u8>,
}

/// How much the Relay holds, and for how long.
#[derive(Debug, Clone)]
pub struct Limits {
    /// From accepting a socket to reading a hello off it, TLS and the
    /// WebSocket handshake included.
    pub hello_deadline: Duration,
    /// How long a Device waits for a Workstation to pick its stream up.
    pub claim_deadline: Duration,
    /// How often each connection is asked whether it is still there.
    pub keepalive: Duration,
    /// How long a connection may say nothing at all, pongs included,
    /// before it is dropped. A laptop that slept takes its sockets with
    /// it and tells nobody.
    pub silence: Duration,
    /// How long one frame may take to hand to the other end.
    pub write_deadline: Duration,
    pub registrations_per_rendezvous: usize,
    pub waiting_per_rendezvous: usize,
    /// Sockets open at once, of every kind.
    pub connections: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            hello_deadline: Duration::from_secs(5),
            claim_deadline: Duration::from_secs(10),
            keepalive: Duration::from_secs(20),
            silence: Duration::from_secs(60),
            write_deadline: Duration::from_secs(30),
            registrations_per_rendezvous: 4,
            waiting_per_rendezvous: 16,
            connections: 4096,
        }
    }
}

#[derive(Clone)]
pub struct RelayConfig {
    pub listen: SocketAddr,
    /// The admission tokens. More than one so a token can be replaced
    /// without every Workstation and Device changing theirs at the same
    /// moment; never none -- a Relay with no token is free
    /// infrastructure for strangers, and `serve` refuses to be one.
    pub tokens: Vec<String>,
    /// `None` is a Relay behind something that terminates TLS for it, or
    /// one on a developer's own machine.
    pub tls: Option<Tls>,
    pub limits: Limits,
}

impl RelayConfig {
    /// Whether a Relay can be started from this: an admission token that
    /// is not blank, and a certificate and key that are what they say.
    ///
    /// Asked BEFORE anything is bound. A Relay that bound its port, said
    /// it was listening, and only then found it had no token would have
    /// been reachable for a moment and would have told whatever was
    /// watching its output that it was up.
    pub fn validate(&self) -> anyhow::Result<()> {
        admission_digests(self)?;
        if let Some(tls) = &self.tls {
            tls_acceptor(tls)?;
        }
        Ok(())
    }

    /// A Relay on a port of the system's choosing on this machine, for
    /// tests and for the local development stack.
    pub fn local(token: &str) -> Self {
        Self {
            listen: SocketAddr::from(([127, 0, 0, 1], 0)),
            tokens: vec![token.to_string()],
            tls: None,
            limits: Limits::default(),
        }
    }
}

/// What the Relay has seen, for its operator and for its tests. Counts
/// only: the Relay keeps nothing about who.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RelayStats {
    /// Sockets accepted, before anything was read from them.
    pub accepted: u64,
    /// Hellos refused for their admission token.
    pub refused_admission: u64,
    /// Workstation registrations held right now.
    pub workstations: usize,
    /// Streams joined, ever.
    pub streams: u64,
    /// Streams being copied right now.
    pub streams_open: usize,
    /// Bytes copied, in both directions.
    pub bytes: u64,
}

#[derive(Default)]
struct Counters {
    accepted: AtomicU64,
    refused_admission: AtomicU64,
    workstations: AtomicUsize,
    streams: AtomicU64,
    streams_open: AtomicUsize,
    bytes: AtomicU64,
}

impl Counters {
    fn read(&self) -> RelayStats {
        RelayStats {
            accepted: self.accepted.load(Ordering::SeqCst),
            refused_admission: self.refused_admission.load(Ordering::SeqCst),
            workstations: self.workstations.load(Ordering::SeqCst),
            streams: self.streams.load(Ordering::SeqCst),
            streams_open: self.streams_open.load(Ordering::SeqCst),
            bytes: self.bytes.load(Ordering::SeqCst),
        }
    }
}

trait Io: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Io for T {}

type Socket = WebSocketStream<Box<dyn Io>>;

/// One Workstation registration: where to announce a stream.
struct Registration {
    id: u64,
    announce: mpsc::Sender<RelayReply>,
}

/// A Device waiting for its stream to be picked up.
struct Waiting {
    rendezvous: String,
    claim: oneshot::Sender<Socket>,
}

struct Shared {
    /// SHA-256 of each token, so a comparison takes the same time
    /// whatever was presented and however long it was.
    tokens: Vec<[u8; 32]>,
    limits: Limits,
    counters: Arc<Counters>,
    registrations: Mutex<HashMap<String, Vec<Registration>>>,
    waiting: Mutex<HashMap<String, Waiting>>,
    next_registration: AtomicU64,
}

fn digest(token: &str) -> [u8; 32] {
    let bytes = protocol::hex_decode(&protocol::hash_token_hex(token)).unwrap_or_default();
    let mut out = [0u8; 32];
    if bytes.len() == 32 {
        out.copy_from_slice(&bytes);
    }
    out
}

impl Shared {
    fn admits(&self, token: &str) -> bool {
        let presented = digest(token);
        // Every token is compared, and every byte of each: no early exit
        // for a timing to read.
        let mut admitted = false;
        for held in &self.tokens {
            let mut difference = 0u8;
            for (a, b) in held.iter().zip(presented.iter()) {
                difference |= a ^ b;
            }
            admitted |= difference == 0;
        }
        admitted
    }
}

/// Removes a registration when its connection ends, however it ends.
struct Registered {
    shared: Arc<Shared>,
    rendezvous: String,
    id: u64,
}

impl Drop for Registered {
    fn drop(&mut self) {
        let mut registrations = self.shared.registrations.lock().unwrap();
        if let Some(list) = registrations.get_mut(&self.rendezvous) {
            list.retain(|r| r.id != self.id);
            if list.is_empty() {
                registrations.remove(&self.rendezvous);
            }
        }
        self.shared.counters.workstations.fetch_sub(1, Ordering::SeqCst);
    }
}

fn ws_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(MAX_STREAM_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_STREAM_MESSAGE_BYTES))
}

fn tls_acceptor(tls: &Tls) -> anyhow::Result<tokio_rustls::TlsAcceptor> {
    let chain: Vec<CertificateDer<'static>> =
        CertificateDer::pem_slice_iter(&tls.certificate_chain_pem)
            .collect::<Result<_, _>>()
            .map_err(|e| anyhow::anyhow!("gavin-relay: the certificate is not PEM: {e}"))?;
    if chain.is_empty() {
        anyhow::bail!("gavin-relay: the certificate file holds no certificate");
    }
    let key = PrivateKeyDer::from_pem_slice(&tls.private_key_pem)
        .map_err(|e| anyhow::anyhow!("gavin-relay: the private key is not PEM: {e}"))?;
    let config = rustls::ServerConfig::builder_with_provider(crate::tls_provider())
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(chain, key)?;
    Ok(tokio_rustls::TlsAcceptor::from(Arc::new(config)))
}

/// Serves until `shutdown` resolves.
///
/// Refuses to start with no admission token, or with one that is blank:
/// "daemons and Devices must present its admission token" is the Relay's
/// one rule about who may connect, and a Relay that could be started
/// without it would be started without it.
pub async fn serve(
    listener: TcpListener,
    config: RelayConfig,
    shutdown: impl std::future::Future<Output = ()>,
) -> anyhow::Result<()> {
    serve_counting(listener, config, Arc::new(Counters::default()), shutdown).await
}

async fn serve_counting(
    listener: TcpListener,
    config: RelayConfig,
    counters: Arc<Counters>,
    shutdown: impl std::future::Future<Output = ()>,
) -> anyhow::Result<()> {
    let shared = Arc::new(shared_for(&config, counters)?);
    let acceptor = config.tls.as_ref().map(tls_acceptor).transpose()?;
    let slots = Arc::new(Semaphore::new(config.limits.connections));

    tokio::pin!(shutdown);
    loop {
        let accepted = tokio::select! {
            _ = &mut shutdown => return Ok(()),
            accepted = listener.accept() => accepted,
        };
        let socket = match accepted {
            Ok((socket, _)) => socket,
            Err(e) => {
                eprintln!("gavin-relay: accept failed: {e}");
                // Out of file descriptors is the realistic one, and a
                // loop that span on it would take the Relay down for the
                // connections it already holds.
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        shared.counters.accepted.fetch_add(1, Ordering::SeqCst);
        // At the ceiling a socket is closed unread. Nothing is known
        // about it yet, so there is nobody to explain it to.
        let Ok(slot) = Arc::clone(&slots).try_acquire_owned() else {
            continue;
        };
        let shared = Arc::clone(&shared);
        let acceptor = acceptor.clone();
        tokio::spawn(async move {
            let _slot = slot;
            handle(shared, acceptor, socket).await;
        });
    }
}

/// The digest of every admission token, or the refusal to start without
/// one.
fn admission_digests(config: &RelayConfig) -> anyhow::Result<Vec<[u8; 32]>> {
    let tokens: Vec<&str> =
        config.tokens.iter().map(|t| t.trim()).filter(|t| !t.is_empty()).collect();
    if tokens.is_empty() {
        anyhow::bail!(
            "gavin-relay: no admission token is set — a Relay admits only the daemons and Devices that hold its token, so it will not start without one"
        );
    }
    Ok(tokens.into_iter().map(digest).collect())
}

fn shared_for(config: &RelayConfig, counters: Arc<Counters>) -> anyhow::Result<Shared> {
    Ok(Shared {
        tokens: admission_digests(config)?,
        limits: config.limits.clone(),
        counters,
        registrations: Mutex::new(HashMap::new()),
        waiting: Mutex::new(HashMap::new()),
        next_registration: AtomicU64::new(0),
    })
}

/// One connection, from the socket to whatever it turned out to be.
async fn handle(
    shared: Arc<Shared>,
    acceptor: Option<tokio_rustls::TlsAcceptor>,
    socket: TcpStream,
) {
    let _ = socket.set_nodelay(true);
    let deadline = shared.limits.hello_deadline;

    // One deadline for the TLS handshake, the WebSocket handshake and the
    // hello: a peer that opens a socket and says nothing costs the Relay
    // a slot for five seconds, not for as long as it likes.
    let opened = tokio::time::timeout(deadline, async {
        let io: Box<dyn Io> = match acceptor {
            Some(acceptor) => Box::new(acceptor.accept(socket).await.ok()?),
            None => Box::new(socket),
        };
        let mut ws =
            tokio_tungstenite::accept_async_with_config(io, Some(ws_config())).await.ok()?;
        let first = ws.next().await;
        Some((ws, first))
    })
    .await;

    let (ws, first) = match opened {
        Ok(Some(opened)) => opened,
        // Never got as far as a WebSocket: nothing to say it over.
        Ok(None) | Err(_) => return,
    };

    let hello = match first {
        Some(Ok(Message::Text(text))) if text.len() <= MAX_HELLO_BYTES => {
            match RelayHello::from_frame(text.as_str()) {
                Ok(hello) => hello,
                Err(_) => return refuse(ws, RefusalReason::Malformed).await,
            }
        }
        Some(Ok(_)) => return refuse(ws, RefusalReason::Malformed).await,
        _ => return,
    };

    let Some((version, token, rendezvous)) = hello.admission() else {
        return refuse(ws, RefusalReason::Version).await;
    };
    // The token first, before anything else in the hello is judged: a
    // peer that was not admitted learns that and nothing more.
    if !shared.admits(token) {
        shared.counters.refused_admission.fetch_add(1, Ordering::SeqCst);
        return refuse(ws, RefusalReason::Admission).await;
    }
    if version != RELAY_WIRE_VERSION {
        return refuse(ws, RefusalReason::Version).await;
    }
    if !relay::is_rendezvous_id(rendezvous) {
        return refuse(ws, RefusalReason::Malformed).await;
    }

    match &hello {
        RelayHello::Workstation { rendezvous, .. } => {
            workstation(shared, ws, rendezvous.clone()).await
        }
        RelayHello::Device { rendezvous, purpose, .. } => {
            if !is_purpose(purpose) {
                return refuse(ws, RefusalReason::Malformed).await;
            }
            device(shared, ws, rendezvous.clone(), purpose.clone()).await
        }
        RelayHello::Stream { rendezvous, stream, .. } => {
            if !relay::is_stream_id(stream) {
                return refuse(ws, RefusalReason::Malformed).await;
            }
            // Taken out under the lock, so a stream is picked up once.
            let waiting = {
                let mut all = shared.waiting.lock().unwrap();
                match all.get(stream) {
                    Some(w) if w.rendezvous == *rendezvous => all.remove(stream),
                    _ => None,
                }
            };
            match waiting {
                // The Device's task owns both sockets from here.
                Some(waiting) => {
                    if let Err(ws) = waiting.claim.send(ws) {
                        refuse(ws, RefusalReason::Gone).await;
                    }
                }
                None => refuse(ws, RefusalReason::Gone).await,
            }
        }
        RelayHello::Unknown => refuse(ws, RefusalReason::Version).await,
    }
}

/// A label the Relay will forward: short, and nothing that could be
/// mistaken for structure by whatever logs it.
fn is_purpose(purpose: &str) -> bool {
    !purpose.is_empty()
        && purpose.len() <= MAX_PURPOSE_BYTES
        && purpose.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Says why, then closes. Bounded, so a peer that will not read its
/// refusal cannot hold the slot by not reading it.
async fn refuse(mut ws: Socket, reason: RefusalReason) {
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        let _ = ws.send(Message::text(RelayReply::Refused { reason }.to_frame())).await;
        let _ = ws.close(None).await;
    })
    .await;
}

async fn say(ws: &mut Socket, reply: &RelayReply, within: Duration) -> bool {
    matches!(
        tokio::time::timeout(within, ws.send(Message::text(reply.to_frame()))).await,
        Ok(Ok(()))
    )
}

async fn workstation(shared: Arc<Shared>, mut ws: Socket, rendezvous: String) {
    let (announce, mut announcements) = mpsc::channel(shared.limits.waiting_per_rendezvous);
    let id = shared.next_registration.fetch_add(1, Ordering::SeqCst);
    // Decided inside the block and acted on outside it: the lock is a
    // std one, and must be let go before anything is awaited.
    let registered = {
        let mut registrations = shared.registrations.lock().unwrap();
        let list = registrations.entry(rendezvous.clone()).or_default();
        if list.len() >= shared.limits.registrations_per_rendezvous {
            false
        } else {
            list.push(Registration { id, announce });
            shared.counters.workstations.fetch_add(1, Ordering::SeqCst);
            true
        }
    };
    if !registered {
        return refuse(ws, RefusalReason::Busy).await;
    }
    let _registered = Registered { shared: Arc::clone(&shared), rendezvous, id };

    if !say(&mut ws, &RelayReply::Ready, shared.limits.write_deadline).await {
        return;
    }

    let mut keepalive = tokio::time::interval(shared.limits.keepalive);
    keepalive.tick().await;
    let mut heard = Instant::now();
    loop {
        tokio::select! {
            announcement = announcements.recv() => {
                let Some(announcement) = announcement else { break };
                if !say(&mut ws, &announcement, shared.limits.write_deadline).await {
                    break;
                }
            }
            message = ws.next() => match message {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                // Nothing a Workstation says on this connection means
                // anything, but having said it means it is there.
                Some(Ok(_)) => heard = Instant::now(),
            },
            _ = keepalive.tick() => {
                if heard.elapsed() > shared.limits.silence {
                    break;
                }
                let ping = ws.send(Message::Ping(Vec::new().into()));
                if !matches!(tokio::time::timeout(shared.limits.write_deadline, ping).await, Ok(Ok(()))) {
                    break;
                }
            }
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(2), ws.close(None)).await;
}

async fn device(shared: Arc<Shared>, ws: Socket, rendezvous: String, purpose: String) {
    let announce: Vec<mpsc::Sender<RelayReply>> = shared
        .registrations
        .lock()
        .unwrap()
        .get(&rendezvous)
        .map(|list| list.iter().map(|r| r.announce.clone()).collect())
        .unwrap_or_default();
    if announce.is_empty() {
        return refuse(ws, RefusalReason::Offline).await;
    }

    let stream = match protocol::random_hex(16) {
        Ok(id) => id,
        Err(e) => {
            eprintln!("gavin-relay: no randomness for a stream id: {e}");
            return refuse(ws, RefusalReason::Busy).await;
        }
    };
    let (claim, claimed) = oneshot::channel();
    let held = {
        let mut waiting = shared.waiting.lock().unwrap();
        let held = waiting.values().filter(|w| w.rendezvous == rendezvous).count();
        if held < shared.limits.waiting_per_rendezvous {
            waiting.insert(stream.clone(), Waiting { rendezvous: rendezvous.clone(), claim });
        }
        held
    };
    if held >= shared.limits.waiting_per_rendezvous {
        return refuse(ws, RefusalReason::Busy).await;
    }

    let announcement = RelayReply::Incoming { stream: stream.clone(), purpose };
    for registration in announce {
        // A registration whose queue is full is one that is not reading;
        // the stream is still offered to the others.
        let _ = registration.try_send(announcement.clone());
    }

    let workstation = match tokio::time::timeout(shared.limits.claim_deadline, claimed).await {
        Ok(Ok(workstation)) => workstation,
        _ => {
            shared.waiting.lock().unwrap().remove(&stream);
            return refuse(ws, RefusalReason::Unclaimed).await;
        }
    };
    copy(shared, ws, workstation).await;
}

/// Counts a stream as open for as long as it is being copied.
struct Open(Arc<Counters>);

impl Drop for Open {
    fn drop(&mut self) {
        self.0.streams_open.fetch_sub(1, Ordering::SeqCst);
    }
}

/// What one leg's next message means for the copy.
enum Step {
    Forward(Message, usize),
    Heard,
    End,
}

fn step(message: Option<Result<Message, tokio_tungstenite::tungstenite::Error>>) -> Step {
    match message {
        Some(Ok(Message::Binary(bytes))) => {
            let len = bytes.len();
            Step::Forward(Message::Binary(bytes), len)
        }
        Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => Step::Heard,
        // A text frame has no business on a stream: the only text the
        // Relay's peers send is a hello, and this connection's was read.
        // Closing both legs is the whole of what the Relay can say about
        // it without reading what it carries.
        Some(Ok(_)) | Some(Err(_)) | None => Step::End,
    }
}

/// Joins a Device's socket to the Workstation's and copies binary frames
/// between them, verbatim, until either side goes.
async fn copy(shared: Arc<Shared>, mut device: Socket, mut workstation: Socket) {
    let limits = shared.limits.clone();
    // Both are told at once that the other is there. If either cannot be
    // told, neither has a stream.
    let ready = RelayReply::Ready;
    if !say(&mut workstation, &ready, limits.write_deadline).await
        || !say(&mut device, &ready, limits.write_deadline).await
    {
        let _ = tokio::time::timeout(Duration::from_secs(2), async {
            let _ = device.close(None).await;
            let _ = workstation.close(None).await;
        })
        .await;
        return;
    }
    shared.counters.streams.fetch_add(1, Ordering::SeqCst);
    shared.counters.streams_open.fetch_add(1, Ordering::SeqCst);
    let _open = Open(Arc::clone(&shared.counters));

    let mut keepalive = tokio::time::interval(limits.keepalive);
    keepalive.tick().await;
    let mut device_heard = Instant::now();
    let mut workstation_heard = Instant::now();

    loop {
        tokio::select! {
            message = device.next() => match step(message) {
                Step::Forward(message, len) => {
                    device_heard = Instant::now();
                    let sent = tokio::time::timeout(limits.write_deadline, workstation.send(message)).await;
                    if !matches!(sent, Ok(Ok(()))) {
                        break;
                    }
                    shared.counters.bytes.fetch_add(len as u64, Ordering::SeqCst);
                }
                Step::Heard => device_heard = Instant::now(),
                Step::End => break,
            },
            message = workstation.next() => match step(message) {
                Step::Forward(message, len) => {
                    workstation_heard = Instant::now();
                    let sent = tokio::time::timeout(limits.write_deadline, device.send(message)).await;
                    if !matches!(sent, Ok(Ok(()))) {
                        break;
                    }
                    shared.counters.bytes.fetch_add(len as u64, Ordering::SeqCst);
                }
                Step::Heard => workstation_heard = Instant::now(),
                Step::End => break,
            },
            _ = keepalive.tick() => {
                if device_heard.elapsed() > limits.silence
                    || workstation_heard.elapsed() > limits.silence
                {
                    break;
                }
                let pings = async {
                    let a = device.send(Message::Ping(Vec::new().into())).await;
                    let b = workstation.send(Message::Ping(Vec::new().into())).await;
                    a.is_ok() && b.is_ok()
                };
                if !matches!(tokio::time::timeout(limits.write_deadline, pings).await, Ok(true)) {
                    break;
                }
            }
        }
    }

    // One side went; the other is told, so it reads end-of-stream and
    // not a connection that went quiet.
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        let _ = device.close(None).await;
        let _ = workstation.close(None).await;
    })
    .await;
}

/// A Relay running on a thread of its own, for a program that is not
/// async: the tests, here and in the daemon.
///
/// Stops when dropped.
pub struct RunningRelay {
    addr: SocketAddr,
    secure: bool,
    counters: Arc<Counters>,
    shutdown: Option<oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl RunningRelay {
    /// Binds, and returns once the Relay is accepting.
    pub fn start(config: RelayConfig) -> anyhow::Result<Self> {
        // Judged here, on the caller's thread, so a Relay that will not
        // start says so as an error rather than as a thread that ended.
        config.validate()?;
        let counters = Arc::new(Counters::default());

        let secure = config.tls.is_some();
        let (shutdown, stop) = oneshot::channel::<()>();
        let (bound, binding) = std::sync::mpsc::channel::<anyhow::Result<SocketAddr>>();
        let serving = Arc::clone(&counters);
        let thread = std::thread::Builder::new().name("gavin-relay".into()).spawn(move || {
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(e) => {
                    let _ = bound.send(Err(e.into()));
                    return;
                }
            };
            runtime.block_on(async move {
                let listener = match TcpListener::bind(config.listen).await {
                    Ok(listener) => listener,
                    Err(e) => {
                        let _ = bound.send(Err(e.into()));
                        return;
                    }
                };
                let _ = bound.send(listener.local_addr().map_err(Into::into));
                let stop = async {
                    let _ = stop.await;
                };
                if let Err(e) = serve_counting(listener, config, serving, stop).await {
                    eprintln!("{e}");
                }
            });
        })?;

        let addr = binding
            .recv()
            .map_err(|_| anyhow::anyhow!("gavin-relay: the Relay's thread ended before it bound"))??;
        Ok(Self { addr, secure, counters, shutdown: Some(shutdown), thread: Some(thread) })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    /// The URL to dial, by address. A TLS Relay is dialled by the name
    /// its certificate carries instead -- see `url_for`.
    pub fn url(&self) -> String {
        self.url_for(&self.addr.ip().to_string())
    }

    /// The URL to dial, naming `host`.
    pub fn url_for(&self, host: &str) -> String {
        let scheme = if self.secure { "wss" } else { "ws" };
        format!("{scheme}://{host}:{}", self.addr.port())
    }

    pub fn stats(&self) -> RelayStats {
        self.counters.read()
    }
}

impl Drop for RunningRelay {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
