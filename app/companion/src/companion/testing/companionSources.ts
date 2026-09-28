// The bundle's own source text, for the guards that read it: everything
// under `src/companion` and `src/routes` that ships, keyed by its path
// from `src/`. Suites and their helpers are left out -- they name the
// very things the guards forbid.
const RAW = import.meta.glob(
  ["../**/*.{ts,svelte}", "../../routes/**/*.{ts,svelte}", "!../**/*.test.ts", "!../testing/**"],
  { query: "?raw", import: "default", eager: true }
) as Record<string, string>;

function fromSrc(key: string): string {
  if (key.startsWith("../../routes/")) return key.slice("../../".length);
  return `companion/${key.slice("../".length)}`;
}

const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(RAW).map(([key, text]) => [fromSrc(key), text])
);

export function companionSources(): Record<string, string> {
  return { ...SOURCES };
}

export function companionSource(path: string): string {
  const text = SOURCES[path];
  if (text === undefined) throw new Error(`the bundle has no source ${path}`);
  return text;
}

/// A source with its comment lines taken out. The comments say why a
/// thing is not called, by name, and a guard must not trip on them.
export function codeOf(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*|<!--)/.test(line))
    .join("\n");
}
