//! Frames: how bytes on a stream become messages, and how a message is
//! sealed into the channel a handshake left behind.
//!
//! Every message on the Device wire, handshake or not, travels as two
//! bytes of big-endian length and then that many bytes -- the framing the
//! daemon's `pairing.rs` reads. A transport delivers bytes and not frames,
//! so what arrives is collected in an `Inbox` until a whole frame is
//! there. After the handshake each frame is one Noise transport message,
//! padded first (`protocol::device_wire`), and a `Channel` is what seals
//! and opens them.

use crate::CoreError;
use protocol::device_wire::{self, FRAME_BUCKET};

/// The largest Noise message, and so the largest frame.
pub(crate) const MAX_NOISE_MESSAGE: usize = 65535;

/// The two bytes of big-endian length in front of every frame.
pub(crate) const LENGTH_PREFIX: usize = 2;

/// Two bytes of big-endian length, then the message. A Noise message
/// cannot outgrow the prefix -- both stop at 65535.
pub(crate) fn frame(message: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(LENGTH_PREFIX + message.len());
    out.extend_from_slice(&(message.len() as u16).to_be_bytes());
    out.extend_from_slice(message);
    out
}

/// The most an `Inbox` keeps once everything whole has been taken out
/// of it: two frames' worth. One is a frame that has not finished
/// arriving; the second is room for what arrives while nothing is being
/// read -- the hardware is signing -- which by rights is one verdict.
pub(crate) const MAX_KEPT: usize = 2 * (LENGTH_PREFIX + MAX_NOISE_MESSAGE);

/// Bytes that have arrived and not yet been read as frames.
#[derive(Default)]
pub(crate) struct Inbox {
    bytes: Vec<u8>,
}

impl Inbox {
    pub(crate) fn push(&mut self, bytes: &[u8]) {
        self.bytes.extend_from_slice(bytes);
    }

    /// Whether what is left, now that everything whole has been taken
    /// out, is within what an inbox keeps. What is sending it is the
    /// Relay, and a Device's memory is not the Relay's to fill.
    pub(crate) fn within_bounds(&self) -> Result<(), CoreError> {
        if self.bytes.len() > MAX_KEPT {
            return Err(CoreError::Frame(format!(
                "more arrived than was asked for: {} bytes are waiting to be read",
                self.bytes.len()
            )));
        }
        Ok(())
    }

    /// The next whole frame, without its length prefix, if one has
    /// arrived.
    pub(crate) fn next_frame(&mut self) -> Option<Vec<u8>> {
        if self.bytes.len() < LENGTH_PREFIX {
            return None;
        }
        let len = u16::from_be_bytes([self.bytes[0], self.bytes[1]]) as usize;
        if self.bytes.len() < LENGTH_PREFIX + len {
            return None;
        }
        let message = self.bytes[LENGTH_PREFIX..LENGTH_PREFIX + len].to_vec();
        self.bytes.drain(..LENGTH_PREFIX + len);
        Some(message)
    }

    pub(crate) fn clear(&mut self) {
        self.bytes.clear();
    }
}

/// The encrypted channel a completed handshake left behind.
///
/// Each direction counts its own messages, and the count is the nonce: a
/// frame opens only as the next one its sender sealed. One that was
/// altered, repeated, dropped or moved does not open, and the caller ends
/// the connection -- there is no frame to skip to, because every frame
/// after it would be read against the wrong count.
pub(crate) struct Channel {
    transport: snow::TransportState,
}

impl Channel {
    pub(crate) fn new(transport: snow::TransportState) -> Self {
        Self { transport }
    }

    /// One payload as one padded frame, length prefix included.
    pub(crate) fn seal(&mut self, payload: &[u8]) -> Result<Vec<u8>, CoreError> {
        let plaintext =
            device_wire::pad(payload).map_err(|e| CoreError::Frame(e.to_string()))?;
        let mut message = vec![0u8; MAX_NOISE_MESSAGE];
        let n = self
            .transport
            .write_message(&plaintext, &mut message)
            .map_err(|e| CoreError::Frame(format!("{e:?}")))?;
        Ok(frame(&message[..n]))
    }

    /// The payload inside one frame, as `Inbox::next_frame` returned it.
    pub(crate) fn open(&mut self, message: &[u8]) -> Result<Vec<u8>, CoreError> {
        // Every frame this wire carries after a handshake is a whole
        // number of buckets. One that is not was not sealed by the other
        // end, so there is nothing in it to try.
        if (LENGTH_PREFIX + message.len()) % FRAME_BUCKET != 0 {
            return Err(CoreError::Frame(format!(
                "a frame of {} bytes is not a whole number of {FRAME_BUCKET}-byte buckets",
                LENGTH_PREFIX + message.len()
            )));
        }
        let mut plaintext = vec![0u8; MAX_NOISE_MESSAGE];
        let n = self
            .transport
            .read_message(message, &mut plaintext)
            .map_err(|e| CoreError::Frame(format!("{e:?}")))?;
        let payload =
            device_wire::unpad(&plaintext[..n]).map_err(|e| CoreError::Frame(e.to_string()))?;
        Ok(payload.to_vec())
    }
}

