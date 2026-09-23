// The recovery in dev-sidecars.mjs turns on one platform fact -- a running
// Windows image can be renamed but not unlinked -- and on a state machine
// that must leave the tree untouched when the build fails. Both are easy to
// get subtly wrong in a way no dev run reports: the tree just quietly loses
// `gavin-mcp.exe`, and the next `resolve_mcp_binary_path` bails.
//
// So the state machine is tested with injected fakes, on every platform, and
// the platform fact is tested once against a real running process on Windows.

import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  SIDECARS,
  debugBinaryPaths,
  diagnoseFailure,
  freeParkPath,
  holdersOf,
  isHeldOpen,
  parkHeldBinaries,
  restoreUnwritten,
  sweepParked,
} from "./dev-sidecars.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "dev-sidecars-"));

describe("debugBinaryPaths", () => {
  // Absolute and resolved, because a build script's cwd is not its own: the
  // expectations go through `resolve` for the same reason the code does.
  const under = (base, ...rest) => join(resolve(base), ...rest);

  it("names both sidecars under target/debug", () => {
    expect(debugBinaryPaths("/repo", {}, "linux")).toEqual([
      under("/repo", "target", "debug", "gavin-daemon"),
      under("/repo", "target", "debug", "gavin-mcp"),
    ]);
  });

  it("adds the Windows executable suffix", () => {
    expect(debugBinaryPaths("/repo", {}, "win32").every((p) => p.endsWith(".exe"))).toBe(true);
  });

  it("honours an absolute CARGO_TARGET_DIR, where the app's own binary lands too", () => {
    const paths = debugBinaryPaths("/repo", { CARGO_TARGET_DIR: resolve("/shared") }, "linux");
    expect(paths[0]).toBe(under("/shared", "debug", "gavin-daemon"));
  });

  it("resolves a relative CARGO_TARGET_DIR against the root, the way cargo does", () => {
    const paths = debugBinaryPaths(resolve("/repo"), { CARGO_TARGET_DIR: "build/out" }, "linux");
    expect(paths[0]).toBe(under("/repo", "build", "out", "debug", "gavin-daemon"));
  });
});

describe("freeParkPath", () => {
  it("takes .locked-1 when nothing is parked", () => {
    expect(freeParkPath("/t/gavin-mcp.exe", () => false)).toBe("/t/gavin-mcp.exe.locked-1");
  });

  it("steps past copies whose holders are still alive", () => {
    const taken = new Set(["/t/gavin-mcp.exe.locked-1", "/t/gavin-mcp.exe.locked-2"]);
    expect(freeParkPath("/t/gavin-mcp.exe", (p) => taken.has(p))).toBe("/t/gavin-mcp.exe.locked-3");
  });

  it("refuses to park forever", () => {
    expect(() => freeParkPath("/t/gavin-mcp.exe", () => true)).toThrow(/200 parked copies/);
  });
});

