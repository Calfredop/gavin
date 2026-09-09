// Small path helpers shared by the file editor and its callers.
// (Syntax-highlighting language selection lives in codeMirror.ts.)

// Lowercased extension of a path, or "" when there is none. Only looks
// at the final path segment, so a dot in a parent directory
// (/tmp/my.dir/plainfile) is never mistaken for an extension.
export function fileExtension(path: string): string {
  const base = path.split("/").filter(Boolean).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function isMarkdown(path: string): boolean {
  const ext = fileExtension(path);
  return ext === "md" || ext === "markdown";
}


/// Whether gavin's own viewer can render this path, given the extension
/// list the Rust side owns (`fileviewer.rs`'s VIEWABLE_EXTENSIONS, over
/// the `viewable_extensions` command). Everything else -- images, video,
/// binaries, anything unrecognized -- belongs to the OS's default
/// application, which is the PRD's existing rule for binaries.
///
/// Pure, and the list is a parameter, so the rule can be tested without
/// a backend: `isViewableInApp` below is the caching wrapper the real
/// callers use.
export function isViewableExtension(path: string, viewableExtensions: string[]): boolean {
  return viewableExtensions.includes(fileExtension(path));
}

// Fetched once, lazily, and shared by every caller -- the list is a
// compile-time constant on the Rust side, so re-fetching per hover or
// per chip would be pure overhead. A failed fetch caches `[]`, which
// sends everything to the OS: the wrong-but-harmless direction.
let viewableExtensionsCache: string[] | null = null;

/// The extension list itself, through the same one cache.
///
/// For a surface that has to answer the question SYNCHRONOUSLY, many
/// times, for rows it is already rendering: the Files tree labels every
/// row by where it would open, and awaiting a promise per row (or
/// keeping a second copy of a compile-time constant) would be the two
/// wrong ways to do it. Fetched once here, held by the caller, and
/// answered with `isViewableExtension`.
export async function loadViewableExtensions(): Promise<string[]> {
  if (viewableExtensionsCache === null) {
    const backend = await import("$lib/backend");
    viewableExtensionsCache = await backend.viewableExtensions().catch(() => []);
  }
  return viewableExtensionsCache;
}

/// The one place that decides "gavin's viewer or the OS's app" -- a
/// terminal path link and a card's attachment chip must not disagree
/// about the same file.
///
/// `backend` is imported dynamically so this module stays free of a
/// static Tauri dependency; everything above is pure path arithmetic and
/// is tested as such.
export async function isViewableInApp(path: string): Promise<boolean> {
  return isViewableExtension(path, await loadViewableExtensions());
}

/** @internal test-only reset for the module-level cache */
export function __resetViewableCacheForTesting(): void {
  viewableExtensionsCache = null;
}
