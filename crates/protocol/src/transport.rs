//! The one socket gavin has, behind a name that exists on Windows too.
//!
//! Three processes talk over it -- the app, gavin-mcp and the daemon --
//! and until this module every one of them imported
//! `std::os::unix::net` unconditionally. That import is not a portability
//! wart to tidy up later: `std::os::unix` does not EXIST on a Windows
//! target, so the workspace did not fail to run on Windows, it failed to
//! parse.
//!
//! What is abstracted is the transport and nothing above it. The wire is
//! still newline-delimited JSON through `read_message` / `write_message`,
//! so `Request`, `Response`, the version band and every consumer of them
//! are untouched by this file existing.
//!
//! The Unix arm is `UnixStream` / `UnixListener` with the method names
//! kept, which is why the call sites read as they did. The Windows arm is
//! a named pipe (`\\.\pipe\gavin-...`) driven straight from Win32 rather
//! than through a crate: every operation here has a Unix behaviour it has
//! to imitate exactly -- a read timeout that reports `WouldBlock`, a
//! `try_clone` that shares one connection, a `shutdown` that unblocks a
//! reader another thread is sitting in, an EOF at peer close -- and those
//! are easier to match against the API that defines them than to discover
//! in a wrapper.

use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Where the daemon listens, as the one value every process derives from
/// `socket_path()`.
///
/// It carries a PATH on both platforms even though Windows has no socket
/// file, because a path is what the callers already have and what the
/// tests already build: a tempdir gives every daemon test its own
/// endpoint for free, and that has to keep working when the endpoint is a
/// pipe name. `pipe_name_for_path` is the mapping, and it is deterministic
/// so two processes handed the same path land on the same pipe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint(PathBuf);

impl Endpoint {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Endpoint(path.into())
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl From<PathBuf> for Endpoint {
    fn from(p: PathBuf) -> Self {
        Endpoint(p)
    }
}

impl From<&PathBuf> for Endpoint {
    fn from(p: &PathBuf) -> Self {
        Endpoint(p.clone())
    }
}

impl From<&Path> for Endpoint {
    fn from(p: &Path) -> Self {
        Endpoint(p.to_path_buf())
    }
}

impl From<&Endpoint> for Endpoint {
    fn from(e: &Endpoint) -> Self {
        e.clone()
    }
}

impl std::fmt::Display for Endpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0.display())
    }
}

/// The pipe name a path maps to on Windows.
///
/// Compiled on every platform so the rule can be tested where the suite
/// actually runs. Two properties matter and both are load-bearing:
///
/// - **Deterministic.** The app, gavin-mcp and the daemon each resolve
///   `socket_path()` independently and must land on the same name.
/// - **Case-insensitive.** Windows hands back the same directory under
///   different casing depending on who asked, and two spellings of one
///   path must not become two daemons.
///
/// The whole path is hashed rather than sanitised into the name because
/// pipe names are capped near 256 characters while `%LOCALAPPDATA%` under
/// a long user name plus a tempdir is not. The last component is kept in
/// front of the hash for the sake of anyone reading Process Explorer.
pub fn pipe_name_for_path(path: &Path) -> String {
    let full = path.to_string_lossy().to_lowercase().replace('\\', "/");
    // The last segment is taken off the NORMALISED string rather than
    // from `Path::file_name`, which on a mac sees no separator in
    // `C:\\...` at all and would hand back the whole path -- the same
    // rule has to produce the same name in the suite that runs here and
    // on the Windows machine that uses it.
    let tag: String = full
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .take(24)
        .collect();
    let tag = tag.trim_matches('-').replace("--", "-");
    // FNV-1a, spelled out rather than pulled in: this is not a security
    // boundary (the security descriptor is), it just has to spread paths
    // and be the same number in three processes and in a test.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in full.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    if tag.is_empty() {
        format!(r"\\.\pipe\gavin-{hash:016x}")
    } else {
        format!(r"\\.\pipe\gavin-{tag}-{hash:016x}")
    }
}

#[cfg(unix)]
mod imp {
    use super::*;
    use std::os::unix::net::{UnixListener, UnixStream};

    pub struct Stream(UnixStream);
    pub struct Listener(UnixListener);

    impl Stream {
        pub fn connect_at(endpoint: &Endpoint) -> io::Result<Stream> {
            UnixStream::connect(endpoint.path()).map(Stream)
        }

        pub fn pair() -> io::Result<(Stream, Stream)> {
            let (a, b) = UnixStream::pair()?;
            Ok((Stream(a), Stream(b)))
        }

        pub fn try_clone(&self) -> io::Result<Stream> {
            self.0.try_clone().map(Stream)
        }

        pub fn shutdown(&self, how: Shutdown) -> io::Result<()> {
            self.0.shutdown(how)
        }

        pub fn set_read_timeout(&self, dur: Option<Duration>) -> io::Result<()> {
            self.0.set_read_timeout(dur)
        }

        /// The endpoint this connection was opened against, when there is
        /// one to name. `None` for the accepted (server) side and for a
        /// `pair()`, both of which are unnamed -- see
        /// `send_command_reconnecting`, whose whole design rests on a
        /// test-built pair having no peer to retry against.
        pub fn peer_path(&self) -> Option<PathBuf> {
            self.0.peer_addr().ok()?.as_pathname().map(|p| p.to_path_buf())
        }

        /// The connected socket's descriptor, for the peer-uid check the
        /// daemon makes before it trusts a connection (`peer_uid_ok`).
        /// Unix only, and deliberately not a trait impl: there is no
        /// Windows counterpart to fall back on, because the pipe is
        /// scoped by the DACL `bind_at` builds for it instead.
        pub fn as_raw_fd(&self) -> std::os::unix::io::RawFd {
            std::os::unix::io::AsRawFd::as_raw_fd(&self.0)
        }

