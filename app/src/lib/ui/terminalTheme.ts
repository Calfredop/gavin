import type { ITheme } from "@xterm/xterm";
import type { EffectiveTheme } from "./theme";

/// xterm needs resolved colour strings, not var() references, and it needs
/// 16 ANSI slots that the semantic token set deliberately does not carry.
/// So the palette is spelled out here, mirroring theme.css's families:
/// blue/green/red/amber plus a magenta and cyan xterm requires and the app
/// chrome never uses.
///
/// The light arm is not the dark arm inverted -- the same reason D46 gives
/// for the neutral ramp. Mid-brightness ANSI colours tuned to sit on
/// #1e1e1e wash out on white, so light uses the darker end of each family.
const DARK: ITheme = {
  background: "#1e1e1e",
  foreground: "#eee",
  cursor: "#eee",
  cursorAccent: "#1e1e1e",
  selectionBackground: "#3a3a3a",
  black: "#1a1a1a",
  red: "#e0524a",
  green: "#8bc98b",
  yellow: "#d9a648",
  blue: "#4a9eff",
  magenta: "#b48ae0",
  cyan: "#6ad1c9",
  white: "#bbb",
  brightBlack: "#666",
  brightRed: "#e08a8a",
  brightGreen: "#cfe8cf",
  brightYellow: "#d9b45c",
  brightBlue: "#7ea8d8",
  brightMagenta: "#c9a8e8",
  brightCyan: "#8fe0d8",
  brightWhite: "#fff",
};

const LIGHT: ITheme = {
  background: "#fff",
  foreground: "#1a1a1a",
  cursor: "#1a1a1a",
  cursorAccent: "#fff",
  selectionBackground: "#ddd",
  black: "#1a1a1a",
  red: "#b03a32",
  green: "#3f7d47",
  yellow: "#8a6410",
  blue: "#2f6ba8",
  magenta: "#7a4bb5",
  cyan: "#1f8a80",
  white: "#666",
  brightBlack: "#888",
  brightRed: "#7a3030",
  brightGreen: "#2c4a2c",
  brightYellow: "#6b3d1f",
  brightBlue: "#4a6a8a",
  brightMagenta: "#5a3585",
  brightCyan: "#16635c",
  brightWhite: "#000",
};

export function xtermTheme(theme: EffectiveTheme): ITheme {
  return theme === "light" ? LIGHT : DARK;
}
