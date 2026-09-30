// The publisher's bundle-signing key, pinned (ADR 0005, story 78).
//
// A store build of the Companion runs only a bundle whose signature
// checks against this key. It is the public half of the seed the release
// workflow holds as `GAVIN_BUNDLE_SIGNING_KEY`; the workflow's preflight
// derives the public half of its secret and refuses to build unless it
// is the one written here (`app/src-tauri/companion-key.mjs public`).
//
// Separate from the updater's minisign key on purpose: that one signs
// what an install runs as itself, this one signs what a phone runs next
// to its keys for every other Workstation, and a leak of either must not
// be a leak of both.
//
// Null until the human has made the key (`companion-key.mjs generate`)
// and pinned it here. Until then a store build trusts no key at all and
// refuses every bundle, saying so -- the honest state, and a loud one --
// while a debug build still runs what the dev key signed.
export const PUBLISHER_KEY: string | null = null;