        /// The peer's pid, read out of the kernel's record of the
        /// connection. See the cross-platform `server_pid` for what it is
        /// for and why only the connecting side may ask.
        ///
        /// Two spellings because the two unixes never agreed on one:
        /// Linux answers a whole `struct ucred` to `SO_PEERCRED`, macOS
        /// answers a bare pid to `LOCAL_PEERPID` at the `SOL_LOCAL`
        /// level. Both are read at CONNECT time by the kernel, so the
        /// answer names the process that owned the listening socket then
        /// -- not whatever holds the pid now.
        pub(super) fn peer_pid(&self) -> Option<u32> {
            use std::os::unix::io::AsRawFd;
            let fd = self.0.as_raw_fd();
            #[cfg(target_os = "linux")]
            {
                let mut cred = libc::ucred { pid: 0, uid: 0, gid: 0 };
                let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
                // SAFETY: `fd` is a live connected socket for the duration
                // of the call; the pointers are to locals whose sizes are
                // the `len` handed alongside them.
                let rc = unsafe {
                    libc::getsockopt(
                        fd,
                        libc::SOL_SOCKET,
                        libc::SO_PEERCRED,
                        (&mut cred as *mut libc::ucred).cast(),
                        &mut len,
                    )
                };
                if rc != 0 || cred.pid <= 0 {
                    return None;
                }
                Some(cred.pid as u32)
            }
            #[cfg(target_vendor = "apple")]
            {
                // Spelled out rather than taken from `libc` so this arm
                // does not ride on which release first exported them:
                // `SOL_LOCAL` is 0 (sys/socket.h) and `LOCAL_PEERPID` is
                // 0x002 (sys/un.h).
                const SOL_LOCAL: libc::c_int = 0;
                const LOCAL_PEERPID: libc::c_int = 0x002;
                let mut pid: libc::pid_t = 0;
                let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
                // SAFETY: as above.
                let rc = unsafe {
                    libc::getsockopt(
                        fd,
                        SOL_LOCAL,
                        LOCAL_PEERPID,
                        (&mut pid as *mut libc::pid_t).cast(),
                        &mut len,
                    )
                };
                if rc != 0 || pid <= 0 {
                    return None;
                }
                Some(pid as u32)
            }
            // A unix that is neither: no portable spelling, and the
            // caller's contract is already "None means nothing to act on".
            #[cfg(not(any(target_os = "linux", target_vendor = "apple")))]
            {
                let _ = fd;
                None
            }
        }
    }

    impl Stream {
        pub fn read_ref(&self, buf: &mut [u8]) -> io::Result<usize> {
            (&mut &self.0).read(buf)
        }
        pub fn write_ref(&self, buf: &[u8]) -> io::Result<usize> {
            (&mut &self.0).write(buf)
        }
        pub fn flush_ref(&self) -> io::Result<()> {
            (&mut &self.0).flush()
        }
    }

    impl Listener {
        pub fn bind_at(endpoint: &Endpoint) -> io::Result<Listener> {
            let path = endpoint.path();
            // A socket file left by a daemon that was killed rather than
            // stopped. The caller has already established that nothing
            // answers on it (`is_listening`), so it is debris.
            if path.exists() {
                let _ = std::fs::remove_file(path);
            }
            UnixListener::bind(path).map(Listener)
        }

