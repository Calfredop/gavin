---
order: 35840
kind: task
title: Companion: the phone has no appearance of its own; the Workstation's UI takes the desk's theme and the hub takes the phone's
status: Done
priority: low
complexity: moderate
---
Found by `companion-iphone-smoke-tests.md` (E5) on a physical iPhone 16 Pro, with the owner switching Light and Dark from Control Center.

**Measured.**
- Phone in Light: the hub (`capacitor://localhost`) is white, `data-theme="light"`. A paired Workstation's UI (`gavin-bundle://ws-...`) is dark, `data-theme="dark"`, `rgb(30,30,30)`. Opening a Workstation flips the screen from white to dark.
- Phone in Dark: both are dark.
- Why: the bundle reuses the desktop's `app/src/lib/ui/themeState.svelte.ts`, whose preference comes from the Workstation (`get_theme_pref` over the channel). The Workstation's stored preference is the literal `"dark"` (asked directly: `invoke get_theme_pref` returned `"dark"`), so the phone obeys the desk. Only a desk set to `system` would follow the phone: `remote/window.ts` already maps `system` to the phone's appearance ("System on a phone is the phone's appearance, not the desk's").
- The Workstation's settings screen on the phone (`PhoneAppSettings.svelte`) has a theme control, and it writes THE DESK'S theme: changing it on the phone changes the desk.

**The question.** Should the phone have its own appearance? A person who keeps the desk dark and the phone in Light gets a white hub and a dark UI, and cannot make the UI light without changing the desk. The opposite choice (always follow the phone) means the same Workstation looks different on the two screens, which may be right for a phone.

**Options.**
- A. Leave it: the Workstation's theme is the Workstation's. Document it, and say on the phone's theme control that it changes the desk too.
- B. A per-Device appearance stored on the Device (like the view state, `gavin.companion.view.<workstation id>`): `Follow the Workstation` (default), `Follow this phone`, `Light`, `Dark`; the bundle applies it and never writes the desk's pref from the phone.
- C. Make the hub follow the Workstation's theme once one is known.

**To do.** Get the owner's choice (a Decision is filed on this card). B is the small one: a Device-side preference read by the bundle's theme init, one new control in the phone's settings, and the existing desk theme control moved out of the phone's way.

**Acceptance.**
- [x] The chosen behaviour is documented in `app/companion/README.md`
- [x] With the phone in Light and the desk on Dark the result is the one the owner chose, with no write to the desk's theme unless the owner presses the desk's control
- [x] The terminal (xterm reads colours from JS options, `applyTerminalTheme`) follows the same theme
- [x] Decision: What appearance should an open Workstation's UI use on the phone?
  Options: A) A) The Workstation's theme (as today); document it and say the phone's theme control changes the desk too B) B) A per-Device choice (follow the Workstation, follow this phone, light, dark) that never writes the desk's theme C) C) Always follow the phone's appearance
  Answer (2026-10-09): B) A per-Device choice (follow the Workstation, follow this phone, light, dark) that never writes the desk's theme

**Built (B).**
- `app/companion/src/companion/state/appearance.ts`: the choice (`workstation` default, `phone`, `light`, `dark`) under `gavin.companion.appearance.<workstation id>` in the bundle's own storage, mapped to a theme preference (`phone` = the bundle's `system`, which `remote/window.ts` already answers with the phone's appearance).
- `app/src/lib/ui/themeState.svelte.ts`: a `local` preference that wins over the stored one and is never written (`setLocal`); the desk never sets it. `#apply` still stamps `data-theme` and calls `applyTerminalTheme`, so the terminal follows the same theme.
- `workstation.ts`: reads the choice at connect, before the desk's theme is asked for; `setAppearance` keeps it on the Device and writes nothing to the Workstation.
- `PhoneAppSettings.svelte` → Appearance: **On this phone** (Desk | Phone | Light | Dark) first, then the desk's control relabelled **The desk's theme**, with a hint that it changes the desk.
- Tests: `state/appearance.test.ts`, `seam/appearance.test.ts` (desk Dark + phone Light draws light when chosen, terminal included; Control Center turns follow on Phone; no `set_*` crosses the wire; the desk's control still writes the desk). companion:test 851/851, npm test green, both checks 0 errors, companion:build ok.

- [ ] Human test: On the iPhone with the desk on Dark, open a Workstation, then Settings → Appearance → On this phone: Desk shows it dark; Phone follows Light and Dark as you toggle them in Control Center (screen and an open terminal both); Light and Dark hold whatever Control Center says; the desk's own window never changes theme while you do this
