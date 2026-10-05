import { describe, it, expect } from "vitest";
import { pathCandidatesIn } from "$lib/terminal/pathCandidate";

const texts = (line: string) => pathCandidatesIn(line).map((c) => c.text);

describe("pathCandidatesIn", () => {
  // Spec table from fix-terminal-path-links-never-match-a-windows-path.
  it("keeps a backslash-spelled drive path whole", () => {
    expect(texts(String.raw`C:\Users\Ada\repo\file.txt`)).toEqual([
      String.raw`C:\Users\Ada\repo\file.txt`,
    ]);
  });

  it("matches a UNC path", () => {
    expect(texts(String.raw`\\server\share\file.txt`)).toEqual([
      String.raw`\\server\share\file.txt`,
    ]);
  });

  it("keeps the drive letter on a forward-slash Windows path", () => {
    expect(texts("C:/Users/Ada/repo/file.txt")).toEqual(["C:/Users/Ada/repo/file.txt"]);
  });

  it("stops at a space rather than swallowing the rest of the line", () => {
    // Documented: spaces are not matched as a whole; a shorter non-space
    // prefix may still be offered and the resolver rejects it.
    expect(texts("C:/Users/Ada/My Documents/x.txt")).toEqual(["C:/Users/Ada/My"]);
  });

  it("does not treat a date as a path", () => {
    expect(texts("09/24/2026  10:12 AM  <DIR>")).toEqual([]);
  });

  it("still matches the POSIX arms", () => {
    expect(texts("/usr/local/bin/gavin")).toEqual(["/usr/local/bin/gavin"]);
    expect(texts("~/CloudStation/Coding/gavin/README.md")).toEqual([
      "~/CloudStation/Coding/gavin/README.md",
    ]);
    expect(texts("./src/main.rs")).toEqual(["./src/main.rs"]);
    expect(texts("../crates/daemon/src/lib.rs")).toEqual(["../crates/daemon/src/lib.rs"]);
  });

  it("does not swallow a rustc line/column suffix", () => {
    // `:` stays out of the run class so the drive arm can keep its own
    // leading alternative without turning `file.rs:12:5` into one token.
    expect(texts("error: ./src/main.rs:12:5: something")).toEqual(["./src/main.rs"]);
    expect(texts(String.raw`C:\Users\Ada\repo\file.rs:12:5`)).toEqual([
      String.raw`C:\Users\Ada\repo\file.rs`,
    ]);
  });
});
