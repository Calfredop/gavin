import { getCurrentWindow } from "@tauri-apps/api/window";
import * as backend from "$lib/core/backend";
import { applyTerminalTheme } from "$lib/terminal/terminalRegistry";
import { resolveTheme, parseThemePref, type ThemePref, type EffectiveTheme } from "$lib/ui/theme";

/// "system" is stored as null on the Rust side (absent means default),
/// so it never round-trips as the literal string.
function toStored(pref: ThemePref): string | null {
  return pref === "system" ? null : pref;
}

class ThemeStore {
  pref = $state<ThemePref>("system");
  effective = $state<EffectiveTheme>("dark");

  #apply(system: EffectiveTheme | null): void {
    this.effective = resolveTheme(this.pref, system);
    // bootstrap() is unit-tested in a node environment with no DOM, and
    // the resolved theme is still worth recording there -- only the stamp
    // needs a document.
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = this.effective;
    }
    // xterm reads colours from a JS options object, not CSS, so stamping
    // data-theme does nothing for it -- the registry has to be told.
    applyTerminalTheme(this.effective);
  }

  async #systemTheme(): Promise<EffectiveTheme | null> {
    try {
      const t = await getCurrentWindow().theme();
      return t === "light" || t === "dark" ? t : null;
    } catch {
      // No Tauri window (vitest, or a plain browser preview) -- treated as
      // "system unavailable", which resolveTheme maps to dark.
      return null;
    }
  }

  async init(): Promise<void> {
    try {
      this.pref = parseThemePref(await backend.getThemePref());
    } catch {
      this.pref = "system";
    }
    this.#apply(await this.#systemTheme());
    try {
      await getCurrentWindow().onThemeChanged(({ payload }) => {
        // Only meaningful while following the system: an explicit
        // preference must not be overridden by the OS schedule.
        if (this.pref === "system") {
          this.#apply(payload === "light" ? "light" : "dark");
        }
      });
    } catch {
      // Listener unavailable -- the resolved theme still stands.
    }
  }

  async setPref(pref: ThemePref): Promise<void> {
    this.pref = pref;
    this.#apply(await this.#systemTheme());
    // A failed write leaves the theme applied in memory but unpersisted,
    // matching how the other settings writes behave.
    await backend.setThemePref(toStored(pref)).catch(() => {});
  }
}

export const themeState = new ThemeStore();
