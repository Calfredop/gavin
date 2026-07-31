const OSC7_PREFIX: &[u8] = b"\x1b]7;";
const MAX_PAYLOAD_LEN: usize = 4096;

/// Watches a stream of raw PTY output bytes for OSC 7 sequences
/// (`ESC ]7;file://<host><path>` terminated by BEL or ST), which shell
/// prompts can be configured to emit on every new prompt to report the
/// shell's current working directory. Never mutates or strips the bytes
/// it's fed -- callers forward the original stream unchanged; this only
/// watches. State is carried across `feed()` calls so a sequence split
/// across separate PTY reads (which don't align with escape-sequence
/// boundaries) is still found correctly.
pub struct OscCwdScanner {
    state: ScanState,
}

enum ScanState {
    /// Not currently inside anything resembling an OSC 7 sequence.
    Idle,
    /// Matched the first `matched` bytes of OSC7_PREFIX so far.
    MatchingPrefix { matched: usize },
    /// Inside the OSC 7 payload (the `file://...` URI), accumulating bytes
    /// until a BEL or ST (ESC \) terminator. `saw_esc` tracks whether the
    /// immediately preceding byte was an ESC that might be the start of ST.
    ReadingPayload { payload: Vec<u8>, saw_esc: bool },
}

impl OscCwdScanner {
    pub fn new() -> Self {
        Self { state: ScanState::Idle }
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut found = Vec::new();
        for &b in bytes {
            match &mut self.state {
                ScanState::Idle => {
                    if b == OSC7_PREFIX[0] {
                        self.state = ScanState::MatchingPrefix { matched: 1 };
                    }
                }
                ScanState::MatchingPrefix { matched } => {
                    if b == OSC7_PREFIX[*matched] {
                        *matched += 1;
                        if *matched == OSC7_PREFIX.len() {
                            self.state = ScanState::ReadingPayload { payload: Vec::new(), saw_esc: false };
                        }
                    } else if b == OSC7_PREFIX[0] {
                        self.state = ScanState::MatchingPrefix { matched: 1 };
                    } else {
                        self.state = ScanState::Idle;
                    }
                }
                ScanState::ReadingPayload { payload, saw_esc } => {
                    if *saw_esc {
                        if b == b'\\' {
                            if let Some(path) = Self::parse_payload(payload) {
                                found.push(path);
                            }
                            self.state = ScanState::Idle;
                        } else {
                            // The prior ESC wasn't actually a terminator --
                            // keep it as ordinary payload content and
                            // process this byte normally.
                            payload.push(0x1b);
                            *saw_esc = false;
                            if b == 0x07 {
                                if let Some(path) = Self::parse_payload(payload) {
                                    found.push(path);
                                }
                                self.state = ScanState::Idle;
                            } else if b == 0x1b {
                                *saw_esc = true;
                            } else if payload.len() >= MAX_PAYLOAD_LEN {
                                self.state = ScanState::Idle;
                            } else {
                                payload.push(b);
                            }
                        }
                    } else if b == 0x07 {
                        if let Some(path) = Self::parse_payload(payload) {
                            found.push(path);
                        }
                        self.state = ScanState::Idle;
                    } else if b == 0x1b {
                        *saw_esc = true;
                    } else if payload.len() >= MAX_PAYLOAD_LEN {
                        self.state = ScanState::Idle;
                    } else {
                        payload.push(b);
                    }
                }
            }
        }
        found
    }

    fn parse_payload(payload: &[u8]) -> Option<String> {
        let text = std::str::from_utf8(payload).ok()?;
        let without_scheme = text.strip_prefix("file://")?;
        let path_start = without_scheme.find('/')?;
        Some(percent_decode(without_scheme[path_start..].as_bytes()))
    }
}