describe("sweepParked", () => {
  it("removes parked sidecars and leaves everything else alone", () => {
    const dir = scratch();
    for (const name of [
      "gavin-mcp.exe.locked-1",
      "gavin-daemon.exe.locked-7",
      "gavin-mcp.exe",
      "app.exe",
      "gavin-mcp.exe.locked-x",
    ]) {
      writeFileSync(join(dir, name), "x");
    }

    expect(sweepParked(dir)).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(["app.exe", "gavin-mcp.exe", "gavin-mcp.exe.locked-x"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("is a no-op before the first build has made a target dir", () => {
    expect(sweepParked(join(tmpdir(), "dev-sidecars-does-not-exist"))).toBe(0);
  });
});

describe("parkHeldBinaries", () => {
  it("parks only what is actually held", () => {
    const moves = [];
    const parked = parkHeldBinaries(["/t/gavin-daemon.exe", "/t/gavin-mcp.exe"], {
      held: (p) => p.endsWith("gavin-mcp.exe"),
      move: (from, to) => moves.push([from, to]),
    });

    expect(moves).toEqual([["/t/gavin-mcp.exe", "/t/gavin-mcp.exe.locked-1"]]);
    expect(parked).toEqual([{ path: "/t/gavin-mcp.exe", to: "/t/gavin-mcp.exe.locked-1" }]);
  });

  it("reports a rename it could not do and still lets the build run", () => {
    const logged = [];
    const parked = parkHeldBinaries(["/t/gavin-mcp.exe"], {
      held: () => true,
      move: () => {
        const err = new Error("nope");
        err.code = "EPERM";
        throw err;
      },
      log: (m) => logged.push(m),
    });

    expect(parked).toEqual([]);
    expect(logged.join("\n")).toMatch(/could not park gavin-mcp\.exe \(EPERM\); building anyway/);
  });
});

describe("restoreUnwritten", () => {
  it("puts the name back when cargo linked nothing there", () => {
    const moves = [];
    const restored = restoreUnwritten([{ path: "/t/gavin-mcp.exe", to: "/t/gavin-mcp.exe.locked-1" }], {
      exists: () => false,
      move: (from, to) => moves.push([from, to]),
    });

    expect(moves).toEqual([["/t/gavin-mcp.exe.locked-1", "/t/gavin-mcp.exe"]]);
    expect(restored).toEqual(["/t/gavin-mcp.exe"]);
  });

  it("leaves a freshly linked binary alone", () => {
    const moves = [];
    const restored = restoreUnwritten([{ path: "/t/gavin-mcp.exe", to: "/t/gavin-mcp.exe.locked-1" }], {
      exists: () => true,
      move: (from, to) => moves.push([from, to]),
    });

    expect(moves).toEqual([]);
    expect(restored).toEqual([]);
  });
});

describe("diagnoseFailure", () => {
  it("says nothing when no sidecar is held -- cargo already explained itself", () => {
    expect(diagnoseFailure(["/t/gavin-mcp.exe"], { held: () => false, holders: () => [] })).toEqual([]);
  });

  it("names the pids and leaves the decision with the developer", () => {
    const path = "/r/target/debug/gavin-mcp.exe";
    const lines = diagnoseFailure([path], {
      held: () => true,
      holders: () => [
        { pid: 4120, path },
        // Windows spells the same file either case, and `Get-Process` is not
        // obliged to spell it the way the build script did.
        { pid: 9004, path: path.toUpperCase() },
      ],
    }).join("\n");

    expect(lines).toMatch(/pid 4120/);
    expect(lines).toMatch(/pid 9004/);
    expect(lines).toMatch(/your call/);
    // The one thing this must never suggest it has done or will do.
    expect(lines).not.toMatch(/\bkill(ed|ing)?\b/i);
  });

  it("does not offer up a same-named process from another checkout", () => {
    // One machine routinely runs both: a developer told to weigh stopping a
    // pid that cannot be holding their file is worse served than one told
    // nothing at all.
    const lines = diagnoseFailure(["/mine/target/debug/gavin-mcp.exe"], {
      held: () => true,
      holders: () => [{ pid: 860, path: "/theirs/target/debug/gavin-mcp.exe" }],
    }).join("\n");

    expect(lines).not.toMatch(/pid 860/);
    expect(lines).toMatch(/No process on this machine is running that image/);
    expect(lines).toMatch(/another\n {2}checkout's copy; they do not hold this one/);
  });

  it("says so when the holder is not a process running that image", () => {
    const lines = diagnoseFailure(["/t/gavin-mcp.exe"], { held: () => true, holders: () => [] }).join("\n");
    expect(lines).toMatch(/No process on this machine is running that image/);
    expect(lines).not.toMatch(/checkout's copy/);
  });
});

describe("holdersOf", () => {
  const fakePs = (stdout) => () => ({ status: 0, stdout });

  it("parses pid and path out of the PowerShell lines", () => {
    const out = holdersOf(
      "C:/r/target/debug/gavin-mcp.exe",
      fakePs("4120 C:\\r\\target\\debug\\gavin-mcp.exe\r\n9004 C:\\other\\gavin-mcp.exe\r\n"),
      "win32",
    );
    expect(out).toEqual([
      { pid: 4120, path: "C:\\r\\target\\debug\\gavin-mcp.exe" },
      { pid: 9004, path: "C:\\other\\gavin-mcp.exe" },
    ]);
  });

  it("drops a process whose path PowerShell could not read", () => {
    expect(holdersOf("C:/r/gavin-mcp.exe", fakePs("4120\r\n"), "win32")).toEqual([]);
  });

  it("asks nothing off Windows, where none of this is reachable", () => {
    let asked = false;
    holdersOf(
      "/r/target/debug/gavin-mcp",
      () => {
        asked = true;
        return { status: 0, stdout: "" };
      },
      "darwin",
    );
    expect(asked).toBe(false);
  });
});

// The platform fact the whole route rests on. Skipped off Windows, where
// cargo's unlink works and none of this is reachable.
describe.skipIf(process.platform !== "win32")("a running image on Windows", () => {
  const settle = async (pred, ms = 5000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return pred();
  };

  it("is held against a write, and parks without disturbing the process", async () => {
    const dir = scratch();
    // Named as the sidecar so the park/sweep name rules are exercised by the
    // same file, and copied from node so it is a real running image.
    const binary = join(dir, "gavin-mcp.exe");
    copyFileSync(process.execPath, binary);

    const child = spawn(binary, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    let parked = [];
    try {
      expect(await settle(() => isHeldOpen(binary))).toBe(true);

      parked = parkHeldBinaries([binary], {});
      expect(parked).toHaveLength(1);
      expect(existsSync(binary)).toBe(false);
      expect(existsSync(parked[0].to)).toBe(true);
      expect(child.exitCode).toBe(null); // still serving, out of the parked file

      // What cargo does next, now that the name is free.
      copyFileSync(process.execPath, binary);
      expect(restoreUnwritten(parked, {})).toEqual([]);
      expect(existsSync(binary)).toBe(true);

      // And the parked copy cannot be swept while its holder lives.
      expect(sweepParked(dir)).toBe(0);
      expect(existsSync(parked[0].to)).toBe(true);
    } finally {
      child.kill();
    }

    // Once it has exited, the next dev start's sweep collects it.
    expect(
      await settle(() => {
        sweepParked(dir);
        return !existsSync(parked[0].to);
      }),
    ).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  }, 20000);

  it("is not reported as held when it is only a file", () => {
    const dir = scratch();
    const path = join(dir, `${SIDECARS[1]}.exe`);
    writeFileSync(path, "not an image");
    expect(isHeldOpen(path)).toBe(false);
    expect(isHeldOpen(join(dir, "absent.exe"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
