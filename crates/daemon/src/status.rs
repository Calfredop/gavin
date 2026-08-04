use std::time::Duration;

/// Cap on how many bytes of a single OSC sequence's number or payload
/// this scanner will actually retain. A sequence longer than this is
/// still tracked and scanned for its terminator -- only bytes beyond the
/// cap are discarded rather than buffered, so a legitimate but long
/// BEL-terminated sequence (OSC 8 hyperlinks with long URLs, OSC 52
/// clipboard writes, OSC 1337 inline images) is still correctly consumed
/// and its own terminator is never misclassified as a standalone
/// attention-bell. This cap only bounds memory -- it does not abandon
/// the sequence; see MAX_SEQUENCE_SCAN_LEN for that.
const MAX_SEQUENCE_LEN: usize = 256;

/// Hard backstop against a sequence that never terminates at all -- a
/// corrupted stream, or deliberately malicious input. Far larger than
/// any realistic legitimate OSC sequence, so it only triggers for
/// genuinely pathological input. Unlike MAX_SEQUENCE_LEN, exceeding this
/// really does abandon the sequence and reset to Idle, mirroring
/// osc.rs's own cap-then-reset-to-Idle behavior, so the scanner can't be
/// left stuck waiting indefinitely for a terminator that may never come.
/// Tracked via a running total-bytes-consumed counter (ScanState::InOsc's
/// `scanned` field) independent of MAX_SEQUENCE_LEN's buffer cap, since
/// the buffers themselves stop growing at that cap.
const MAX_SEQUENCE_SCAN_LEN: usize = 65536;

/// Emitted by `StatusScanner::feed` for each status-relevant signal found
/// in a chunk of raw PTY output, in the order they occurred.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusEvent {
    Idle,
    Working,
    WaitingForInput,
}

