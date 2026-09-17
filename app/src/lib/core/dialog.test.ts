import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import {
  askConfirm,
  askConfirmChecked,
  askConfirmPicked,
  showAlert,
  answerDialog,
  dialogRequest,
  resetDialogs,
} from "$lib/core/dialog";

beforeEach(() => {
  resetDialogs();
});

function current() {
  const req = get(dialogRequest);
  if (!req) throw new Error("no dialog on screen");
  return req;
}

describe("askConfirm", () => {
  it("puts the request on screen and resolves true when confirmed", async () => {
    const answer = askConfirm({ title: "Close this tab?", confirmLabel: "Close tab" });
    const req = current();
    expect(req.title).toBe("Close this tab?");
    expect(req.confirmLabel).toBe("Close tab");
    answerDialog(req.id, true);
    expect(await answer).toBe(true);
    expect(get(dialogRequest)).toBeNull();
  });

  it("resolves false when dismissed", async () => {
    const answer = askConfirm({ title: "Close this tab?", confirmLabel: "Close tab" });
    answerDialog(current().id, false);
    expect(await answer).toBe(false);
  });

  it("defaults the second answer to Cancel and keeps a named one", () => {
    void askConfirm({ title: "a", confirmLabel: "Go" });
    expect(current().cancelLabel).toBe("Cancel");
    resetDialogs();
    void askConfirm({ title: "a", confirmLabel: "Restore", cancelLabel: "Start fresh" });
    expect(current().cancelLabel).toBe("Start fresh");
  });
});

// One prompt, four answers: the ladder the close prompt asks with, where
// the rungs are the answer rather than a second question.
describe("askConfirmPicked", () => {
  const LADDER = {
    title: "Close gavin?",
    confirmLabel: "Close",
    picker: {
      label: "How far should closing reach?",
      expanded: true,
      default: "window",
      options: [
        { value: "window", label: "Close this window", detail: "Your sessions keep running." },
        { value: "daemon", label: "Close everything", detail: "Stops the daemon too." },
      ],
    },
  };

  it("carries the ladder to the modal and the chosen rung back", async () => {
    const answer = askConfirmPicked(LADDER);
    const req = current();
    expect(req.picker?.options.map((o) => o.value)).toEqual(["window", "daemon"]);
    expect(req.picker?.expanded).toBe(true);
    answerDialog(req.id, true, false, "daemon");
    expect(await answer).toEqual({ confirmed: true, checked: false, picked: "daemon" });
  });

  // The rung the prompt opened on is the answer when the human touches
  // nothing. A ladder that answered null there would make every caller
  // re-implement the default, and they would drift apart.
  it("answers with the rung it opened on when nothing was picked", async () => {
    const answer = askConfirmPicked(LADDER);
    answerDialog(current().id, true);
    expect((await answer).picked).toBe("window");
  });

  it("reports the dismissal rather than the rung when cancelled", async () => {
    const answer = askConfirmPicked(LADDER);
    answerDialog(current().id, false);
    expect((await answer).confirmed).toBe(false);
  });
});

// One prompt, two answers: the follow-up ("also delete the branches")
// rides on the confirm rather than becoming a second dialog nobody
// reads.
describe("askConfirmChecked", () => {
  it("carries the tick-box to the modal and its value back", async () => {
    const answer = askConfirmChecked({
      title: "Remove 2 stale worktrees?",
      confirmLabel: "Remove 2 worktrees",
      check: { label: "Also delete the 2 merged branches", default: true },
    });
    const req = current();
    expect(req.check).toEqual({ label: "Also delete the 2 merged branches", default: true });
    answerDialog(req.id, true, true);
    expect(await answer).toEqual({ confirmed: true, checked: true });
  });

  it("reports the box untouched when the human unticked it", async () => {
    const answer = askConfirmChecked({
      title: "a",
      confirmLabel: "Go",
      check: { label: "and the branch", default: true },
    });
    answerDialog(current().id, true, false);
    expect(await answer).toEqual({ confirmed: true, checked: false });
  });

  it("leaves a plain confirm with no tick-box at all", () => {
    void askConfirm({ title: "a", confirmLabel: "Go" });
    expect(current().check).toBeNull();
  });
});

describe("showAlert", () => {
  it("has no confirm button -- one answer, one button", async () => {
    const seen = showAlert({ title: "Couldn't open in Finder", lines: ["ENOENT"] });
    const req = current();
    expect(req.confirmLabel).toBeNull();
    expect(req.cancelLabel).toBe("OK");
    expect(req.lines).toEqual(["ENOENT"]);
    answerDialog(req.id, false);
    await expect(seen).resolves.toBeUndefined();
  });
});

describe("the queue", () => {
  it("shows one at a time, in order", async () => {
    const first = askConfirm({ title: "first", confirmLabel: "Go" });
    void showAlert({ title: "second" });
    expect(current().title).toBe("first");
    answerDialog(current().id, true);
    expect(await first).toBe(true);
    // The second question is only asked once the first is answered --
    // stacking them would hide the one underneath.
    expect(current().title).toBe("second");
  });

  it("ignores an answer aimed at a request that is no longer on screen", async () => {
    const first = askConfirm({ title: "first", confirmLabel: "Go" });
    void askConfirm({ title: "second", confirmLabel: "Go" });
    const staleId = current().id;
    answerDialog(staleId, true);
    expect(await first).toBe(true);
    // Escape arriving after the click that already answered: it must not
    // fall through and answer the NEXT question.
    answerDialog(staleId, false);
    expect(current().title).toBe("second");
  });
});
