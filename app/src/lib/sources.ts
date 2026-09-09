/// One recursive raw-source map for `$lib`, keyed by bare file name.
///
/// About sixty tests in this tree read their subject's SOURCE TEXT rather
/// than its exports -- mounting the real component needs a daemon, a
/// window and a PTY, so the guard reads the markup instead. Every one of
/// them used to build its own map with `import.meta.glob("./*.svelte")`,
/// and that glob answers "what sits beside me in this folder", which is a
/// fact about the directory layout rather than about the app.
///
/// That made the layout load-bearing. Moving one component into a
/// subfolder rewrites what those guards cover: most would throw
/// `no source for X` and fail loudly, but the four that sweep
/// `Object.entries(SOURCES)` instead of naming a file
/// (absolutePaneMount, settingsSearchSurfaces, tooltipSurfaces,
/// terminalPaneSession) assert a property of every entry -- over a
/// shrunken map they pass green covering almost nothing, which is worse
/// than a deleted guard because it keeps the reviewer's confidence.
///
/// So the glob happens once, here, recursively, and a guard asks for a
/// NAME. Where the file lives is this module's problem and nobody
/// else's.
///
/// One thing the glob will not do: match this file. Vite always drops the
/// module that contains the `import.meta.glob` from its own result, so
/// `source("sources.ts")` is a miss by construction rather than by
/// exclusion.
const RAW = import.meta.glob(["./**/*.{svelte,ts}", "!./**/*.test.ts", "!./fixtures/**"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/// `./panes/TerminalPane.svelte` -> `TerminalPane.svelte`.
function baseName(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

/// `./panes/TerminalPane.svelte` -> `panes/TerminalPane.svelte`, the name
/// a colliding basename falls back to and the one an error message
/// quotes.
function libPath(key: string): string {
  return key.replace(/^\.\//, "");
}

/// Basenames claimed by more than one file. A named lookup for one of
/// these is a coin flip, so it throws instead -- an `index.ts` under two
/// folders has to be an error, not a silent answer.
const AMBIGUOUS = new Map<string, string[]>();

/// Bare name -> source text, with the ambiguous ones keyed by their
/// lib-relative path instead so that a sweep still sees every file. A
/// collision must not put a hole in the map; it may only break lookups
/// that name it.
const BY_NAME: Record<string, string> = (() => {
  const claims = new Map<string, string[]>();
  for (const key of Object.keys(RAW)) {
    const name = baseName(key);
    const paths = claims.get(name);
    if (paths) paths.push(libPath(key));
    else claims.set(name, [libPath(key)]);
  }

  const map: Record<string, string> = {};
  for (const key of Object.keys(RAW)) {
    const name = baseName(key);
    const paths = claims.get(name) as string[];
    if (paths.length > 1) {
      AMBIGUOUS.set(name, paths);
      map[libPath(key)] = RAW[key];
    } else {
      map[name] = RAW[key];
    }
  }
  return map;
})();

/// The whole map: bare name -> source text. For guards that derive their
/// subject from the sources rather than naming it.
export function allSources(): Record<string, string> {
  return { ...BY_NAME };
}

/// The entries whose name (and text) satisfy `pred`, same keying.
export function sourcesMatching(
  pred: (name: string, text: string) => boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, text] of Object.entries(BY_NAME)) {
    if (pred(name, text)) out[name] = text;
  }
  return out;
}

/// Every `.svelte` component in lib, bare name -> source text.
export function svelteSources(): Record<string, string> {
  return sourcesMatching((name) => name.endsWith(".svelte"));
}

/// Every non-test `.ts` module in lib, bare name -> source text.
export function tsSources(): Record<string, string> {
  return sourcesMatching((name) => name.endsWith(".ts"));
}

/// The source text of one file, named WITHOUT its folder --
/// `source("TerminalPane.svelte")`, wherever it currently lives.
/// Throws on a miss, and throws differently on an ambiguous basename so
/// a collision reads as a collision.
export function source(name: string): string {
  const text = maybeSource(name);
  if (text === undefined) {
    const ambiguous = AMBIGUOUS.get(name);
    if (ambiguous) {
      throw new Error(
        `ambiguous source name ${name}: ${ambiguous.join(", ")} -- ask for one of those paths`,
      );
    }
    throw new Error(`no source for ${name}`);
  }
  return text;
}

/// `source` for callers that have a fallback for a missing file. Still
/// throws on ambiguity -- a coin flip is never the right answer.
export function maybeSource(name: string): string | undefined {
  if (AMBIGUOUS.has(name)) {
    throw new Error(
      `ambiguous source name ${name}: ${(AMBIGUOUS.get(name) as string[]).join(", ")} -- ask for one of those paths`,
    );
  }
  return BY_NAME[name];
}

/// Whether lib holds a file by that bare name.
export function hasSource(name: string): boolean {
  return maybeSource(name) !== undefined;
}

/// The raw glob keys, for the floor assertion in `sources.test.ts` and
/// for a guard that genuinely needs to know where a file sits.
export function sourceKeys(): string[] {
  return Object.keys(RAW).map(libPath);
}
