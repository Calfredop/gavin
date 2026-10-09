import { describe, it, expect } from "vitest";
import { deepLinkFor, readNotifyLink, NOTIFY_GENERIC_BODY, type OpenedNotifyBody } from "./decrypt";

describe("deepLinkFor", () => {
  it("opens the hub when decrypt failed", () => {
    expect(deepLinkFor(null, "ws-1")).toBe("gavin://hub");
  });

  it("opens the session on a notify", () => {
    expect(
      deepLinkFor(
        {
          op: "notify",
          id: "session:s1",
          target: { type: "session", session_id: "s1" },
        },
        "ws-1",
      ),
    ).toBe("gavin://ws/ws-1/session/s1");
  });

  it("keeps the generic body string stable", () => {
    expect(NOTIFY_GENERIC_BODY).toBe("Something on your Workstation changed.");
  });
});

describe("readNotifyLink", () => {
  it("reads the session and the workspace a tap lands on", () => {
    expect(readNotifyLink("gavin://ws/ws-1/session/s1?workspace=ws")).toEqual({
      workstationId: "ws-1",
      landing: { workspace: "ws", target: { kind: "session", id: "s1" } },
    });
  });

  it("opens the Workstation where it opens when the link names no workspace or no target", () => {
    expect(readNotifyLink("gavin://ws/ws-1/session/s1")).toEqual({ workstationId: "ws-1", landing: null });
    expect(readNotifyLink("gavin://ws/ws-1?workspace=ws")).toEqual({ workstationId: "ws-1", landing: null });
    expect(readNotifyLink("gavin://ws/ws-1/card?workspace=ws")).toEqual({ workstationId: "ws-1", landing: null });
  });

  it("reads nothing from the hub's link, or one the extension did not write", () => {
    expect(readNotifyLink("gavin://hub")).toBeNull();
    expect(readNotifyLink("https://ws/ws-1/session/s1")).toBeNull();
    expect(readNotifyLink("gavin://ws/ws-1/session/s1/extra")).toBeNull();
    expect(readNotifyLink("gavin://ws/ws-1/session/%E0%A4%A?workspace=ws")).toBeNull();
  });
});

// The links the extension writes (NotifyOpen.swift's `notifyLink`) are held
// to `deepLinkFor` by the table both are read against.
describe("against the notification table the extension and the daemon share", () => {
  interface Case {
    name: string;
    opens?: { body: OpenedNotifyBody };
    refuse?: string;
    link: string;
  }
  const raw = Object.values(
    import.meta.glob("../../../../../test-fixtures/companion-notify/cases.json", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>,
  )[0];
  const table = JSON.parse(raw) as { workstation: string; cases: Case[] };

  it("has the table", () => {
    expect(table.cases.length).toBeGreaterThanOrEqual(13);
  });

  it("lands every case where the extension does", () => {
    for (const c of table.cases) {
      expect(deepLinkFor(c.opens?.body ?? null, table.workstation), c.name).toBe(c.link);
    }
  });

  it("reads each link back to the item's workspace and target", () => {
    for (const c of table.cases) {
      const body = c.opens?.body;
      const read = readNotifyLink(c.link);
      if (!body || body.op === "resolve") {
        expect(read, c.name).toBeNull();
        continue;
      }
      expect(read?.workstationId, c.name).toBe(table.workstation);
      const target = body.target;
      const expected =
        target === undefined || body.workspace_id === undefined
          ? null
          : {
              workspace: body.workspace_id,
              target:
                target.type === "session"
                  ? { kind: "session", id: target.session_id }
                  : { kind: "card", path: target.path },
            };
      expect(read?.landing, c.name).toEqual(expected);
    }
  });
});
