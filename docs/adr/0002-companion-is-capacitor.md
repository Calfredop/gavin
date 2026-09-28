# The Companion is a Capacitor app, not Tauri mobile

The desktop app is Tauri. Its webview never speaks the daemon protocol: every call goes through a Tauri command to Rust (`app/src/lib/core/backend.ts`), and the Rust side owns the wire format, the Noise handshake (`snow`) and the pairing SAS (`protocol::pairing_sas`). Tauri mobile would have let the Companion reuse that Rust as it is.

We chose Capacitor anyway. It has first-party push notifications on both iOS and Android; Tauri has no official push plugin, and its draft (plugins-workspace #2066) is still open. Its mobile toolchain is also more mature. The UI stays Svelte 5, styled the desktop's way, so that desktop components and their `.ts` logic can be shared.

## Consequences

The Companion has no Rust host. The protocol client — framing, the Noise handshake, the post-handshake hardware signature (ADR 0001) and the pairing SAS — has to reach its web layer another way: compiled from Rust to WASM, rewritten in TypeScript, or supplied by native plugins. The pairing SAS must match the daemon's byte for byte, so whatever is not shared as code needs cross-implementation test vectors.