        pub fn accept(&self) -> io::Result<Stream> {
            self.0.accept().map(|(s, _)| Stream(s))
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{
        CloseHandle, LocalFree, ERROR_BROKEN_PIPE, ERROR_FILE_NOT_FOUND, ERROR_IO_PENDING,
        ERROR_MORE_DATA, ERROR_NO_DATA, ERROR_OPERATION_ABORTED, ERROR_PIPE_BUSY,
        ERROR_PIPE_CONNECTED, ERROR_PIPE_NOT_CONNECTED, GENERIC_READ, GENERIC_WRITE, HANDLE,
        HLOCAL, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT, WIN32_ERROR,
    };
    use windows::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SDDL_REVISION_1,
    };
    use windows::Win32::Security::{
        GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
        TOKEN_USER,
    };
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, ReadFile, WriteFile, FILE_FLAG_OVERLAPPED, FILE_SHARE_NONE, OPEN_EXISTING,
        PIPE_ACCESS_DUPLEX,
    };
    use windows::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeServerProcessId, PeekNamedPipe,
        WaitNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
        PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };
    use windows::Win32::System::Threading::{
        CreateEventW, GetCurrentProcess, OpenProcessToken, WaitForSingleObject, INFINITE,
    };
    use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

    /// How long a client keeps asking when the name is not there at all.
    ///
    /// A synchronous pipe server has exactly one instance in the
    /// listening state, and there is a sliver between a client attaching
    /// to it and the accept loop creating its replacement in which the
    /// name resolves to nothing. That window is microseconds wide, but
    /// `ERROR_FILE_NOT_FOUND` is also the answer for "no daemon is
    /// running" -- the one question the app asks before it spawns one --
    /// so the two have to be told apart by waiting rather than by the
    /// error code. Short enough that "not running" is still answered
    /// promptly; long enough to cover a scheduling hiccup in the gap.
    const CONNECT_GAP_GRACE: Duration = Duration::from_millis(50);

    /// The granularity of every wait in here: the gap grace above, and
    /// the read-timeout poll.
    const POLL_INTERVAL: Duration = Duration::from_millis(2);

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn last_error() -> WIN32_ERROR {
        WIN32_ERROR(io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32)
    }

    /// The error code inside an `io::Error` this module built, so a
    /// caller can re-read what `complete` reported. An error minted from
    /// a `Kind` rather than an OS code (the timeout below) carries none,
    /// and 0 matches no arm.
    fn code_of(e: &io::Error) -> WIN32_ERROR {
        WIN32_ERROR(e.raw_os_error().unwrap_or(0) as u32)
    }

    /// One overlapped operation, and the event the kernel signals when it
    /// ends.
    ///
    /// Every read, write and accept gets its own rather than sharing one
    /// per stream: the kernel owns an `OVERLAPPED` until its operation
    /// completes, so a second operation cannot borrow it while the first
    /// is in flight -- and being in flight concurrently is the entire
    /// point of this type existing.
    ///
    /// Boxed so the address handed to the kernel does not move if the
    /// caller's stack frame does.
    struct Op {
        ov: Box<OVERLAPPED>,
        event: HANDLE,
    }

    impl Op {
        /// Manual-reset, so a completion that lands before the wait
        /// starts is still visible to it -- an auto-reset event would let
        /// a fast completion go unnoticed and hang the waiter.
        fn new() -> io::Result<Op> {
            let event = unsafe { CreateEventW(None, true, false, PCWSTR::null()) }
                .map_err(|e| io::Error::from_raw_os_error(e.code().0))?;
            let mut ov = Box::new(OVERLAPPED::default());
            ov.hEvent = event;
            Ok(Op { ov, event })
        }

        fn ptr(&mut self) -> *mut OVERLAPPED {
            &mut *self.ov as *mut OVERLAPPED
        }
    }

    impl Drop for Op {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.event);
            }
        }
    }

    /// Waits out an overlapped operation and reports the bytes it moved.
    ///
    /// `started` is what `ReadFile`/`WriteFile`/`ConnectNamedPipe`
    /// answered. On an overlapped handle they usually report
    /// `ERROR_IO_PENDING` and finish later, but they are allowed to
    /// finish on the spot, and both have to be handled -- a wait that
    /// assumed "pending" would be waiting on an event nobody will set
    /// again.
    ///
    /// A timed-out operation is cancelled and then REAPED with a blocking
    /// `GetOverlappedResult` before this returns. The kernel owns the
    /// `OVERLAPPED` and the caller's buffer until the operation truly
    /// ends; returning while it is still in flight would hand back memory
    /// the kernel is still writing into. A cancel that raced a completion
    /// is reported AS that completion, so a timeout never swallows bytes
    /// that actually arrived.
    fn complete(
        handle: HANDLE,
        op: &mut Op,
        started: windows::core::Result<()>,
        timeout_ms: u32,
    ) -> io::Result<u32> {
        let mut moved: u32 = 0;
        if started.is_err() {
            let err = last_error();
            if err != ERROR_IO_PENDING {
                return Err(io::Error::from_raw_os_error(err.0 as i32));
            }
            let waited = unsafe { WaitForSingleObject(op.event, timeout_ms) };
            if waited == WAIT_TIMEOUT {
                unsafe {
                    let _ = CancelIoEx(handle, Some(op.ptr() as *const OVERLAPPED));
                }
                return match unsafe {
                    GetOverlappedResult(handle, op.ptr() as *const OVERLAPPED, &mut moved, true)
                } {
                    Ok(()) => Ok(moved),
                    Err(_) => match last_error() {
                        ERROR_OPERATION_ABORTED => {
                            Err(io::Error::new(io::ErrorKind::WouldBlock, "read timed out"))
                        }
                        e => Err(io::Error::from_raw_os_error(e.0 as i32)),
                    },
                };
            }
            if waited != WAIT_OBJECT_0 {
                return Err(io::Error::last_os_error());
            }
        }
        match unsafe {
            GetOverlappedResult(handle, op.ptr() as *const OVERLAPPED, &mut moved, false)
        } {
            Ok(()) => Ok(moved),
            Err(_) => match last_error() {
                // Byte-mode pipes do not raise this, but a handle that
                // arrived in message mode would -- and the bytes ARE in
                // the buffer, so it is a short read, not a failure.
                ERROR_MORE_DATA => Ok(moved),
                e => Err(io::Error::from_raw_os_error(e.0 as i32)),
            },
        }
    }

    /// Waits for a client on a listening instance.
    ///
    /// `ConnectNamedPipe` on an overlapped handle must be given an
    /// `OVERLAPPED` -- passing null is an error rather than a blocking
    /// call. `ERROR_PIPE_CONNECTED` still means a client is already
    /// attached, which is success and is the return value everybody gets
    /// wrong; in that arm nothing was queued, so there is nothing to wait
    /// for and the event would never be set.
    fn connect_instance(handle: HANDLE) -> io::Result<()> {
        let mut op = Op::new()?;
        let started = unsafe { ConnectNamedPipe(handle, Some(op.ptr())) };
        if started.is_err() {
            match last_error() {
                // A client is already attached. Nothing was queued, so
                // there is nothing to wait for.
                ERROR_PIPE_CONNECTED => return Ok(()),
                // A client attached and has ALREADY hung up -- it
                // connected and closed before this call got to it. Still
                // an accepted connection: unix hands `accept` a good fd
                // in exactly this case and lets the first read report
                // EOF, which is the contract every connection loop here
                // is written against. Reporting it as a failed accept
                // instead makes `run_server` log a transport fault for a
                // client that merely decided it had nothing to send.
                ERROR_NO_DATA => return Ok(()),
                _ => {}
            }
        }
        match complete(handle, &mut op, started, INFINITE) {
            // The same hang-up, arriving on the completion rather than on
            // the call itself -- which of the two it is depends on how
            // the client's close raced this thread.
            Err(e) if code_of(&e) == ERROR_NO_DATA => Ok(()),
            other => other.map(|_| ()),
        }
    }

    /// A pipe handle and the state a Unix socket keeps inside the kernel.
    ///
    /// Shared through an `Arc` rather than duplicated per clone, because
    /// `try_clone` on a `UnixStream` hands back a second descriptor onto
    /// ONE socket: a read timeout set through either is set for both, and
    /// a `shutdown` through either unblocks a reader sitting in the
    /// other. `DuplicateHandle` would give two independent handles and
    /// quietly break both of those, and `server.rs` uses each of them.
    struct Inner {
        handle: HANDLE,
        read_timeout_ms: AtomicU32,
        read_closed: AtomicBool,
        peer: Option<PathBuf>,
    }

    // The handle is only ever passed to Win32 calls that are documented
    // as safe from any thread; ownership is the Arc's.
    unsafe impl Send for Inner {}
    unsafe impl Sync for Inner {}

    impl Drop for Inner {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.handle);
            }
        }
    }

    pub struct Stream(Arc<Inner>);

    impl Stream {
        fn wrap(handle: HANDLE, peer: Option<PathBuf>) -> Stream {
            Stream(Arc::new(Inner {
                handle,
                read_timeout_ms: AtomicU32::new(0),
                read_closed: AtomicBool::new(false),
                peer,
            }))
        }

        pub fn connect_at(endpoint: &Endpoint) -> io::Result<Stream> {
            let name = pipe_name_for_path(endpoint.path());
            let wide_name = wide(&name);
            let deadline = Instant::now() + CONNECT_GAP_GRACE;
            loop {
                let handle = unsafe {
                    CreateFileW(
                        PCWSTR(wide_name.as_ptr()),
                        GENERIC_READ.0 | GENERIC_WRITE.0,
                        FILE_SHARE_NONE,
                        None,
                        OPEN_EXISTING,
                        FILE_FLAG_OVERLAPPED,
                        None,
                    )
                };
                match handle {
                    Ok(h) => {
                        return Ok(Stream::wrap(h, Some(endpoint.path().to_path_buf())));
                    }
                    Err(_) => {
                        let err = last_error();
                        if err == ERROR_PIPE_BUSY {
                            // Every instance is serving someone. This is
                            // the ordinary busy case and the OS has a
                            // primitive for it.
                            unsafe {
                                let _ = WaitNamedPipeW(PCWSTR(wide_name.as_ptr()), 2000);
                            }
                            continue;
                        }
                        if err == ERROR_FILE_NOT_FOUND && Instant::now() < deadline {
                            std::thread::sleep(POLL_INTERVAL);
                            continue;
                        }
                        return Err(io::Error::from_raw_os_error(err.0 as i32));
                    }
                }
            }
        }

        /// Two connected ends with no name anyone else can reach.
        ///
        /// `UnixStream::pair()` is one syscall; a pipe has to be built.
        /// The name is unique per call and the instance limit is one, so
        /// the window in which a stranger could open it is the two lines
        /// between creating it and connecting to it, and only for a
        /// process that guessed the counter. Both ends report no peer
        /// path, exactly as an unnamed socket pair does.
        pub fn pair() -> io::Result<(Stream, Stream)> {
            use std::sync::atomic::AtomicU64;
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let name = format!(
                r"\\.\pipe\gavin-pair-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            );
            let wide_name = wide(&name);
            let sd = SecurityDescriptor::current_user_only()?;
            let server = unsafe {
                CreateNamedPipeW(
                    PCWSTR(wide_name.as_ptr()),
                    PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                    1,
                    PIPE_BUFFER_BYTES,
                    PIPE_BUFFER_BYTES,
                    0,
                    Some(sd.attributes()),
                )
            };
            if server == INVALID_HANDLE_VALUE {
                return Err(io::Error::from_raw_os_error(last_error().0 as i32));
            }
            let client = unsafe {
                CreateFileW(
                    PCWSTR(wide_name.as_ptr()),
                    GENERIC_READ.0 | GENERIC_WRITE.0,
                    FILE_SHARE_NONE,
                    None,
                    OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED,
                    None,
                )
            };
            let client = match client {
                Ok(h) => h,
                Err(e) => {
                    unsafe {
                        let _ = CloseHandle(server);
                    }
                    return Err(io::Error::from_raw_os_error(e.code().0));
                }
            };
            // The client is already attached, so this reports
            // ERROR_PIPE_CONNECTED rather than success -- which IS the
            // success case, and is the one return value of
            // ConnectNamedPipe everybody gets wrong.
            if let Err(e) = connect_instance(server) {
                unsafe {
                    let _ = CloseHandle(server);
                    let _ = CloseHandle(client);
                }
                return Err(e);
            }
            Ok((Stream::wrap(client, None), Stream::wrap(server, None)))
        }

        pub fn try_clone(&self) -> io::Result<Stream> {
            Ok(Stream(Arc::clone(&self.0)))
        }

        /// Unblocks whoever is reading, and makes every later read report
        /// end of stream.
        ///
        /// `CancelIoEx` with a null overlapped pointer cancels the I/O
        /// any thread of this process has outstanding on the handle,
        /// which is what makes this reach the reader rather than only the
        /// caller -- the single reason the handle is shared rather than
        /// duplicated. The write half has no separate close on a pipe:
        /// the peer sees the end when the last handle goes.
        pub fn shutdown(&self, how: Shutdown) -> io::Result<()> {
            if matches!(how, Shutdown::Read | Shutdown::Both) {
                self.0.read_closed.store(true, Ordering::SeqCst);
            }
            unsafe {
                let _ = CancelIoEx(self.0.handle, None);
            }
            Ok(())
        }

        pub fn set_read_timeout(&self, dur: Option<Duration>) -> io::Result<()> {
            let ms = match dur {
                None => 0,
                Some(d) if d.is_zero() => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "cannot set a zero duration",
                    ))
                }
                Some(d) => d.as_millis().min(u32::MAX as u128 - 1) as u32,
            };
            self.0.read_timeout_ms.store(ms, Ordering::SeqCst);
            Ok(())
        }

        pub fn peer_path(&self) -> Option<PathBuf> {
            self.0.peer.clone()
        }

        /// The pid of the process serving this pipe. See the
        /// cross-platform `server_pid` for what it is for.
        ///
        /// `GetNamedPipeServerProcessId` answers for the SERVER end
        /// whichever end asks, so on an accepted handle it names this
        /// process -- which is why the wrapper refuses to ask there.
        pub(super) fn peer_pid(&self) -> Option<u32> {
            let mut pid = 0u32;
            // SAFETY: the handle is a live pipe owned by this `Inner`,
            // and the only pointer is to a local `u32` the call writes.
            unsafe { GetNamedPipeServerProcessId(self.0.handle, &mut pid) }.ok()?;
            (pid != 0).then_some(pid)
        }
    }

    impl Stream {
        pub fn read_ref(&self, buf: &mut [u8]) -> io::Result<usize> {
            if self.0.read_closed.load(Ordering::SeqCst) {
                return Ok(0);
            }
            let timeout = self.0.read_timeout_ms.load(Ordering::SeqCst);
            if timeout > 0 {
                // A pipe has no SO_RCVTIMEO. Peeking costs one call and
                // never consumes, so the wait can be spelled as polling
                // without an overlapped read to cancel afterwards. The
                // deadline reports WouldBlock, which is the errno a
                // timed-out socket read gives and the one every caller
                // here was written against.
                let deadline = Instant::now() + Duration::from_millis(timeout as u64);
                loop {
                    if self.0.read_closed.load(Ordering::SeqCst) {
                        return Ok(0);
                    }
                    let mut available: u32 = 0;
                    let peeked = unsafe {
                        PeekNamedPipe(
                            self.0.handle,
                            None,
                            0,
                            None,
                            Some(&mut available),
                            None,
                        )
                    };
                    if peeked.is_err() {
                        return match last_error() {
                            ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED => Ok(0),
                            e => Err(io::Error::from_raw_os_error(e.0 as i32)),
                        };
                    }
                    if available > 0 {
                        break;
                    }
                    if Instant::now() >= deadline {
                        return Err(io::Error::new(
                            io::ErrorKind::WouldBlock,
                            "read timed out",
                        ));
                    }
                    std::thread::sleep(POLL_INTERVAL);
                }
            }
            let mut op = Op::new()?;
            let started = unsafe { ReadFile(self.0.handle, Some(buf), None, Some(op.ptr())) };
            match complete(self.0.handle, &mut op, started, INFINITE) {
                Ok(read) => Ok(read as usize),
                Err(e) => match code_of(&e) {
                    // The peer closed its last handle. A socket answers
                    // this with a zero-length read, and `read_message`
                    // turns THAT into the `Ok(None)` every connection
                    // loop breaks on -- so an error here would turn every
                    // ordinary disconnect into a logged failure.
                    ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED => Ok(0),
                    // `shutdown` cancelled this read. That is the end of
                    // stream a shut-down socket reports, and the flag is
                    // what tells it apart from any other cancellation.
                    ERROR_OPERATION_ABORTED if self.0.read_closed.load(Ordering::SeqCst) => Ok(0),
                    _ => Err(e),
                },
            }
        }
    }

    impl Stream {
        pub fn write_ref(&self, buf: &[u8]) -> io::Result<usize> {
            let mut op = Op::new()?;
            let started = unsafe { WriteFile(self.0.handle, Some(buf), None, Some(op.ptr())) };
            match complete(self.0.handle, &mut op, started, INFINITE) {
                Ok(written) => Ok(written as usize),
                Err(e) => match code_of(&e) {
                    ERROR_BROKEN_PIPE | ERROR_NO_DATA | ERROR_PIPE_NOT_CONNECTED => Err(
                        io::Error::new(io::ErrorKind::BrokenPipe, "the peer closed the pipe"),
                    ),
                    _ => Err(e),
                },
            }
        }

        /// Deliberately not `FlushFileBuffers`.
        ///
        /// On a pipe that call blocks until the peer has READ everything
        /// outstanding, so a daemon flushing a push to a client that is
        /// mid-render would stall the thread that pushed it. Nothing is
        /// buffered on this side -- `write` hands the bytes to the kernel
        /// -- so there is nothing for a flush to do.
        pub fn flush_ref(&self) -> io::Result<()> {
            Ok(())
        }
    }

    /// The in-kernel buffer each direction of a pipe instance gets.
    ///
    /// A hint, not a limit: a write larger than this blocks until the
    /// reader drains it rather than failing. Sized to hold a terminal
    /// output push comfortably so the common case never round-trips.
    const PIPE_BUFFER_BYTES: u32 = 64 * 1024;

    /// "Only the user running this process, and SYSTEM."
    ///
    /// The default descriptor a pipe gets from a null
    /// `SECURITY_ATTRIBUTES` grants READ to Everyone, which on a shared
    /// machine would let any local account open the daemon's pipe and
    /// read every push on it -- session output included. There is no
    /// per-user pipe namespace to hide in (the named-pipe namespace is
    /// machine-global), so the scoping has to be a DACL, and this is it.
    struct SecurityDescriptor {
        sd: PSECURITY_DESCRIPTOR,
        attrs: SECURITY_ATTRIBUTES,
    }

    impl SecurityDescriptor {
        fn current_user_only() -> io::Result<SecurityDescriptor> {
            let sid = current_user_sid_string()?;
            // GA (all access) to the running user and to SYSTEM, and the
            // P makes it protected so nothing is inherited in beside it.
            let sddl = wide(&format!("D:P(A;;GA;;;SY)(A;;GA;;;{sid})"));
            let mut sd = PSECURITY_DESCRIPTOR::default();
            unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    PCWSTR(sddl.as_ptr()),
                    SDDL_REVISION_1,
                    &mut sd,
                    None,
                )
                .map_err(|e| io::Error::from_raw_os_error(e.code().0))?;
            }
            let attrs = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: sd.0,
                bInheritHandle: false.into(),
            };
            Ok(SecurityDescriptor { sd, attrs })
        }

        fn attributes(&self) -> *const SECURITY_ATTRIBUTES {
            &self.attrs as *const SECURITY_ATTRIBUTES
        }
    }

    impl Drop for SecurityDescriptor {
        fn drop(&mut self) {
            if !self.sd.is_invalid() {
                unsafe {
                    let _ = LocalFree(Some(HLOCAL(self.sd.0)));
                }
            }
        }
    }

    unsafe impl Send for SecurityDescriptor {}
    unsafe impl Sync for SecurityDescriptor {}

    fn current_user_sid_string() -> io::Result<String> {
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
                .map_err(|e| io::Error::from_raw_os_error(e.code().0))?;
            let mut needed: u32 = 0;
            let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
            let mut buf = vec![0u8; needed.max(1) as usize];
            let got = GetTokenInformation(
                token,
                TokenUser,
                Some(buf.as_mut_ptr() as *mut std::ffi::c_void),
                needed,
                &mut needed,
            );
            let _ = CloseHandle(token);
            got.map_err(|e| io::Error::from_raw_os_error(e.code().0))?;
            let user = &*(buf.as_ptr() as *const TOKEN_USER);
            let mut out = windows::core::PWSTR::null();
            ConvertSidToStringSidW(user.User.Sid, &mut out)
                .map_err(|e| io::Error::from_raw_os_error(e.code().0))?;
            let s = out.to_string().unwrap_or_default();
            let _ = LocalFree(Some(HLOCAL(out.0 as *mut _)));
            if s.is_empty() {
                return Err(io::Error::other("could not read this process's user SID"));
            }
            Ok(s)
        }
    }

    pub struct Listener {
        wide_name: Vec<u16>,
        sd: SecurityDescriptor,
        /// The instance currently in the listening state. A synchronous
        /// pipe server has exactly one, and `accept` replaces it as soon
        /// as a client takes it -- see `CONNECT_GAP_GRACE` for the sliver
        /// between those two moments and what the client side does about
        /// it.
        waiting: Mutex<Option<HANDLE>>,
    }

    unsafe impl Send for Listener {}
    unsafe impl Sync for Listener {}

    impl Listener {
        pub fn bind_at(endpoint: &Endpoint) -> io::Result<Listener> {
            let wide_name = wide(&pipe_name_for_path(endpoint.path()));
            let sd = SecurityDescriptor::current_user_only()?;
            let first = create_instance(&wide_name, &sd)?;
            Ok(Listener { wide_name, sd, waiting: Mutex::new(Some(first)) })
        }

        pub fn accept(&self) -> io::Result<Stream> {
            let handle = {
                let mut slot = self.waiting.lock().unwrap();
                match slot.take() {
                    Some(h) => h,
                    None => create_instance(&self.wide_name, &self.sd)?,
                }
            };
            if let Err(e) = connect_instance(handle) {
                unsafe {
                    let _ = CloseHandle(handle);
                }
                return Err(e);
            }
            match create_instance(&self.wide_name, &self.sd) {
                Ok(next) => *self.waiting.lock().unwrap() = Some(next),
                // Out of instances or out of handles: the connection just
                // accepted is still good, and the next accept will try
                // again rather than lose it.
                Err(_) => *self.waiting.lock().unwrap() = None,
            }
            Ok(Stream::wrap(handle, None))
        }
    }

    impl Drop for Listener {
        fn drop(&mut self) {
            if let Some(h) = self.waiting.lock().unwrap().take() {
                unsafe {
                    let _ = CloseHandle(h);
                }
            }
        }
    }

    /// `CreateNamedPipeW` is one of the Win32 calls that answers with
    /// `INVALID_HANDLE_VALUE` rather than a `Result`, so the failure has
    /// to be read off `GetLastError` -- via `io::Error::last_os_error`,
    /// which is the same thing and already the right type.
    fn create_instance(wide_name: &[u16], sd: &SecurityDescriptor) -> io::Result<HANDLE> {
        let handle = unsafe {
            CreateNamedPipeW(
                PCWSTR(wide_name.as_ptr()),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                PIPE_BUFFER_BYTES,
                PIPE_BUFFER_BYTES,
                0,
                Some(sd.attributes()),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        Ok(handle)
    }
}

pub use imp::{Listener, Stream};

// Both `Stream` and `&Stream`, because `UnixStream` offers both and the
// call sites use both: `BufReader::new(stream.try_clone()?)` owns its
// end, while `write_message(&mut &stream, ...)` borrows one that a
// `Mutex` or an `Arc` is holding. Every operation is `&self` underneath
// -- a socket, and the pipe handle behind the Windows arm, is shared
// state the kernel serialises, not something this type has to own
// mutably.
impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.read_ref(buf)
    }
}

