import { describe, expect, it } from "vitest";
import {
  DEFAULT_HEADROOM,
  headroomWorkspaces,
  headroomWorkspacesKey,
  normalizeHeadroom,
  resolveHeadroom,
} from "./compression";

describe("normalizeHeadroom", () => {
  it("keeps a boolean and reads everything else as nothing chosen", () => {
    expect(normalizeHeadroom(true)).toBe(true);
    expect(normalizeHeadroom(false)).toBe(false);
    for (const garbled of [undefined, null, "on", "true", 1, 0, {}, []]) {
      expect(normalizeHeadroom(garbled)).toBeNull();
    }
  });
});

describe("resolveHeadroom", () => {
  it("starts off", () => {
    expect(DEFAULT_HEADROOM).toBe(false);
    expect(resolveHeadroom(undefined, null)).toBe(false);
  });

  it("takes the workspace's own choice over the app-wide one, either way", () => {
    expect(resolveHeadroom(true, false)).toBe(true);
    expect(resolveHeadroom(false, true)).toBe(false);
  });

  it("falls through to the app-wide default for a workspace that never chose", () => {
    expect(resolveHeadroom(undefined, true)).toBe(true);
    expect(resolveHeadroom(undefined, false)).toBe(false);
  });

  it("falls through a garbled workspace value rather than reading it as a choice", () => {
    expect(resolveHeadroom("yes", true)).toBe(true);
    expect(resolveHeadroom("yes", "yes")).toBe(false);
  });
});

describe("headroomWorkspaces", () => {
  it("resolves each workspace against the app-wide default", () => {
    const workspaces = [
      { rootPath: "/work/on", headroom: true },
      { rootPath: "/work/off", headroom: false },
      { rootPath: "/work/inherits" },
    ];

    expect(headroomWorkspaces(workspaces, null)).toEqual([
      { workspacePath: "/work/inherits", enabled: false },
      { workspacePath: "/work/off", enabled: false },
      { workspacePath: "/work/on", enabled: true },
    ]);
    expect(headroomWorkspaces(workspaces, true)).toEqual([
      { workspacePath: "/work/inherits", enabled: true },
      { workspacePath: "/work/off", enabled: false },
      { workspacePath: "/work/on", enabled: true },
    ]);
  });

  it("leaves out a workspace with no root", () => {
    // The host writes an unset root as `null`, whatever the type says.
    const fromTheHost = { rootPath: null as unknown as undefined, headroom: true };

    expect(
      headroomWorkspaces([fromTheHost, { rootPath: "  ", headroom: true }, { headroom: true }], true),
    ).toEqual([]);
  });

  // Its sessions are its host daemon's. Sent as on, it would keep a local
  // Headroom running for sessions that can never reach it.
  it("leaves out an ssh workspace, whatever its switch says", () => {
    const list = headroomWorkspaces(
      [
        { rootPath: "/srv/app", headroom: true, ssh: { host: "build-box" } },
        { rootPath: "/work/local", headroom: true },
      ],
      true,
    );

    expect(list).toEqual([{ workspacePath: "/work/local", enabled: true }]);
  });

  it("counts one root opened twice as on when either workspace is", () => {
    const twice = [
      { rootPath: "/work/gavin", headroom: false },
      { rootPath: "/work/gavin", headroom: true },
    ];

    expect(headroomWorkspaces(twice, null)).toEqual([{ workspacePath: "/work/gavin", enabled: true }]);
    expect(headroomWorkspaces([...twice].reverse(), null)).toEqual([
      { workspacePath: "/work/gavin", enabled: true },
    ]);
  });

  it("is the same list whatever order the workspaces are in", () => {
    const a = { rootPath: "/work/a", headroom: true };
    const b = { rootPath: "/work/b" };

    expect(headroomWorkspaces([a, b], false)).toEqual(headroomWorkspaces([b, a], false));
  });
});

describe("headroomWorkspacesKey", () => {
  it("is shared by equal lists and by nothing else", () => {
    const on = [{ workspacePath: "/work/a", enabled: true }];

    expect(headroomWorkspacesKey(on)).toBe(headroomWorkspacesKey([{ ...on[0] }]));
    expect(headroomWorkspacesKey(on)).not.toBe(
      headroomWorkspacesKey([{ workspacePath: "/work/a", enabled: false }]),
    );
    expect(headroomWorkspacesKey(on)).not.toBe(
      headroomWorkspacesKey([{ workspacePath: "/work/b", enabled: true }]),
    );
    expect(headroomWorkspacesKey(on)).not.toBe(headroomWorkspacesKey([]));
  });

  // An empty list is a real answer -- the last workspace was closed --
  // and must not look like "nothing was ever sent".
  it("gives the empty list a key of its own", () => {
    expect(headroomWorkspacesKey([])).toBe("[]");
  });
});
