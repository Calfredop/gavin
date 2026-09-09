import { describe, it, expect } from "vitest";
import { allSources } from "./sources";

// `open` LAUNCHES: on macOS it starts an `.app` bundle outright and
// hands anything else to its registered handler. The capability used to
// grant `opener:allow-open-path` over `/**` and `**` and `opener:default`
// (whose `allow-reveal-item-in-dir` has no scope at all), so from a
// compromised page either one took any path on disk (AS-09/R5).
//
// Both now go through fileviewer.rs, which answers them against the open
// workspace roots. Nothing in a suite notices if that is undone: putting
// the permission back makes the plugin's own `openPath` work again, so a
// re-added call site would pass its own tests and every other suite
// stays green. This is the guard for that -- it reads the two sources
// the arrangement actually rests on.

const CAPABILITY = import.meta.glob("../../src-tauri/capabilities/default.json", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const FRONTEND = {
  ...allSources(),
  ...(import.meta.glob("../routes/*.svelte", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>),
};

describe("the opener plugin holds no path permission", () => {
  const capability = Object.values(CAPABILITY)[0];

  it("reads the capability file", () => {
    expect(capability).toBeTruthy();
  });

  it("grants no path-taking opener permission", () => {
    const permissions = JSON.stringify(JSON.parse(capability).permissions);
    expect(permissions).not.toContain("opener:allow-open-path");
    // `opener:default` is allow-open-url + allow-default-urls +
    // allow-reveal-item-in-dir; the third is the unscoped one, so the
    // two that are wanted are named individually.
    expect(permissions).not.toContain("opener:default");
    expect(permissions).not.toContain("opener:allow-reveal-item-in-dir");
  });

  it("keeps the URL half, whose scheme scope lives in allow-default-urls", () => {
    const permissions = JSON.parse(capability).permissions as unknown[];
    expect(permissions).toContain("opener:allow-open-url");
    expect(permissions).toContain("opener:allow-default-urls");
  });
});

describe("no frontend module reaches for the plugin's path openers", () => {
  it("imports only openUrl from @tauri-apps/plugin-opener", () => {
    const offenders: string[] = [];
    for (const [file, source] of Object.entries(FRONTEND)) {
      for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@tauri-apps\/plugin-opener"/g)) {
        const named = match[1].split(",").map((n) => n.trim()).filter(Boolean);
        const forbidden = named.filter((n) => n !== "openUrl");
        if (forbidden.length) offenders.push(`${file}: ${forbidden.join(", ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