/// Watches a stream of raw PTY output bytes for three independent signals:
/// OSC 133 shell-integration markers (A/B/C/D -> idle/working), desktop
/// notification sequences (OSC 9 / 99 / 777 -> waiting_for_input), and a
/// bare terminal BEL byte outside of any escape sequence
/// (-> waiting_for_input).
///
/// The notification sequences matter because a bare BEL is NOT the
/// universal "needs attention" signal it looks like. Claude Code, for
/// one, picks its notification channel from `TERM_PROGRAM` and rings a
/// bare BEL only under Apple_Terminal -- under iTerm2 it sends OSC 9,
/// under ghostty OSC 777, under kitty OSC 99, and under an unrecognized
/// or absent TERM_PROGRAM it sends nothing at all. Since a session's
/// TERM_PROGRAM is inherited from whatever launched the GUI (this daemon
/// only ever sets TERM), a BEL-only detector misses the signal in most
/// real environments. See this module's tests for the captured bytes.
///
/// OSC sequences are tracked GENERICALLY (any number, not just the ones
/// above) -- this is deliberate, not incidental complexity. OSC 7 (cwd,
/// see osc.rs) and OSC 133 both legally use BEL as an alternative
/// terminator to ESC \ -- a BEL that's actually terminating some other
/// OSC sequence must never be misclassified as a standalone
/// attention-bell. Only a recognized number's payload is interpreted.
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
    InOsc { number: Vec<u8>, in_payload: bool, payload: Vec<u8>, saw_esc: bool, scanned: usize },
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
                            scanned: 0,
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
                ScanState::InOsc { number, in_payload, payload, saw_esc, scanned } => {
                    *scanned += 1;
                    if *scanned > MAX_SEQUENCE_SCAN_LEN {
                        // Never found a terminator after an extremely
                        // long run -- give up rather than stay stuck
                        // forever. This byte is dropped rather than
                        // reprocessed from Idle, matching how the
                        // scanner already treats any other abandoned
                        // sequence.
                        self.state = ScanState::Idle;
                        continue;
                    }
                    if *saw_esc {
                        if b == b'\\' {
                            Self::emit_for_sequence(number, payload, &mut found);
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
                                Self::emit_for_sequence(number, payload, &mut found);
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
                        Self::emit_for_sequence(number, payload, &mut found);
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

    /// Pushes a byte into the number or payload buffer as appropriate,
    /// silently discarding bytes beyond MAX_SEQUENCE_LEN rather than
    /// growing the buffer further -- the sequence keeps being scanned
    /// for its terminator regardless; only accumulation stops. (The
    /// separate MAX_SEQUENCE_SCAN_LEN backstop in feed() is what
    /// eventually abandons a sequence that truly never terminates.)
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

    /// Turns a completed OSC sequence into a status event, if it carries
    /// one. Two independent families are recognized: OSC 133 shell
    /// integration (idle/working), and the desktop-notification sequences
    /// below (waiting_for_input).
    fn emit_for_sequence(number: &[u8], payload: &[u8], found: &mut Vec<StatusEvent>) {
        match number {
            b"133" => {
                let Some(&command) = payload.first() else { return };
                match command {
                    b'A' | b'B' => found.push(StatusEvent::Idle),
                    b'C' => found.push(StatusEvent::Working),
                    b'D' => found.push(StatusEvent::Idle),
                    _ => {}
                }
            }
            b"9" | b"99" | b"777" if Self::is_attention_notification(number, payload) => {
                found.push(StatusEvent::WaitingForInput);
            }
            _ => {}
        }
    }

    /// Whether a desktop-notification OSC sequence is a genuine
    /// "something needs your attention" signal.
    ///
    /// A terminal emulator would raise an OS notification here; gavin
    /// instead treats it as the session asking for the user. This is a
    /// strictly better signal than a bare BEL: it is explicit, carries a
    /// message, and cannot be confused with a readline error beep.
    ///
    /// Each number is overloaded by some tool for non-notification
    /// purposes, so each gets its own guard -- a false positive here
    /// paints a session red and fires an OS notification for nothing.
    fn is_attention_notification(number: &[u8], payload: &[u8]) -> bool {
        // The metadata/subcommand field: everything up to the first ';'.
        let head = match payload.iter().position(|&b| b == b';') {
            Some(i) => &payload[..i],
            None => payload,
        };
        match number {
            // rxvt-unicode / ghostty: OSC 777 ; notify ; title ; body
            // Other subcommands exist (e.g. `precmd`) and mean nothing here.
            b"777" => head == b"notify",
            // iTerm2: OSC 9 ; <message>. ConEmu and Windows Terminal
            // overload the same number for progress (9;4;...) and cwd
            // (9;9;...), which are numeric subcommands rather than
            // human-readable text -- exclude those, and empty payloads.
            b"9" => !head.is_empty() && !head.iter().all(|b| b.is_ascii_digit()),
            // kitty: OSC 99 ; <metadata> ; <payload>. One logical
            // notification arrives as several chunks, so emit for exactly
            // one of them: skip continuation chunks (`d=0`, more to come)
            // and pure-action chunks (`a=`, which carry no message).
            b"99" => {
                let meta = String::from_utf8_lossy(head);
                !meta.split(':').any(|f| f == "d=0" || f.starts_with("a="))
            }
            _ => false,
        }
    }
}

/// How long a session must go without any new PTY output before the
/// output-activity heuristic (used only while a session has never seen a
/// valid OSC 133 marker) considers it idle again. Defined here since
/// it's the detection layer's own concept, even though the actual timer
/// mechanism lives in server.rs (see that file's own heuristic-timer
/// wiring, added in Task 3 of this plan).
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
        // OSC 4 (color palette query) carries no status meaning at all.
        // NOTE: this test used to use OSC 9 for this purpose. OSC 9 is now
        // deliberately recognized as a desktop-notification sequence (see
        // osc9_iterm2_notification_maps_to_waiting_for_input below), so an
        // inert number is used here instead.
        let mut scanner = StatusScanner::new();
        let mut bytes = b"\x1b]4;1;rgb:ff/00/00".to_vec();
        bytes.push(0x07);
        assert_eq!(scanner.feed(&bytes), vec![]);
    }

    // --- Desktop-notification OSC sequences -> waiting_for_input ---
    //
    // Every byte string in the tests below was captured from the real
    // Claude Code CLI (2.1.220) running on a PTY, by varying only
    // TERM_PROGRAM. Claude Code picks its notification channel from that
    // variable, so the *same* prompt emits a different sequence per
    // terminal -- and emits a bare BEL only for Apple_Terminal. gavin's
    // daemon never sets TERM_PROGRAM, so it inherits whatever launched the
    // GUI, which is why the bare-BEL-only heuristic missed these entirely.

    #[test]
    fn osc777_notify_maps_to_waiting_for_input() {
        // Captured with TERM_PROGRAM=ghostty.
        let mut scanner = StatusScanner::new();
        let mut bytes = b"\x1b]777;notify;Claude Code;Claude needs your permission".to_vec();
        bytes.push(0x07);
        assert_eq!(scanner.feed(&bytes), vec![StatusEvent::WaitingForInput]);
    }

    #[test]
    fn osc777_with_a_non_notify_subcommand_produces_no_event() {
        let mut scanner = StatusScanner::new();
        let mut bytes = b"\x1b]777;precmd".to_vec();
        bytes.push(0x07);
        assert_eq!(scanner.feed(&bytes), vec![]);
    }

    #[test]
    fn osc9_iterm2_notification_maps_to_waiting_for_input() {
        // Captured with TERM_PROGRAM=iTerm.app.
        let mut scanner = StatusScanner::new();
        let mut bytes = b"\x1b]9;Claude needs your permission".to_vec();
        bytes.push(0x07);
        assert_eq!(scanner.feed(&bytes), vec![StatusEvent::WaitingForInput]);
    }

    #[test]
    fn osc9_conemu_progress_subcommand_is_not_treated_as_a_notification() {
        // ConEmu/Windows Terminal overload OSC 9 for progress reporting
        // (9;4;<state>;<pct>) and cwd (9;9;<path>). Those are numeric
        // subcommands, not human-readable notification text -- a build tool
        // driving a progress bar must not paint every session red.
        let mut scanner = StatusScanner::new();
        let mut bytes = b"\x1b]9;4;1;60".to_vec();
        bytes.push(0x07);
        assert_eq!(scanner.feed(&bytes), vec![]);
    }

    #[test]
    fn osc9_with_an_empty_payload_produces_no_event() {
        let mut scanner = StatusScanner::new();
        let mut bytes = b"\x1b]9;".to_vec();
        bytes.push(0x07);
        assert_eq!(scanner.feed(&bytes), vec![]);
    }

    #[test]
    fn kitty_osc99_notification_burst_fires_waiting_for_input_exactly_once() {
        // Captured with TERM_PROGRAM=kitty. Claude Code sends ONE logical
        // notification as THREE ST-terminated OSC 99 chunks: a d=0 title
        // chunk, a body chunk, and a closing d=1:a=focus action chunk.
        // Emitting per-chunk would fire three status transitions -- and
        // therefore three OS notifications -- for a single prompt.
        let mut scanner = StatusScanner::new();
        let bytes = b"\x1b]99;i=291:d=0:p=title;Claude Code\x1b\\\
\x1b]99;i=291:p=body;Claude needs your permission\x1b\\\
\x1b]99;i=291:d=1:a=focus;\x1b\\"
            .to_vec();
        assert_eq!(scanner.feed(&bytes), vec![StatusEvent::WaitingForInput]);
    }

    #[test]
    fn a_notification_osc_terminator_is_still_not_a_standalone_bell() {
        // The notification sequences above are BEL-terminated. That BEL is
        // a delimiter; it must produce exactly one event (from the
        // sequence's meaning), never a second one from the bell itself.
        let mut scanner = StatusScanner::new();
        let mut bytes = b"\x1b]777;notify;t;m".to_vec();
        bytes.push(0x07);
        bytes.extend_from_slice(b"ordinary output");
        assert_eq!(scanner.feed(&bytes), vec![StatusEvent::WaitingForInput]);
    }

    #[test]
    fn a_notification_sequence_split_across_feeds_is_still_detected() {
        let full = {
            let mut b = b"\x1b]777;notify;Claude Code;Claude needs your permission".to_vec();
            b.push(0x07);
            b
        };
        for split_at in 0..=full.len() {
            let mut scanner = StatusScanner::new();
            let mut found = scanner.feed(&full[..split_at]);
            found.extend(scanner.feed(&full[split_at..]));
            assert_eq!(
                found,
                vec![StatusEvent::WaitingForInput],
                "failed when split at byte {split_at}"
            );
        }
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
        // Well past MAX_SEQUENCE_SCAN_LEN (65536) -- MAX_SEQUENCE_LEN
        // alone (256) no longer abandons a sequence, only stops growing
        // its buffer, so this must exceed the larger backstop to
        // actually exercise the abandon-and-reset-to-Idle path.
        huge.extend(std::iter::repeat(b'x').take(100_000));
        let result = scanner.feed(&huge);
        assert!(result.is_empty());
        // The scanner must have genuinely recovered to Idle -- proven by
        // feeding a single bare BEL next (not another full sequence,
        // which could coincidentally satisfy a wrong assertion if the
        // scanner were still stuck consuming a stale buffer). A bare BEL
        // only produces WaitingForInput when the scanner is actually
        // Idle; if it were still stuck in InOsc, this BEL would instead
        // be consumed as a (wrong) terminator for the abandoned sequence
        // and produce no event at all.
        assert_eq!(scanner.feed(&[0x07]), vec![StatusEvent::WaitingForInput]);
    }

    #[test]
    fn a_long_bel_terminated_sequence_past_max_sequence_len_is_not_misclassified_as_a_standalone_bell() {
        // OSC 8 hyperlinks and OSC 52 clipboard writes routinely exceed
        // MAX_SEQUENCE_LEN (256 bytes of retained payload) while staying
        // nowhere near MAX_SEQUENCE_SCAN_LEN -- the sequence must still
        // be correctly recognized as an OSC sequence (an unrecognized
        // command, since it's OSC 52 not 133), and its own terminating
        // BEL must not leak through as a standalone attention-bell. This
        // is the regression this fix exists to close: before it,
        // exceeding MAX_SEQUENCE_LEN reset the scanner to Idle
        // mid-sequence, so this exact BEL would have fired a spurious
        // WaitingForInput.
        let mut scanner = StatusScanner::new();
        let mut bytes = b"\x1b]52;c;".to_vec();
        bytes.extend(std::iter::repeat(b'A').take(1000)); // a long fake base64 clipboard payload
        bytes.push(0x07);
        assert_eq!(scanner.feed(&bytes), vec![]);
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

