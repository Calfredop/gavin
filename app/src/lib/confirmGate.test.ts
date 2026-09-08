import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./dialog", () => ({ askConfirm: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { askConfirm } from "./dialog";
import { confirmDestructive, grantForAnsweredPrompt, DAEMON_SUBJECT } from "./confirmGate";

/// The host keyed by command name, so a bad reply is whatever the test
/// puts here; `open_confirmation` answers with a prompt id and
/// `answer_confirmation` with the token or null.
function host(replies: Record<string, unknown>): void {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (!(cmd in replies)) throw new Error(`unexpected command ${cmd}`);
    const reply = replies[cmd];
    if (reply instanceof Error) throw reply;
    return reply as never;
  });
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(askConfirm).mockReset();
});

describe("confirmDestructive", () => {
  it("opens the prompt, draws it, and returns the token a yes minted", async () => {
    host({ open_confirmation: 7, answer_confirmation: "tok" });
    vi.mocked(askConfirm).mockResolvedValue(true);

    const token = await confirmDestructive("trash_entry", ["/w/a.txt"], {
      title: "Move a.txt to the Trash?",
      confirmLabel: "Move to Trash",
    });

    expect(token).toBe("tok");
    expect(invoke).toHaveBeenCalledWith("open_confirmation", {
      action: "trash_entry",
      subjects: ["/w/a.txt"],
    });
    expect(invoke).toHaveBeenCalledWith("answer_confirmation", { promptId: 7, confirmed: true });
  });

  it("returns null on a no, and tells the host so its record closes", async () => {
    host({ open_confirmation: 7, answer_confirmation: null });
    vi.mocked(askConfirm).mockResolvedValue(false);

    const token = await confirmDestructive("trash_entry", ["/w/a.txt"], {
      title: "Move a.txt to the Trash?",
      confirmLabel: "Move to Trash",
    });

    expect(token).toBeNull();
    expect(invoke).toHaveBeenCalledWith("answer_confirmation", { promptId: 7, confirmed: false });
  });

  /// A dialog that throws is still an unanswered prompt host-side. The
  /// `finally` is what keeps the record from sitting there until its
  /// TTL, and the rejection still reaches the caller.
  it("closes the host's record when the dialog itself fails", async () => {
    host({ open_confirmation: 7, answer_confirmation: null });
    vi.mocked(askConfirm).mockRejectedValue(new Error("no dialog layer"));

    await expect(
      confirmDestructive("trash_entry", ["/w/a.txt"], { title: "?", confirmLabel: "Yes" })
    ).rejects.toThrow("no dialog layer");
    expect(invoke).toHaveBeenCalledWith("answer_confirmation", { promptId: 7, confirmed: false });
  });

  /// The failure has to reach the human as the command refusing, not as
  /// a click that did nothing -- so a mint that fails yields a token the
  /// host rejects rather than a null the call site reads as a cancel.
  it("yields a token the host will refuse when the mint fails", async () => {
    host({ open_confirmation: 7, answer_confirmation: new Error("gate is gone") });
    vi.mocked(askConfirm).mockResolvedValue(true);

    const token = await confirmDestructive("trash_entry", ["/w/a.txt"], {
      title: "?",
      confirmLabel: "Yes",
    });

    expect(token).toBe("");
  });

  it("does not draw a second prompt of its own", async () => {
    host({ open_confirmation: 1, answer_confirmation: "tok" });
    vi.mocked(askConfirm).mockResolvedValue(true);

    await confirmDestructive("restart_daemon", [DAEMON_SUBJECT], {
      title: "Restart gavin-daemon?",
      confirmLabel: "Restart daemon",
    });

    expect(askConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("grantForAnsweredPrompt", () => {
  it("mints for a prompt the surface drew itself, over every subject", async () => {
    host({ open_confirmation: 3, answer_confirmation: "tok" });

    const token = await grantForAnsweredPrompt("delete_card_file", ["/p/a.md", "/p/b.md"]);

    expect(token).toBe("tok");
    expect(invoke).toHaveBeenCalledWith("open_confirmation", {
      action: "delete_card_file",
      subjects: ["/p/a.md", "/p/b.md"],
    });
    expect(askConfirm).not.toHaveBeenCalled();
  });

  it("never returns null: a failed mint is a token the command refuses", async () => {
    host({ open_confirmation: new Error("no such action") });

    expect(await grantForAnsweredPrompt("delete_card_file", ["/p/a.md"])).toBe("");
    // No prompt was opened, so nothing is settled either.
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
