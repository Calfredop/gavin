/// Why the core stopped.
///
/// An enum rather than a string, because each one is a different thing
/// for the Companion to say to the human holding it: a QR that did not
/// scan cleanly is not a Workstation that turned out to be someone
/// else's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoreError {
    /// The pairing QR does not hold what a pairing needs.
    Offer(String),
    /// The entropy the caller supplied ran out.
    Entropy,
    /// The Workstation that answered is not the one whose QR was scanned.
    /// The pairing secret was not used.
    WrongWorkstation,
    /// The hardware public key the shell handed in is not one.
    HardwareKey(String),
    /// The Noise handshake failed.
    Handshake(String),
    /// A frame that could not be opened or read. The connection it
    /// arrived on is over: see `channel::Channel`.
    Frame(String),
    /// Asked for something the exchange has not reached, or is past: a
    /// proof before there is a handshake to prove, a message before the
    /// Workstation has said the Device is connected.
    NotReady,
    /// Bytes arrived after the exchange had ended.
    Finished,
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CoreError::Offer(why) => write!(f, "this pairing code cannot be used: {why}"),
            CoreError::Entropy => write!(f, "not enough randomness was supplied"),
            CoreError::WrongWorkstation => write!(
                f,
                "this is not the Workstation whose code was scanned — the pairing was abandoned"
            ),
            CoreError::HardwareKey(why) => {
                write!(f, "this Device's hardware key cannot be used: {why}")
            }
            CoreError::Handshake(why) => {
                write!(f, "the handshake with the Workstation failed: {why}")
            }
            CoreError::Frame(why) => write!(f, "a message from the Workstation could not be read: {why}"),
            CoreError::NotReady => write!(f, "the exchange with the Workstation is not at that point"),
            CoreError::Finished => write!(f, "the exchange with the Workstation has already ended"),
        }
    }
}

impl std::error::Error for CoreError {}