fn percent_decode(bytes: &[u8]) -> String {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn osc7(path: &str) -> Vec<u8> {
        let mut bytes = b"\x1b]7;file://host".to_vec();
        bytes.extend_from_slice(path.as_bytes());
        bytes.push(0x07);
        bytes
    }

    #[test]
    fn parses_a_whole_sequence_fed_in_one_chunk() {
        let mut scanner = OscCwdScanner::new();
        let result = scanner.feed(&osc7("/Users/alice/project"));
        assert_eq!(result, vec!["/Users/alice/project".to_string()]);
    }

    #[test]
    fn parses_a_sequence_split_at_every_byte_boundary() {
        let full = osc7("/Users/alice/project");
        for split_at in 0..=full.len() {
            let mut scanner = OscCwdScanner::new();
            let mut found = scanner.feed(&full[..split_at]);
            found.extend(scanner.feed(&full[split_at..]));
            assert_eq!(
                found,
                vec!["/Users/alice/project".to_string()],
                "failed when split at byte {split_at}"
            );
        }
    }

    #[test]
    fn ignores_bytes_before_and_after_the_sequence() {
        let mut scanner = OscCwdScanner::new();
        let mut bytes = b"some shell output before\r\n".to_vec();
        bytes.extend(osc7("/tmp"));
        bytes.extend_from_slice(b"more output after\r\n");
        let result = scanner.feed(&bytes);
        assert_eq!(result, vec!["/tmp".to_string()]);
    }

    #[test]
    fn supports_st_terminator_as_well_as_bel() {
        let mut scanner = OscCwdScanner::new();
        let mut bytes = b"\x1b]7;file://host/tmp".to_vec();
        bytes.extend_from_slice(b"\x1b\\"); // ST terminator
        let result = scanner.feed(&bytes);
        assert_eq!(result, vec!["/tmp".to_string()]);
    }

    #[test]
    fn recovers_from_an_esc_inside_the_payload_that_is_not_actually_st() {
        // A lone ESC not followed by backslash must be treated as ordinary
        // payload content, not misinterpreted as the start of a terminator
        // -- the scanner should still find the real BEL that follows.
        let mut scanner = OscCwdScanner::new();
        let mut bytes = b"\x1b]7;file://host/tmp".to_vec();
        bytes.push(0x1b); // a stray ESC that is NOT followed by '\'
        bytes.extend_from_slice(b"x");
        bytes.push(0x07); // the real terminator
        let result = scanner.feed(&bytes);
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn decodes_percent_encoded_characters_in_the_path() {
        let mut scanner = OscCwdScanner::new();
        let result = scanner.feed(&osc7("/Users/alice/my%20project"));
        assert_eq!(result, vec!["/Users/alice/my project".to_string()]);
    }

    #[test]
    fn finds_multiple_sequences_across_separate_feed_calls() {
        let mut scanner = OscCwdScanner::new();
        let first = scanner.feed(&osc7("/tmp/a"));
        let second = scanner.feed(&osc7("/tmp/b"));
        assert_eq!(first, vec!["/tmp/a".to_string()]);
        assert_eq!(second, vec!["/tmp/b".to_string()]);
    }

    #[test]
    fn abandons_a_sequence_that_never_terminates_without_growing_forever() {
        let mut scanner = OscCwdScanner::new();
        let mut huge = b"\x1b]7;file://host/".to_vec();
        huge.extend(std::iter::repeat(b'a').take(10_000));
        let result = scanner.feed(&huge);
        assert!(result.is_empty());
        // The scanner must have recovered to idle and be ready to find a
        // fresh, well-formed sequence afterward -- not stuck.
        let result2 = scanner.feed(&osc7("/tmp/recovered"));
        assert_eq!(result2, vec!["/tmp/recovered".to_string()]);
    }

    #[test]
    fn ignores_a_payload_that_does_not_look_like_a_file_uri() {
        let mut scanner = OscCwdScanner::new();
        let mut bytes = b"\x1b]7;not-a-file-uri".to_vec();
        bytes.push(0x07);
        let result = scanner.feed(&bytes);
        assert!(result.is_empty());
    }

    #[test]
    fn does_not_panic_when_percent_sits_next_to_multibyte_utf8() {
        let mut scanner = OscCwdScanner::new();
        let mut bytes = b"\x1b]7;file://host/tmp/50%".to_vec();
        bytes.extend_from_slice("€rest".as_bytes());
        bytes.push(0x07);
        // Must not panic. The exact decoded value isn't the point here (the
        // literal "%" wasn't valid percent-encoding since '\xe2' isn't a hex
        // digit, so it passes through unchanged) -- the point is no crash.
        let result = scanner.feed(&bytes);
        assert_eq!(result.len(), 1);
    }
}
