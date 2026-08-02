use std::time::Duration;

/// Cap on how many bytes of a single OSC sequence's number or payload
/// this scanner will accumulate before giving up and resetting to Idle --
/// the same runaway-sequence protection OscCwdScanner already has.
const MAX_SEQUENCE_LEN: usize = 256;

/// Emitted by `StatusScanner::feed` for each status-relevant signal found
/// in a chunk of raw PTY output, in the order they occurred.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusEvent {
    Idle,
    Working,
    WaitingForInput,
}

/// Watches a stream of raw PTY output bytes for two independent signals:
/// OSC 133 shell-integration markers (A/B/C/D -> idle/working) and a bare
/// terminal BEL byte outside of any escape sequence (-> waiting_for_input).
///
/// OSC sequences are tracked GENERICALLY (any number, not just 133) --
/// this is deliberate, not incidental complexity. OSC 7 (cwd, see
/// osc.rs) and OSC 133 both legally use BEL as an alternative terminator
/// to ESC \ -- a BEL that's actually terminating some other OSC sequence
/// must never be misclassified as a standalone attention-bell. Only when
/// the accumulated OSC number is specifically "133" is the payload
/// parsed as a status command.
///
/// Never mutates or strips the bytes it's fed -- callers forward the
/// original stream unchanged; this only watches. State is carried across
/// `feed()` calls so a sequence split across separate PTY reads is still
/// found correctly.
pub struct StatusScanner {
    state: ScanState,
}

enum ScanState {
    /// Not currently inside any escape sequence.
    Idle,
    /// Just saw ESC; don't yet know if this is an OSC introducer (`]`)
    /// or some other escape sequence entirely (e.g. CSI `[`).
    SawEsc,
    /// Inside an OSC sequence: accumulating the OSC number until the
    /// first `;`, then the payload until a BEL or ST (ESC \) terminator.
    InOsc { number: Vec<u8>, in_payload: bool, payload: Vec<u8>, saw_esc: bool },
}

impl StatusScanner {
    pub fn new() -> Self {
        Self { state: ScanState::Idle }
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Vec<StatusEvent> {
        let mut found = Vec::new();
        for &b in bytes {
            match &mut self.state {
                ScanState::Idle => {
                    if b == 0x1b {
                        self.state = ScanState::SawEsc;
                    } else if b == 0x07 {
                        // A bare BEL, not terminating anything -- the
                        // standalone terminal bell.
                        found.push(StatusEvent::WaitingForInput);
                    }
                }
                ScanState::SawEsc => {
                    if b == b']' {
                        self.state = ScanState::InOsc {
                            number: Vec::new(),
                            in_payload: false,
                            payload: Vec::new(),
                            saw_esc: false,
                        };
                    } else if b == 0x1b {
                        // A stray repeated ESC before the introducer --
                        // stay watching for ']', using this ESC as the
                        // new potential start rather than dropping to
                        // Idle and losing a real sequence that follows.
                    } else {
                        // Not an OSC introducer (e.g. CSI, or any other
                        // escape sequence) -- this scanner doesn't need
                        // to track those, since none of them use BEL/ST
                        // as a terminator the way OSC does.
                        self.state = ScanState::Idle;
                    }
                }
                ScanState::InOsc { number, in_payload, payload, saw_esc } => {
                    if *saw_esc {
                        if b == b'\\' {
                            Self::emit_if_133(number, payload, &mut found);
                            self.state = ScanState::Idle;
                        } else {
                            // The prior ESC wasn't actually the start of
                            // ST -- keep it as ordinary content and
                            // process this byte normally.
                            if *in_payload && payload.len() < MAX_SEQUENCE_LEN {
                                payload.push(0x1b);
                            }
                            *saw_esc = false;
                            if b == 0x07 {
                                Self::emit_if_133(number, payload, &mut found);
                                self.state = ScanState::Idle;
                            } else if b == 0x1b {
                                *saw_esc = true;
                            } else {
                                Self::push_byte(number, in_payload, payload, b);
                            }
                        }
                        continue;
                    }
                    if b == 0x07 {
                        Self::emit_if_133(number, payload, &mut found);
                        self.state = ScanState::Idle;
                    } else if b == 0x1b {
                        *saw_esc = true;
                    } else if !*in_payload && b == b';' {
                        *in_payload = true;
                    } else {
                        Self::push_byte(number, in_payload, payload, b);
                    }
                }
            }
        }
        found
    }

    fn push_byte(number: &mut Vec<u8>, in_payload: &mut bool, payload: &mut Vec<u8>, b: u8) {
        if *in_payload {
            if payload.len() < MAX_SEQUENCE_LEN {
                payload.push(b);
            }
        } else if b.is_ascii_digit() {
            if number.len() < MAX_SEQUENCE_LEN {
                number.push(b);
            }
        } else {
            // Malformed OSC-number syntax (a non-digit before any ';')
            // -- be lenient: start treating everything as payload from
            // here, so the terminator is still found correctly even
            // though this sequence won't be recognized as OSC 133.
            *in_payload = true;
            if payload.len() < MAX_SEQUENCE_LEN {
                payload.push(b);
            }
        }
    }

    fn emit_if_133(number: &[u8], payload: &[u8], found: &mut Vec<StatusEvent>) {
        if number != b"133" {
            return;
        }
        let Some(&command) = payload.first() else { return };
        match command {
            b'A' | b'B' => found.push(StatusEvent::Idle),
            b'C' => found.push(StatusEvent::Working),
            b'D' => found.push(StatusEvent::Idle),
            _ => {}
        }
    }
}

/// How long a session must go without any new PTY output before the
/// output-activity heuristic (used only while a session has never seen a
/// valid OSC 133 marker) considers it idle again. Re-exported from this
/// module since it's the detection layer's own concept, even though the
/// actual timer mechanism lives in server.rs (see that file's own
/// heuristic-timer wiring, added in Task 3 of this plan).
pub const HEURISTIC_QUIET_PERIOD: Duration = Duration::from_secs(2);

#[cfg(test)]
mod tests {
    use super::*;