impl Read for &Stream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.read_ref(buf)
    }
}

impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.write_ref(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.flush_ref()
    }
}

impl Write for &Stream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.write_ref(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.flush_ref()
    }
}

impl Stream {
    /// Takes anything a call site already holds -- a `&Path`, a
    /// `PathBuf`, an `Endpoint` -- so porting a call site is changing the
    /// type name and nothing else.
    pub fn connect(endpoint: impl Into<Endpoint>) -> io::Result<Stream> {
        Stream::connect_at(&endpoint.into())
    }

    /// Which process is serving the endpoint this stream was connected
    /// to -- the daemon's pid, asked of the kernel rather than of a
    /// process list.
    ///
    /// This is the only honest way to address "the daemon on THIS
    /// socket". A name is not one: `taskkill /IM gavin-daemon.exe` and
    /// `pkill -x gavin-daemon` reach every daemon on the machine, which
    /// is how `cargo test -p app` used to take down the one holding a
    /// human's sessions, and how Restart daemon in the dev app used to
    /// take the stable app's with it.
    ///
    /// Only the CONNECTING side may ask. An accepted stream and a
    /// `pair()` are unnamed -- they have no endpoint they reached for --
    /// and the platform primitives answer something different or
    /// something useless for them, so both get `None`. `peer_path` is
    /// already exactly that distinction, so it is the gate.
    ///
    /// `None` also covers "the kernel would not say", and every caller
    /// must treat it as "no process to act on" rather than falling back
    /// to a broader guess -- a broader guess is the bug this replaces.
    pub fn server_pid(&self) -> Option<u32> {
        self.peer_path()?;
        self.peer_pid()
    }
}

