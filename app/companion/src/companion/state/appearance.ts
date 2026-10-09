// The phone's own appearance for a Workstation's UI, kept on the Device.
//
// The Workstation's theme is the desk's: stored in its config, written by
// its Settings. A phone that obeyed it alone drew a dark UI under a white
// hub whenever the desk was dark and the phone was in Light, and the only
// way to change that was to change the desk
// (`companion-phone-has-no-appearance-of-its-own.md`). So the phone keeps
// a choice of its own, beside its view state and never in the
// Workstation's config: what happens on the phone does not rearrange the
// desk (spec, story 35).
//
// Pure: the theme store that applies it is the desktop's
// (`themeState.svelte.ts`, its `local` preference), and the store that
// reads and writes it is workstation.ts.
import type { ThemePref } from "$lib/ui/theme";
import type { ViewStorage } from "$companion/state/viewState";

/// Follow the Workstation's theme (as the desk draws it), follow the
/// phone's own Light and Dark, or one of the two whatever either says.
export const APPEARANCES = ["workstation", "phone", "light", "dark"] as const;
export type Appearance = (typeof APPEARANCES)[number];

/// The default is the Workstation's theme: what a phone did before it had
/// a choice, so nobody's screen changes until they choose.
export const DEFAULT_APPEARANCE: Appearance = "workstation";

export function appearanceKey(workstationId: string): string {
  return `gavin.companion.appearance.${workstationId}`;
}

function isAppearance(value: unknown): value is Appearance {
  return (APPEARANCES as readonly unknown[]).includes(value);
}

/// What was chosen for a Workstation on this Device, or the default.
/// Never throws: storage on a phone can be absent, or refuse the read.
export function loadAppearance(storage: ViewStorage | null, workstationId: string): Appearance {
  try {
    const stored = storage?.getItem(appearanceKey(workstationId)) ?? null;
    return isAppearance(stored) ? stored : DEFAULT_APPEARANCE;
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function saveAppearance(storage: ViewStorage | null, workstationId: string, appearance: Appearance): void {
  try {
    storage?.setItem(appearanceKey(workstationId), appearance);
  } catch {
    // Nothing to do: the choice still holds until the page goes.
  }
}

/// The preference the theme store holds over the Workstation's, or null
/// to follow it. "System" in the bundle is the phone's appearance
/// (`remote/window.ts`), so following the phone is the bundle's system.
export function localThemePref(appearance: Appearance): ThemePref | null {
  switch (appearance) {
    case "workstation":
      return null;
    case "phone":
      return "system";
    default:
      return appearance;
  }
}