#[cfg(test)]
pub(crate) mod testing {
    use super::*;

    /// The one frame in `bytes`, without its length prefix.
    pub(crate) fn unframe(bytes: &[u8]) -> &[u8] {
        let len = u16::from_be_bytes([bytes[0], bytes[1]]) as usize;
        assert_eq!(bytes.len(), LENGTH_PREFIX + len, "one frame, whole");
        &bytes[LENGTH_PREFIX..]
    }

    /// The frames in `bytes`, each without its length prefix.
    pub(crate) fn unframe_all(bytes: &[u8]) -> Vec<Vec<u8>> {
        let mut inbox = Inbox::default();
        inbox.push(bytes);
        let mut frames = Vec::new();
        while let Some(frame) = inbox.next_frame() {
            frames.push(frame);
        }
        assert!(inbox.bytes.is_empty(), "{} bytes after the last frame", inbox.bytes.len());
        frames
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{noise, Entropy};

    /// Two ends of one channel, from a handshake with nothing in it that
    /// matters here.
    fn channels() -> (Channel, Channel) {
        let params: snow::params::NoiseParams = "Noise_NN_25519_ChaChaPoly_BLAKE2s".parse().unwrap();
        let mut a = noise::builder(params.clone(), Entropy::from_bytes(vec![1; 32]))
            .build_initiator()
            .unwrap();
        let mut b =
            noise::builder(params, Entropy::from_bytes(vec![2; 32])).build_responder().unwrap();
        let mut wire = vec![0u8; 1024];
        let mut payload = vec![0u8; 1024];
        let n = a.write_message(&[], &mut wire).unwrap();
        b.read_message(&wire[..n], &mut payload).unwrap();
        let n = b.write_message(&[], &mut wire).unwrap();
        a.read_message(&wire[..n], &mut payload).unwrap();
        (
            Channel::new(a.into_transport_mode().unwrap()),
            Channel::new(b.into_transport_mode().unwrap()),
        )
    }

    #[test]
    fn a_sealed_payload_opens_at_the_other_end() {
        let (mut device, mut workstation) = channels();
        let sealed = device.seal(b"hello").unwrap();
        assert_eq!(sealed.len() % FRAME_BUCKET, 0, "a frame is a whole number of buckets");
        assert!(!sealed.windows(5).any(|w| w == b"hello"), "and it is sealed");
        assert_eq!(workstation.open(testing::unframe(&sealed)).unwrap(), b"hello");

        let back = workstation.seal(&[7u8; 1000]).unwrap();
        assert_eq!(back.len(), 4 * FRAME_BUCKET);
        assert_eq!(device.open(testing::unframe(&back)).unwrap(), vec![7u8; 1000]);
    }

    #[test]
    fn a_frame_opens_once_and_in_its_turn() {
        let (mut device, mut workstation) = channels();
        let first = device.seal(b"one").unwrap();
        let second = device.seal(b"two").unwrap();

        // Out of turn: the second before the first.
        assert!(matches!(
            workstation.open(testing::unframe(&second)),
            Err(CoreError::Frame(_))
        ));
        // In turn.
        assert_eq!(workstation.open(testing::unframe(&first)).unwrap(), b"one");
        // Again.
        assert!(matches!(workstation.open(testing::unframe(&first)), Err(CoreError::Frame(_))));
    }

    #[test]
    fn a_frame_altered_anywhere_does_not_open() {
        for at in [0usize, 1, 17, 100, 253] {
            let (mut device, mut workstation) = channels();
            let mut sealed = device.seal(b"hello").unwrap();
            sealed[LENGTH_PREFIX + at] ^= 0x01;
            assert!(
                matches!(workstation.open(&sealed[LENGTH_PREFIX..]), Err(CoreError::Frame(_))),
                "a frame altered at byte {at} opened"
            );
        }
    }

    #[test]
    fn a_frame_that_is_not_bucket_sized_is_not_tried() {
        let (_, mut workstation) = channels();
        let err = workstation.open(&[0u8; 100]).unwrap_err();
        assert!(matches!(&err, CoreError::Frame(why) if why.contains("bucket")), "{err:?}");
    }

    #[test]
    fn an_inbox_gives_up_whole_frames_and_keeps_the_rest() {
        let mut inbox = Inbox::default();
        let mut bytes = frame(b"first");
        bytes.extend_from_slice(&frame(b""));
        bytes.extend_from_slice(&frame(b"third")[..4]);

        for byte in &bytes[..3] {
            inbox.push(std::slice::from_ref(byte));
            assert_eq!(inbox.next_frame(), None);
        }
        inbox.push(&bytes[3..]);
        assert_eq!(inbox.next_frame().as_deref(), Some(&b"first"[..]));
        assert_eq!(inbox.next_frame().as_deref(), Some(&b""[..]), "an empty frame is a frame");
        assert_eq!(inbox.next_frame(), None, "half a frame is not one");
        inbox.push(&frame(b"third")[4..]);
        assert_eq!(inbox.next_frame().as_deref(), Some(&b"third"[..]));
    }
}