    fn osc133(command: &str) -> Vec<u8> {
        let mut bytes = b"\x1b]133;".to_vec();
        bytes.extend_from_slice(command.as_bytes());
        bytes.push(0x07);
        bytes
    }

    #[test]
    fn prompt_start_a_maps_to_idle() {
        let mut scanner = StatusScanner::new();
        assert_eq!(scanner.feed(&osc133("A")), vec![StatusEvent::Idle]);
    }

    #[test]
    fn command_start_b_maps_to_idle() {
        let mut scanner = StatusScanner::new();
        assert_eq!(scanner.feed(&osc133("B")), vec![StatusEvent::Idle]);
    }

    #[test]
    fn command_executed_c_maps_to_working() {
        let mut scanner = StatusScanner::new();
        assert_eq!(scanner.feed(&osc133("C")), vec![StatusEvent::Working]);
    }

    #[test]
    fn command_finished_d_without_exit_code_maps_to_idle() {
        let mut scanner = StatusScanner::new();
        assert_eq!(scanner.feed(&osc133("D")), vec![StatusEvent::Idle]);
    }

    #[test]
    fn command_finished_d_with_exit_code_still_maps_to_idle() {
        let mut scanner = StatusScanner::new();
        assert_eq!(scanner.feed(&osc133("D;42")), vec![StatusEvent::Idle]);
    }

    #[test]
    fn bare_standalone_bel_maps_to_waiting_for_input() {
        let mut scanner = StatusScanner::new();
        let mut bytes = b"some shell output\r\n".to_vec();
        bytes.push(0x07);
        bytes.extend_from_slice(b"more output\r\n");
        assert_eq!(scanner.feed(&bytes), vec![StatusEvent::WaitingForInput]);
    }

    #[test]
    fn osc7_sequence_terminated_by_bel_is_not_misclassified_as_a_standalone_bell() {
        // The specific regression this scanner's generic-OSC-tracking
        // exists to prevent: OSC 7 (cwd reporting, see osc.rs) legally
        // uses BEL as its own terminator too. A naive bare-BEL detector
        // would fire waiting_for_input on every single shell prompt that
        // uses BEL-terminated OSC 7 -- this must not happen.
        let mut scanner = StatusScanner::new();
        let mut bytes = b"\x1b]7;file://host/tmp".to_vec();
        bytes.push(0x07);
        assert_eq!(scanner.feed(&bytes), vec![]);
    }

