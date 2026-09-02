import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(),
}));

import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  maybeNotifyStatusChange,
  maybeNotifyAgentCommit,
  agentCommitBody,
  setRailNotificationVoice,
  parseSessionStatus,
  failureBody,
  __resetForTesting,
} from "./notifications";

/// Today's behaviour: both events enabled. The per-workspace toggles
/// (D38) get their own test below; every pre-existing case asserts the
/// rules that are unchanged by them.
const ALL_ON = { needsInput: true, finished: true };

function mockWindow(isFocused: boolean): void {
  vi.mocked(getCurrentWindow).mockReturnValue({ isFocused: vi.fn().mockResolvedValue(isFocused) } as never);
}

beforeEach(async () => {
  await __resetForTesting();
  vi.clearAllMocks();
  mockWindow(false);
  vi.mocked(isPermissionGranted).mockResolvedValue(true);
});

describe("maybeNotifyStatusChange", () => {
  it("notifies on a transition into waiting_for_input", async () => {
    await maybeNotifyStatusChange("s-1", "working", "waiting_for_input", "my-project", ALL_ON);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendNotification).mock.calls[0][0] as { title: string; body: string };
    expect(call.body).toContain("my-project");
  });

  it("notifies on a transition into waiting_for_input even from idle (not just from working)", async () => {
    await maybeNotifyStatusChange("s-1", "idle", "waiting_for_input", "my-project", ALL_ON);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("notifies on working -> idle", async () => {
    await maybeNotifyStatusChange("s-1", "working", "idle", "my-project", ALL_ON);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("does not notify on idle -> working", async () => {
    await maybeNotifyStatusChange("s-1", "idle", "working", "my-project", ALL_ON);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("does not notify on waiting_for_input -> working", async () => {
    await maybeNotifyStatusChange("s-1", "waiting_for_input", "working", "my-project", ALL_ON);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("does not notify when there is no previous status and the new status isn't waiting_for_input", async () => {
    // The very first StatusChanged a session ever receives (previousStatus
    // undefined) is a baseline, not a transition -- idle/working as a
    // first-ever value must never read as "working -> idle" or similar.
    await maybeNotifyStatusChange("s-1", undefined, "idle", "my-project", ALL_ON);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("does notify when the very first status a session ever receives is waiting_for_input", async () => {
    await maybeNotifyStatusChange("s-1", undefined, "waiting_for_input", "my-project", ALL_ON);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("suppresses the notification entirely when the window is frontmost", async () => {
    mockWindow(true);
    await maybeNotifyStatusChange("s-1", "working", "idle", "my-project", ALL_ON);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("does not notify when permission was never granted and the user declines the lazy request", async () => {
    vi.mocked(isPermissionGranted).mockResolvedValue(false);
    vi.mocked(requestPermission).mockResolvedValue("denied");
    await maybeNotifyStatusChange("s-1", "working", "idle", "my-project", ALL_ON);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("requests permission only once across multiple notification-worthy transitions, not on every one", async () => {
    vi.mocked(isPermissionGranted).mockResolvedValue(false);
    vi.mocked(requestPermission).mockResolvedValue("denied");
    await maybeNotifyStatusChange("s-1", "working", "idle", "my-project", ALL_ON);
    await maybeNotifyStatusChange("s-2", "working", "idle", "other-project", ALL_ON);
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("does not call requestPermission at all once permission is already granted", async () => {
    vi.mocked(isPermissionGranted).mockResolvedValue(true);
    await maybeNotifyStatusChange("s-1", "working", "idle", "my-project", ALL_ON);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("checks window focus before ever touching permission state, for a non-notification-worthy transition", async () => {
    await maybeNotifyStatusChange("s-1", "idle", "working", "my-project", ALL_ON);
    expect(isPermissionGranted).not.toHaveBeenCalled();
  });
});

describe("per-workspace toggles", () => {
  it("suppresses only the event whose toggle is off", async () => {
    await __resetForTesting();
    vi.mocked(isPermissionGranted).mockResolvedValue(true);
    vi.mocked(getCurrentWindow).mockReturnValue({ isFocused: async () => false } as never);

    await maybeNotifyStatusChange("s-1", "working", "idle", "zsh", { needsInput: true, finished: false });
    expect(sendNotification).not.toHaveBeenCalled();

    await maybeNotifyStatusChange("s-1", "working", "idle", "zsh", { needsInput: true, finished: true });
    expect(sendNotification).toHaveBeenCalledOnce();

    vi.mocked(sendNotification).mockClear();
    await maybeNotifyStatusChange("s-1", "idle", "waiting_for_input", "zsh", {
      needsInput: false,
      finished: true,
    });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("does not even ask for permission when the event is silenced", async () => {
    await __resetForTesting();
    vi.mocked(isPermissionGranted).mockResolvedValue(false);
    vi.mocked(getCurrentWindow).mockReturnValue({ isFocused: async () => false } as never);

    await maybeNotifyStatusChange("s-1", "working", "idle", "zsh", { needsInput: true, finished: false });
    expect(requestPermission).not.toHaveBeenCalled();
  });
});

describe("maybeNotifyAgentCommit", () => {
  const ON_SCREEN = true;
  const ELSEWHERE = false;

  it("names the workspace and says what the run did", async () => {
    await maybeNotifyAgentCommit("gavin", { kind: "committed" }, ALL_ON, ELSEWHERE);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendNotification).mock.calls[0][0] as { title: string; body: string };
    expect(call.body).toBe("gavin: changes committed");
  });

  it("reports a failure and a half-done run as themselves, not as 'finished'", () => {
    expect(agentCommitBody("gavin", { kind: "failed", exitCode: 2 })).toBe("gavin: commit agent failed (exit 2)");
    expect(agentCommitBody("gavin", { kind: "left-dirty", changes: 4 })).toBe(
      "gavin: commit agent left 4 changes uncommitted"
    );
    expect(agentCommitBody("gavin", { kind: "left-dirty", changes: 1 })).toBe(
      "gavin: commit agent left 1 change uncommitted"
    );
  });

  // The whole point of the card: the human clicked the button and went
  // to work on another tab. Being inside the app is not being told.
  it("still notifies a focused window that is showing some other tab", async () => {
    mockWindow(true);
    await maybeNotifyAgentCommit("gavin", { kind: "committed" }, ALL_ON, ELSEWHERE);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("stays quiet only when the Git tab is both focused and on screen", async () => {
    mockWindow(true);
    await maybeNotifyAgentCommit("gavin", { kind: "committed" }, ALL_ON, ON_SCREEN);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  // A background window's Git tab shows nothing at all, even though it
  // is that workspace's current view.
  it("notifies when the Git tab is on screen but the window is not frontmost", async () => {
    mockWindow(false);
    await maybeNotifyAgentCommit("gavin", { kind: "failed", exitCode: 2 }, ALL_ON, ON_SCREEN);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("obeys the workspace's 'finished' toggle, and asks nothing of the OS when it is off", async () => {
    vi.mocked(isPermissionGranted).mockResolvedValue(false);
    await maybeNotifyAgentCommit("gavin", { kind: "committed" }, { needsInput: true, finished: false }, ELSEWHERE);
    expect(sendNotification).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(getCurrentWindow).not.toHaveBeenCalled();
  });

  it("does not notify when the lazy permission request is declined", async () => {
    vi.mocked(isPermissionGranted).mockResolvedValue(false);
    vi.mocked(requestPermission).mockResolvedValue("denied");
    await maybeNotifyAgentCommit("gavin", { kind: "committed" }, ALL_ON, ELSEWHERE);
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

// A rail's card step whose agent goes idle without its card ever
// reaching the done column already notified -- as "<label> finished",
// which is exactly the wrong word for work that stopped unfinished.
describe("the rail's voice over a status notification", () => {
  it("replaces the generic body when the rail has something truer to say", async () => {
    setRailNotificationVoice((sessionId, status) =>
      sessionId === "s-1" && status === "idle" ? "step-1 stopped without finishing its card" : null
    );
    await maybeNotifyStatusChange("s-1", "working", "idle", "my-project", ALL_ON);
    const call = vi.mocked(sendNotification).mock.calls[0][0] as { body: string };
    expect(call.body).toBe("step-1 stopped without finishing its card");
  });

  it("leaves a session the rail says nothing about with the generic body", async () => {
    setRailNotificationVoice(() => null);
    await maybeNotifyStatusChange("s-2", "working", "idle", "my-project", ALL_ON);
    const call = vi.mocked(sendNotification).mock.calls[0][0] as { body: string };
    expect(call.body).toBe("my-project finished");
  });

  // One notification, not two. The voice only ever rewords the line the
  // transition was already going to send; it can never conjure one, so
  // the per-workspace toggles and the focused-window suppression keep
  // owning whether anything is sent at all.
  it("cannot make a silenced workspace speak", async () => {
    setRailNotificationVoice(() => "rail says something");
    await maybeNotifyStatusChange("s-1", "working", "idle", "my-project", {
      needsInput: true,
      finished: false,
    });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("cannot make a transition that was never worth notifying speak", async () => {
    setRailNotificationVoice(() => "rail says something");
    await maybeNotifyStatusChange("s-1", "idle", "working", "my-project", ALL_ON);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("is cleared by teardown, so no stale rail speaks for the next app run", async () => {
    setRailNotificationVoice(() => "rail says something");
    await __resetForTesting();
    vi.mocked(isPermissionGranted).mockResolvedValue(true);
    await maybeNotifyStatusChange("s-1", "working", "idle", "my-project", ALL_ON);
    const call = vi.mocked(sendNotification).mock.calls[0][0] as { body: string };
    expect(call.body).toBe("my-project finished");
  });
});

// ---- v21: a broken agent is not a finished one -----------------------------

describe("parseSessionStatus", () => {
  it("keeps every status this build knows", () => {
    for (const s of ["idle", "working", "waiting_for_input", "failed", "unknown"]) {
      expect(parseSessionStatus(s)).toBe(s);
    }
  });

  // The whole reason this function exists. The daemon's own
  // SessionStatus::from_str used to map anything unrecognised to `idle`,
  // and `idle` is the ONE value orchestration acts on by marking a step
  // done and advancing the rail -- so a status invented by a newer daemon
  // would advance a rail on the strength of not being understood.
  it("never reads an unrecognised status as idle", () => {
    for (const s of ["", "IDLE", "crashed", "api_error", "Idle "]) {
      expect(parseSessionStatus(s)).toBe("unknown");
    }
  });
});

describe("failureBody", () => {
  it("carries the agent's own sentence, which is the part a human acts on", () => {
    expect(failureBody("api", "API Error: 529 Overloaded.")).toBe(
      "api stopped — API Error: 529 Overloaded."
    );
  });

  it("still says something true when the reason was lost", () => {
    expect(failureBody("api", undefined)).toBe("api stopped: its agent did not finish");
    expect(failureBody("api", "   ")).toBe("api stopped: its agent did not finish");
  });
});

describe("a failed session", () => {
  it("no longer sends the human a notification saying it finished", async () => {
    await maybeNotifyStatusChange("s1", "working", "failed", "rail step", ALL_ON, "API Error: x");
    expect(sendNotification).toHaveBeenCalledWith({
      title: "gavin",
      body: "rail step stopped — API Error: x",
    });
  });

  // A failure is news whatever the session was doing, and the daemon only
  // ever writes it at the end of a turn -- so unlike `finished` it is not
  // gated on a previous `working`.
  it("notifies from any previous status", async () => {
    await maybeNotifyStatusChange("s1", undefined, "failed", "rail step", ALL_ON, "boom");
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  // A failure rides the `finished` toggle rather than a third one: both
  // say "this run reached an end", which is what that toggle answers for.
  it("is silenced by the workspace's finished toggle", async () => {
    await maybeNotifyStatusChange("s1", "working", "failed", "rail step", { needsInput: true, finished: false }, "boom");
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("says nothing at all for a status this build cannot read", async () => {
    await maybeNotifyStatusChange("s1", "working", "unknown", "rail step", ALL_ON);
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
