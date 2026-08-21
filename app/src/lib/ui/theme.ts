/// The user's stored choice. "system" defers to the OS appearance.
export type ThemePref = "light" | "dark" | "system";

/// What actually gets stamped on <html data-theme>. Never "system".
export type EffectiveTheme = "light" | "dark";

const PREFS: readonly string[] = ["light", "dark", "system"];

/// Dark is the fallback rather than light because dark is the app's look
/// today: a platform that cannot report an appearance keeps the current
/// behaviour instead of flipping to a theme nobody chose.
export function resolveTheme(pref: ThemePref, system: EffectiveTheme | null): EffectiveTheme {
  if (pref !== "system") return pref;
  return system ?? "dark";
}

/// Guards a hand-edited config.json, mirroring normalizeColor in
/// settings.ts: anything that isn't one of the three literals is treated
/// as unset rather than trusted.
export function parseThemePref(value: string | null | undefined): ThemePref {
  if (typeof value !== "string") return "system";
  const trimmed = value.trim();
  return PREFS.includes(trimmed) ? (trimmed as ThemePref) : "system";
}