    #[test]
    fn an_osc_number_other_than_133_or_7_is_structurally_tracked_but_produces_no_event() {
        let mut scanner = StatusScanner::new();
        let mut bytes = b"\x1b]9;some notification text".to_vec();
        bytes.push(0x07);
        assert_eq!(scanner.feed(&bytes), vec![]);
    }

    #[test]
    fn supports_st_terminator_as_well_as_bel() {
        let mut scanner = StatusScanner::new();
        let mut bytes = b"\x1b]133;C".to_vec();
        bytes.extend_from_slice(b"\x1b\\");
        assert_eq!(scanner.feed(&bytes), vec![StatusEvent::Working]);
    }

    #[test]
    fn recovers_from_an_esc_inside_the_payload_that_is_not_actually_st() {
        let mut scanner = StatusScanner::new();
        let mut bytes = b"\x1b]133;C".to_vec();
        bytes.push(0x1b); // a stray ESC that is NOT followed by '\'
        bytes.extend_from_slice(b"x");
        bytes.push(0x07); // the real terminator
        assert_eq!(scanner.feed(&bytes), vec![StatusEvent::Working]);
    }

    #[test]
    fn parses_a_sequence_split_at_every_byte_boundary() {
        let full = osc133("C");
        for split_at in 0..=full.len() {
            let mut scanner = StatusScanner::new();
            let mut found = scanner.feed(&full[..split_at]);
            found.extend(scanner.feed(&full[split_at..]));
            assert_eq!(found, vec![StatusEvent::Working], "failed when split at byte {split_at}");
        }
    }

    #[test]
    fn finds_multiple_sequences_across_separate_feed_calls() {
        let mut scanner = StatusScanner::new();
        assert_eq!(scanner.feed(&osc133("C")), vec![StatusEvent::Working]);
        assert_eq!(scanner.feed(&osc133("D")), vec![StatusEvent::Idle]);
    }

    #[test]
    fn abandons_a_sequence_that_never_terminates_without_growing_forever() {
        let mut scanner = StatusScanner::new();
        let mut huge = b"\x1b]133;C".to_vec();
        huge.extend(std::iter::repeat(b'x').take(10_000));
        let result = scanner.feed(&huge);
        assert!(result.is_empty());
        // The scanner must have recovered to idle and be ready to find a
        // fresh, well-formed sequence afterward -- not stuck.
        assert_eq!(scanner.feed(&osc133("C")), vec![StatusEvent::Working]);
    }

    #[test]
    fn a_stray_repeated_esc_before_the_introducer_does_not_lose_the_real_sequence() {
        let mut scanner = StatusScanner::new();
        let mut bytes = vec![0x1b, 0x1b]; // stray double ESC
        bytes.extend(osc133("C"));
        assert_eq!(scanner.feed(&bytes), vec![StatusEvent::Working]);
    }

    #[test]
    fn a_non_osc_escape_sequence_does_not_swallow_a_later_standalone_bell() {
        // ESC [ ... is a CSI sequence (e.g. cursor movement), not OSC --
        // this scanner must recognize it isn't an OSC introducer and
        // return to Idle in time to still catch a real bell afterward.
        let mut scanner = StatusScanner::new();
        let mut bytes = b"\x1b[2J".to_vec(); // CSI: clear screen
        bytes.push(0x07); // a real, later, standalone bell
        assert_eq!(scanner.feed(&bytes), vec![StatusEvent::WaitingForInput]);
    }

    #[test]
    fn ignores_bytes_before_and_after_a_sequence() {
        let mut scanner = StatusScanner::new();
        let mut bytes = b"some shell output before\r\n".to_vec();
        bytes.extend(osc133("D"));
        bytes.extend_from_slice(b"more output after\r\n");
        assert_eq!(scanner.feed(&bytes), vec![StatusEvent::Idle]);
    }
}
