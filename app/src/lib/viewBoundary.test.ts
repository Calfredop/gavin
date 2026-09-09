import { describe, it, expect } from "vitest";
import { tsSources } from "$lib/sources";

// A view that throws while it is being CREATED must not be silent.
//
// Svelte builds the new branch of an `{#if}` before it tears the old one
// down -- BranchManager.ensure() renders the branch at the anchor, and
// only then does #commit() destroy the others. So a throw on the way IN
// leaves the previous branch exactly where it was, and the update is
// abandoned half-applied: the chrome row above (a separate block, which
// already committed) flips to the shape of a branch that never appeared.
//
// Measured in WKWebView on the app's own Svelte: an `{#if}` swapping to a
// branch whose component throws left "OLD CONTENT" on screen with nothing
// thrown to the caller and nothing logged. Under a boundary the same
// throw replaced it with the failed snippet and the error's message.
//
// That is what "pressing Gavin puts a blank bar over the page I was
// already on" is, and no suite can see it: the branches type-check, the
// pure modules behind them are covered, and the failure only exists in a
// window where one of them throws at render. So what is pinned here is
// the guard, not the crash -- that the views are drawn UNDER a boundary,
// that it says what broke, and that it offers the retry.
//
// Reads the sources rather than the rendered DOM, like appHeader.test.ts
// and appHubSurface.test.ts beside it: mounting the page needs a daemon,
// and a boundary that is present is exactly what a source can show.

const ROUTES = import.meta.glob("../routes/*.svelte", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const LIB = tsSources();

function source(map: Record<string, string>, name: string): string {
  const text = map[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

const PAGE = () => source(ROUTES, "../routes/+page.svelte");

/// The span between the boundary's tags, which is what "inside it" means
/// for every assertion below. One boundary, so a plain index pair is
/// enough; a second one would make `indexOf` lie, which the first test
/// is what catches.
function boundaryBody(page: string): string {
  const open = page.indexOf("<svelte:boundary");
  const close = page.indexOf("</svelte:boundary>");
  expect(open, "the page draws its views under a <svelte:boundary>").toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return page.slice(open, close);
}

describe("the view boundary", () => {
  it("is the only one on the page, so the spans below mean what they say", () => {
    const page = PAGE();
    expect(page.match(/<svelte:boundary/g)?.length).toBe(1);
    expect(page.match(/<\/svelte:boundary>/g)?.length).toBe(1);
  });

  it("covers every branch the main pane can draw", () => {
    const body = boundaryBody(PAGE());
    // The app hub is the branch this was written for -- it is reached
    // from the sidebar rather than from a tab, so a hub that fails to
    // render is indistinguishable from a dead button.
    expect(body).toContain("{#if $appHubOpen}");
    expect(body).toContain("<AppHubView />");
    // And its siblings, because the same silence covers all of them.
    expect(body).toContain("<TerminalView workspaceId={activeWorkspace.id} />");
    expect(body).toContain("<activeViewDef.component workspaceId={activeWorkspace.id} />");
  });

  it("leaves the app's own report channel outside it", () => {
    const page = PAGE();
    const body = boundaryBody(page);
    // A degraded daemon and a refused request are caveats on a working
    // app, and they are how it says so. Drawing them inside the guard
    // would mean a broken VIEW could take the two banners that explain
    // the app's state down with it.
    expect(page).toContain("<DaemonCompatBanner />");
    expect(page).toContain("<DaemonRequestErrorBanner />");
    expect(body).not.toContain("<DaemonCompatBanner />");
    expect(body).not.toContain("<DaemonRequestErrorBanner />");
  });

  it("names what broke and offers the retry", () => {
    const body = boundaryBody(PAGE());
    expect(body).toMatch(/\{#snippet failed\(error, reset\)\}/);
    // The message on screen, not a shrug: the whole point is that the
    // human has something to report.
    expect(body).toMatch(/error instanceof Error \? error\.message : String\(error\)/);
    // `reset()` re-renders the children, which IS the recovery when the
    // cause was a hot reload that left one module half-applied.
    expect(body).toContain("onclick={reset}");
    // The stack only exists in the console, so the boundary has to put
    // it there -- `failed` alone means svelte logs nothing at all.
    expect(body).toMatch(/onerror=\{\(error\) => console\.error\(/);
  });

  it("is created by a state change and never by the page's first mount", () => {
    // svelte 5.56's boundary resolves against `current_batch` the moment
    // it is created, and a boundary with no `pending` snippet created
    // OUTSIDE a batch -- which is what a component's own synchronous
    // mount is -- fails on the spot with "batch.transfer_effects of
    // null". Measured in WKWebView, same probe as above.
    //
    // Two facts keep this one out of that hole, and they are the two
    // things this test is really pinning: the boundary sits inside the
    // `ready` branch, and the app cannot mount already ready. So it is
    // always created by a store update, i.e. inside a batch.
    const page = PAGE();
    const connecting = page.indexOf('$layoutState.status === "connecting"');
    const boundary = page.indexOf("<svelte:boundary");
    expect(connecting).toBeGreaterThan(-1);
    expect(boundary).toBeGreaterThan(connecting);
    expect(source(LIB, "layoutState.ts")).toMatch(/const initialState[\s\S]*?status: "connecting"/);
  });
});
