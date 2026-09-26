import { describe, it, expect } from "vitest";
import { svelteSources } from "$lib/sources";

// `read_file_for_viewer` answers off the main thread, so two reads of
// one file can answer out of order -- the main thread used to be what
// kept them in line. The two surfaces that re-read a file on every
// `file-changed` are where that bites: an older copy landing last rolls
// an editor's buffer back, or puts back a checklist tick the card no
// longer has. Nothing else in the suite can see it; every mock answers
// in the order it was asked.
//
// So every read there takes a ticket before it asks and checks it after
// it lands. Reads the component sources rather than mounting them,
// following autoCommitSurfaces.test.ts: the editor needs a watcher and
// the modal a daemon, and the property is where the ticket sits.

const SOURCES = svelteSources();

function source(name: string): string {
  const text = SOURCES[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

/// For each read, the text between the previous read and it (where the
/// ticket must be taken) and the text from it to the next read (where it
/// must be checked). Every call, awaited or chained: the modal's watched
/// read was a bare `.then` before it had a ticket.
function readSites(text: string): { before: string; after: string }[] {
  const call = "backend.readFileForViewer(";
  const at: number[] = [];
  for (let i = text.indexOf(call); i !== -1; i = text.indexOf(call, i + 1)) at.push(i);
  return at.map((start, n) => ({
    before: text.slice(n === 0 ? 0 : at[n - 1], start),
    after: text.slice(start, at[n + 1] ?? text.length),
  }));
}

function expectEveryReadTicketed(file: string, ticket: string): void {
  const sites = readSites(source(file));
  expect(sites.length, `no reads left in ${file}`).toBeGreaterThan(0);
  for (const { before, after } of sites) {
    expect(before).toContain(`const mine = ++${ticket};`);
    expect(after).toMatch(new RegExp(`mine (!==|===) ${ticket}`));
  }
}

describe("reads that can answer out of order land newest-first", () => {
  it("the file editor: its first load and every external-change re-read", () => {
    expectEveryReadTicketed("FileEditor.svelte", "readTicket");
  });

  it("the file editor drops a read of the path it was just renamed off", () => {
    // Otherwise the old path's answer -- "not there" -- would mark the
    // file deleted under a buffer that moved with it.
    const retarget = /\$effect\(\(\) => \{\s*const next = path;[\s\S]*?\n {2}\}\);/.exec(
      source("FileEditor.svelte")
    );
    expect(retarget).not.toBeNull();
    expect(retarget![0]).toContain("readTicket += 1;");
  });

  it("the card modal: the watched read, the checklist re-read and the auto-commit read", () => {
    expectEveryReadTicketed("CardDetailModal.svelte", "contentTicket");
    // A write it just made outranks any read still in flight.
    expect(source("CardDetailModal.svelte")).toMatch(
      /function landContent\(next: string\): void \{\s*contentTicket \+= 1;/
    );
  });
});
