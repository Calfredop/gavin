// OSC 52 is how a program sets the clipboard through its terminal when it
// cannot reach one itself: `ESC ] 52 ; Pc ; Pd BEL`, where Pc names the
// selection and Pd is the text in base64. Claude Code copies this way
// over SSH (there is no pbcopy on the far side to call), and so do tmux's
// set-clipboard and vim/neovim's osc52 providers. Without a handler,
// xterm drops the sequence and the program's copy goes nowhere.

/// The text an OSC 52 payload (what follows `52;`) puts on the clipboard,
/// or null when it asks for nothing gavin honours.
///
/// Write-only. A `?` asks the terminal to REPORT the clipboard, and
/// answering would hand whatever the human last copied -- a password
/// included -- to any program in the terminal, a remote one included. An
/// empty Pd asks to clear the clipboard, which no program needs to do to
/// the human. Pc is not consulted: there is one clipboard to write, and
/// a primary selection named here still means "copy this".
export function osc52Text(payload: string): string | null {
  const separator = payload.indexOf(";");
  if (separator < 0) return null;
  const data = payload.slice(separator + 1);
  if (data === "" || data === "?") return null;
  let binary: string;
  try {
    binary = atob(data);
  } catch {
    return null;
  }
  const text = new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  return text === "" ? null : text;
}
