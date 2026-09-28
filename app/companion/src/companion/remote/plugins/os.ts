// The remote shim for `@tauri-apps/plugin-os`.
//
// "Which platform is this?" has one answer on the desk and two on a
// Device. The desktop asks it to decide which keys a shortcut is drawn
// with -- the machine in the human's hand -- and how a command is quoted
// before it is run -- the Workstation. Answering for either would be
// wrong for the other, and the second is the one that breaks things: a
// card's prompt quoted for the phone and run on a Windows desk.
//
// So this declines, exactly as the plugin does outside a Tauri window,
// and the desktop's `platform.ts` reads that as "cannot be told", which
// gates nothing. The Workstation's platform belongs in what the channel
// says about the Workstation, the day a surface needs it.
export type Platform = "linux" | "macos" | "ios" | "freebsd" | "dragonfly" | "netbsd" | "openbsd" | "solaris" | "android" | "windows";

export function platform(): Platform {
  throw new Error("the Companion does not answer for a platform");
}
