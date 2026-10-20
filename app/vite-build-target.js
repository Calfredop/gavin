/// The engines a production build compiles for, shared by every Vite config
/// that bundles the desktop's terminal: this app's and the Companion
/// bundle's (`companion/vite.config.js`).
///
/// Not Vite's default (`"modules"`): that list holds `es2020` and
/// `firefox78`, neither of which has ES2021's logical assignment, so the
/// build lowers every `||=` -- and esbuild, lowering and minifying xterm's
/// `let r; (...)(r ||= {})` in `requestMode`, drops the `let` and keeps the
/// write. The first DECRQM query (`CSI ? Ps $ p`) then throws a
/// ReferenceError inside xterm's write loop, and the terminal never draws
/// another byte. Claude Code asks one as it starts, so `claude` typed into
/// a plain tab froze the release app's terminal on the command line. `vite
/// dev` serves xterm unlowered, which is why only a built app showed it.
///
/// What actually runs these bundles: WKWebView (macOS, iOS) and WebKitGTK,
/// as `safari14` -- the floor the default already held -- and WebView2 and
/// Android's System WebView, as `chrome105`, the floor Tauri's own template
/// gives Windows. Both have logical assignment, so no `||=` is lowered.
/// `vite-build-target.test.mjs` compiles xterm for this list the way a
/// release does and sends it that query.
export const buildTarget = ["safari14", "chrome105"];
