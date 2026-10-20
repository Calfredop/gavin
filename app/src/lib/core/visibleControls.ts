// Display-only: map C0 controls and invisible formatting characters to
// visible marks so a review sheet that claims to show every byte the
// digest covers actually draws them. The digest itself stays over the
// raw string; only the rendered text goes through this.

const BIDI_AND_ZW = new Set([
  0x200b, // ZERO WIDTH SPACE
  0x200c, // ZERO WIDTH NON-JOINER
  0x200d, // ZERO WIDTH JOINER
  0x200e, // LEFT-TO-RIGHT MARK
  0x200f, // RIGHT-TO-LEFT MARK
  0x202a, // LEFT-TO-RIGHT EMBEDDING
  0x202b, // RIGHT-TO-LEFT EMBEDDING
  0x202c, // POP DIRECTIONAL FORMATTING
  0x202d, // LEFT-TO-RIGHT OVERRIDE
  0x202e, // RIGHT-TO-LEFT OVERRIDE
  0x2066, // LEFT-TO-RIGHT ISOLATE
  0x2067, // RIGHT-TO-LEFT ISOLATE
  0x2068, // FIRST STRONG ISOLATE
  0x2069, // POP DIRECTIONAL ISOLATE
  0xfeff, // ZERO WIDTH NO-BREAK SPACE / BOM
]);

/// Marks every control and invisible formatting character a plain
/// `<pre>` would hide. ESC → U+241B; other C0 (except tab, LF, CR) →
/// their U+2400-block pictures; DEL → U+2421; bidi / zero-width →
/// `⟨U+XXXX⟩`. Tab, LF and CR stay as themselves.
export function visibleControls(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code === 0x1b) {
      out += "\u{241b}";
      continue;
    }
    if (code === 0x7f) {
      out += "\u{2421}";
      continue;
    }
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      out += String.fromCodePoint(0x2400 + code);
      continue;
    }
    if (BIDI_AND_ZW.has(code)) {
      out += `⟨U+${code.toString(16).toUpperCase().padStart(4, "0")}⟩`;
      continue;
    }
    out += ch;
  }
  return out;
}