impl Listener {
    pub fn bind(endpoint: impl Into<Endpoint>) -> io::Result<Listener> {
        Listener::bind_at(&endpoint.into())
    }

    /// The blocking accept loop, in the shape `UnixListener::incoming`
    /// already gave `run_server`.
    pub fn incoming(&self) -> Incoming<'_> {
        Incoming { listener: self }
    }
}

pub struct Incoming<'a> {
    listener: &'a Listener,
}

impl Iterator for Incoming<'_> {
    type Item = io::Result<Stream>;
    fn next(&mut self) -> Option<io::Result<Stream>> {
        Some(self.listener.accept())
    }
}

/// Whether something is already answering on this endpoint.
///
/// The question `run_server` asks before it binds, and the only honest
/// way to ask it: on Unix a socket FILE outlives the process that made
/// it, and on Windows a pipe name resolving to nothing and a pipe name
/// whose server is mid-handoff are the same error code. Connecting is
/// what tells the two apart, on both.
pub fn is_listening(endpoint: &Endpoint) -> bool {
    Stream::connect(endpoint).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pipe_name_is_the_same_for_two_spellings_of_one_path() {
        let a = pipe_name_for_path(Path::new(r"C:\Users\Ada\AppData\Local\gavin\daemon.sock"));
        let b = pipe_name_for_path(Path::new(r"c:\users\ada\appdata\local\GAVIN\daemon.sock"));
        let c = pipe_name_for_path(Path::new("C:/Users/Ada/AppData/Local/gavin/daemon.sock"));
        assert_eq!(a, b, "Windows paths differ only in case, so the pipes must not");
        assert_eq!(a, c, "a forward-slash spelling of one path is that path");
    }

    #[test]
    fn two_data_directories_get_two_pipes() {
        let ada = pipe_name_for_path(Path::new(r"C:\Users\Ada\AppData\Local\gavin\daemon.sock"));
        let bob = pipe_name_for_path(Path::new(r"C:\Users\Bob\AppData\Local\gavin\daemon.sock"));
        assert_ne!(ada, bob, "two users on one machine must not share a daemon");
    }

    #[test]
    fn a_pipe_name_is_in_the_pipe_namespace_and_readable() {
        let name = pipe_name_for_path(Path::new(r"C:\Users\Ada\AppData\Local\gavin\daemon.sock"));
        assert!(name.starts_with(r"\\.\pipe\gavin-"), "{name}");
        assert!(name.contains("daemon-sock"), "the last component survives for a human: {name}");
        // Comfortably inside the ~256-character cap, whatever the path was.
        assert!(name.len() < 64, "{name}");
    }

    #[test]
    fn an_endless_path_still_yields_a_short_name() {
        let long = format!(r"C:\{}\daemon.sock", "x".repeat(4000));
        let name = pipe_name_for_path(Path::new(&long));
        assert!(name.len() < 64, "{name}");
    }

    #[test]
    fn a_pair_carries_bytes_both_ways_and_names_no_peer() {
        let (mut a, mut b) = Stream::pair().unwrap();
        a.write_all(b"ping\n").unwrap();
        a.flush().unwrap();
        let mut buf = [0u8; 5];
        b.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"ping\n");
        b.write_all(b"pong\n").unwrap();
        b.flush().unwrap();
        let mut back = [0u8; 5];
        a.read_exact(&mut back).unwrap();
        assert_eq!(&back, b"pong\n");
        // What send_command_reconnecting's fallback branch depends on.
        assert_eq!(a.peer_path(), None);
        assert_eq!(b.peer_path(), None);
    }

    #[test]
    fn a_read_timeout_reports_would_block_rather_than_hanging() {
        let (mut a, _b) = Stream::pair().unwrap();
        a.set_read_timeout(Some(Duration::from_millis(80))).unwrap();
        let mut buf = [0u8; 8];
        let err = a.read(&mut buf).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::WouldBlock, "{err}");
    }

    #[test]
    fn a_closed_peer_reads_as_end_of_stream() {
        let (mut a, b) = Stream::pair().unwrap();
        drop(b);
        let mut buf = [0u8; 8];
        assert_eq!(a.read(&mut buf).unwrap(), 0, "read_message turns this into Ok(None)");
    }

    /// A client that connects and hangs up before the server gets to
    /// `accept` is still a connection, and its end-of-stream belongs to
    /// the READ -- not to `accept` reporting a failure.
    ///
    /// On unix `accept` hands back a perfectly good fd here and the
    /// first read is EOF, which is the contract every connection loop in
    /// gavin is written against: accept, then read until `Ok(None)`.
    /// Windows completes `ConnectNamedPipe` with `ERROR_NO_DATA` ("the
    /// pipe is being closed") instead, and reporting THAT as an accept
    /// failure is a difference no caller is written for -- `run_server`
    /// logs a failed accept, and a client that merely decided it had
    /// nothing to send looks like a transport fault.
    ///
    /// `Listener::bind` has an instance waiting before any `accept`
    /// call, which is what lets the client come and go first and makes
    /// this deterministic rather than a race.
    #[test]
    fn a_client_that_hangs_up_before_accept_is_still_accepted() {
        let dir = std::env::temp_dir().join(format!("gavin-transport-eof-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let endpoint = Endpoint::new(dir.join("eof.sock"));
        let listener = Listener::bind(&endpoint).unwrap();

        // Connected and gone before anybody accepts.
        drop(Stream::connect(&endpoint).unwrap());

        let mut server = listener.accept().expect("a hung-up client is still a connection");
        let mut buf = [0u8; 8];
        assert_eq!(
            server.read(&mut buf).unwrap(),
            0,
            "and its disconnect is end-of-stream on the read, which is what read_message turns into Ok(None)"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_clone_shares_one_connection() {
        let (a, mut b) = Stream::pair().unwrap();
        let mut writer = a.try_clone().unwrap();
        writer.write_all(b"shared\n").unwrap();
        writer.flush().unwrap();
        let mut buf = [0u8; 7];
        b.read_exact(&mut buf).unwrap();
        assert_eq!(&buf, b"shared\n");
    }

    #[test]
    fn a_listener_answers_a_connect_and_the_accepted_side_has_no_peer_path() {
        let dir = std::env::temp_dir().join(format!("gavin-transport-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.sock");
        let endpoint = Endpoint::new(path.clone());
        let listener = Listener::bind(&endpoint).unwrap();
        let server = std::thread::spawn(move || {
            let mut s = listener.accept().unwrap();
            assert_eq!(s.peer_path(), None, "an accepted connection is unnamed on both platforms");
            let mut buf = [0u8; 3];
            s.read_exact(&mut buf).unwrap();
            s.write_all(b"ok\n").unwrap();
            s.flush().unwrap();
        });
        let mut client = Stream::connect(&endpoint).unwrap();
        assert_eq!(client.peer_path(), Some(path.clone()));
        client.write_all(b"hi\n").unwrap();
        client.flush().unwrap();
        let mut back = [0u8; 3];
        client.read_exact(&mut back).unwrap();
        assert_eq!(&back, b"ok\n");
        server.join().unwrap();
        drop(client);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The whole point of `server_pid`: the connection itself names the
    /// process serving it, so a caller that wants to stop THAT daemon
    /// never has to ask the machine for everything called gavin-daemon.
    ///
    /// The listener here is bound in-process, so the pid the kernel
    /// reports back is one the test already knows.
    #[test]
    fn a_connection_names_the_process_serving_the_endpoint() {
        let dir = std::env::temp_dir().join(format!("gavin-transport-pid-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let endpoint = Endpoint::new(dir.join("owner.sock"));
        let listener = Listener::bind(&endpoint).unwrap();
        let accepted = std::thread::spawn(move || listener.accept().unwrap());

        let client = Stream::connect(&endpoint).unwrap();
        assert_eq!(
            client.server_pid(),
            Some(std::process::id()),
            "this process bound the endpoint, so this process is what stopping it would reach"
        );

        // The other side has no endpoint it reached for, and the platform
        // primitives answer something else entirely there -- the peer's
        // pid on unix, this process's own on Windows. Neither is "who
        // serves this socket", so the answer is that there is none.
        let server = accepted.join().unwrap();
        assert_eq!(server.server_pid(), None, "an accepted connection names no server");
        let (a, _b) = Stream::pair().unwrap();
        assert_eq!(a.server_pid(), None, "nor does a pair");

        drop(client);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Separate from the round-trip test above on purpose: probing IS a
    /// connection, and a listener that accepted the probe would be
    /// answering it instead of the client that came next.
    #[test]
    fn is_listening_answers_yes_once_something_has_bound() {
        let dir = std::env::temp_dir().join(format!("gavin-transport-up-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let endpoint = Endpoint::new(dir.join("up.sock"));
        assert!(!is_listening(&endpoint));
        let _listener = Listener::bind(&endpoint).unwrap();
        assert!(is_listening(&endpoint));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_is_listening_on_a_path_no_one_bound() {
        let dir = std::env::temp_dir().join(format!("gavin-transport-none-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let endpoint = Endpoint::new(dir.join("never.sock"));
        assert!(!is_listening(&endpoint));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A push must not wait on a read that only the peer can end.
    ///
    /// This is the shape `server.rs` runs all day: the connection thread
    /// parks in `read` waiting for the next request, while another thread
    /// writes an unsolicited push through a `try_clone` of the same
    /// stream (the `Arc<Mutex<Stream>>` writer). A Unix socket is full
    /// duplex, so it has always worked there.
    ///
    /// A Windows pipe handle opened without `FILE_FLAG_OVERLAPPED` is
    /// synchronous, and the kernel serialises every operation on a
    /// synchronous handle: the write queues behind the read and never
    /// returns. It queues holding the writer mutex besides, so the first
    /// push wedges every later one -- which is a hung app, not a slow one.
    ///
    /// Guarded by a timeout rather than left to deadlock: a test that
    /// hangs reports nothing and takes the suite with it.
    #[test]
    fn a_push_completes_while_another_thread_is_parked_in_read() {
        let (client, server) = Stream::pair().unwrap();
        let parked_on = server.try_clone().unwrap();

        // Nothing is ever sent to this end, exactly as when the app is
        // idle and the daemon is waiting for its next request.
        let parked = std::thread::spawn(move || {
            let mut buf = [0u8; 1];
            let _ = parked_on.read_ref(&mut buf);
        });
        // Let the reader reach the kernel before the write is issued --
        // the ordering the bug needs, and the one the daemon always has.
        std::thread::sleep(Duration::from_millis(200));

        let (tx, rx) = std::sync::mpsc::channel();
        let pusher = std::thread::spawn(move || {
            let _ = tx.send(server.write_ref(b"push\n"));
        });

        let wrote = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the push deadlocked behind a parked reader on the same handle");
        assert_eq!(wrote.unwrap(), 5);

        // Drop the far end so the parked reader sees the pipe close and
        // this test leaves no thread behind.
        drop(client);
        let _ = pusher.join();
        let _ = parked.join();
    }
}
