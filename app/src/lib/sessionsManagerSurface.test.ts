import { describe, it, expect } from "vitest";

// The task manager is one panel reached from one place, and the two
// files that make it so are linked by nothing a type-checker can see: a
// sidebar row wired to no modal renders perfectly, and a panel that
// never stops polling type-checks fine. Both are the failure this pins.
//
// Reads the component sources rather than the rendered DOM, following
// autoCommitSurfaces.test.ts and hubTabBar.test.ts: mounting a modal to
// assert "this handler was called" tests the harness, and a component
// `<style>` is compiled away anyway.

const SOURCES = import.meta.glob("./*.svelte", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function source(name: string): string {
  const text = SOURCES[`./${name}`];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

const SIDEBAR = "Sidebar.svelte";
const PANEL = "SessionsManagerModal.svelte";
const MODAL = "Modal.svelte";

describe("the sidebar footer", () => {
  it("opens the task manager from its own row", () => {
    expect(source(SIDEBAR)).toContain("(showSessionsManager = true)");
    expect(source(SIDEBAR)).toContain("<SessionsManagerModal");
  });

  it("puts that row above Settings, which is where the card asked for it", () => {
    const footer = source(SIDEBAR).slice(source(SIDEBAR).indexOf('class="sidebar-footer"'));
    expect(footer.indexOf("showSessionsManager")).toBeLessThan(footer.indexOf("showGlobalSettings"));
  });

  it("mounts the panel only while it is open", () => {
    // It polls the daemon, which walks the process table for every
    // session. A panel kept mounted and merely hidden would have that
    // running for the life of the app.
    expect(source(SIDEBAR)).toContain("{#if showSessionsManager}");
  });
});

describe("the panel", () => {
  it("stops polling when it goes away", () => {
    // The only reason the daemon is sampling anything is that this is
    // open, so closing it has to actually stop -- and a modal in this
    // app is destroyed on close, not hidden.
    const text = source(PANEL);
    expect(text).toContain("onDestroy");
    expect(text).toContain("clearInterval(timer)");
  });

  it("guards a late poll with a counter, never with identity", () => {
    // Svelte 5 proxies $state objects, so `sample !== next` is always
    // true and cannot decide whether a reply is still wanted.
    expect(source(PANEL)).toContain("mine !== epoch");
  });

  it("does not let a failed poll become the baseline for the next rate", () => {
    const text = source(PANEL);
    const failure = text.indexOf("error = e instanceof Error");
    const shift = text.indexOf("previous = sample;");
    expect(failure).toBeGreaterThan(-1);
    expect(shift).toBeGreaterThan(failure);
  });

  it("says why the figures are missing rather than drawing empty columns", () => {
    // `min_version_for` gates the request itself, so nothing is silently
    // dropped -- but blank cells would read as "this session is using
    // nothing", which is a measurement nobody took.
    expect(source(PANEL)).toContain('featureBlockedReason($daemonCompat, "sessionMetrics")');
  });

  it("holds an empty list back until a reply has actually arrived", () => {
    // "No sessions" is the one answer a task manager must never give
    // wrongly, and it is exactly what an un-filled list looks like.
    expect(source(PANEL)).toContain("{#if loaded && rows.length === 0}");
  });

  it("routes every action through the shared confirmations", () => {
    const text = source(PANEL);
    expect(text).toContain("endAllSessions");
    expect(text).toContain("endSession");
    expect(text).toContain("jumpToSession");
  });
});

describe("the modal it sits in", () => {
  it("has a width for a table, opted into rather than assumed", () => {
    // The cap lives on Modal's own `.panel`, which is scoped -- a child
    // wider than 480px otherwise just overflows the panel it is inside.
    expect(source(MODAL)).toContain("wide = false");
    expect(source(PANEL)).toContain("<Modal {onClose} wide>");
  });
});
