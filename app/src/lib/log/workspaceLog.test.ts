import { describe, expect, it } from "vitest";
import type { GavinTree } from "$lib/core/gavin";
import {
  LOG_CATEGORIES,
  cardTarget,
  categoriesForQuery,
  categoryOf,
  categorySummary,
  clearConfirm,
  clearOptions,
  dayLabel,
  deletedCards,
  groupByDay,
  iconFor,
  matchesFilter,
  mergeEntries,
  nextCursor,
  pushedIntoView,
  sentenceOf,
  sentenceText,
  toggleCategory,
  worktreeLabel,
  type LogEntry,
  type LogPayload,
} from "$lib/log/workspaceLog";

let nextId = 1;
function entry(kind: string, payload: LogPayload = {}, at = 1_790_000_000, workspaceId = "ws"): LogEntry {
  return { id: nextId++, workspaceId, at, kind, payload };
}

const say = (e: LogEntry, root: string | null = "/r") => sentenceText(sentenceOf(e, root));

describe("the sentence", () => {
  it("reads one line per kind, the card and rail set apart as links", () => {
    const card = { cardTitle: "[feat] x", cardFile: "x.md" };
    expect(say(entry("card_moved", { ...card, fromColumn: "To Do", toColumn: "In Progress" }))).toBe(
      "Card [feat] x moved To Do → In Progress"
    );
    expect(say(entry("card_retitled", { ...card, oldTitle: "old" }))).toBe("Card old renamed to [feat] x");
    expect(say(entry("rail_paused", { railName: "api" }))).toBe("Rail api paused");
    expect(say(entry("rail_failed", { railName: "api", reason: "worktree missing" }))).toBe(
      "Rail api stalled: worktree missing"
    );
    expect(say(entry("decision_answered", { ...card, itemText: "Which store?" }))).toBe(
      "Decision answered on [feat] x: Which store?"
    );
    expect(say(entry("run_finished", { ...card, agent: "claude", exitCode: 0 }))).toBe(
      "Run finished on [feat] x (claude, exit 0)"
    );
    expect(say(entry("scheduled_fired", { cardTitle: "Nightly", fireNumber: 3 }))).toBe("Scheduled task Nightly fired (run 3)");
    const parts = sentenceOf(entry("card_created", card), "/r");
    expect(parts.find((p) => p.type === "card")?.text).toBe("[feat] x");
    expect(sentenceOf(entry("rail_started", { railName: "api" }), "/r").find((p) => p.type === "rail")?.text).toBe("api");
  });

  it("names the branch and the worktree of a git entry, but not the main checkout", () => {
    const commit = { branch: "feat/x", message: "fix the login" };
    expect(say(entry("git_commit", { ...commit, worktree: "/r/.gavin-worktrees/wt-api" }))).toBe(
      "Commit on feat/x in wt-api: fix the login"
    );
    expect(say(entry("git_commit", { ...commit, worktree: "/r" }))).toBe("Commit on feat/x: fix the login");
    expect(say(entry("git_push", { branch: "origin/feat/x" }))).toBe("Pushed origin/feat/x");
    expect(say(entry("git_branch_deleted", { branch: "old", worktree: "/r/" }))).toBe("Branch old deleted");
    expect(worktreeLabel("C:\\r\\wt\\", "C:\\r")).toBe("wt");
  });

  it("falls back to the file name, and says plainly when the kind is a newer daemon's", () => {
    expect(say(entry("card_deleted", { cardFile: "gone.md" }))).toBe("Card gone.md deleted");
    expect(say(entry("card_teleported"))).toContain("does not know");
    expect(categoryOf("card_teleported")).toBe("cards");
    expect(categoryOf("unknown")).toBeNull();
    expect(iconFor("unknown")).toBe("ScrollText");
    expect(iconFor("git_push")).toBe("ArrowUpFromLine");
  });
});

describe("the filter", () => {
  it("keeps at least one family on and says which are", () => {
    let on = [...LOG_CATEGORIES];
    expect(categorySummary(on)).toBe("All activity");
    expect(categoriesForQuery(on)).toEqual([]);
    on = toggleCategory(on, "git");
    expect(categorySummary(on)).toBe("Cards · Runs · Rails · Human items · Scheduled");
    expect(categoriesForQuery(on)).not.toContain("git");
    expect(toggleCategory(["git"], "git")).toEqual(["git"]);
  });

  it("matches the daemon's search: card, rail, branch and worktree names, any case", () => {
    const e = entry("git_commit", { branch: "feat/Login", worktree: "/r/wt-api" });
    expect(matchesFilter(e, LOG_CATEGORIES, "LOGIN")).toBe(true);
    expect(matchesFilter(e, LOG_CATEGORIES, "wt-api")).toBe(true);
    expect(matchesFilter(e, ["cards"], "")).toBe(false);
    expect(matchesFilter(entry("decision_filed", { itemText: "login?" }), LOG_CATEGORIES, "login")).toBe(false);
    // A kind no family holds is shown only while every family is.
    expect(matchesFilter(entry("unknown"), LOG_CATEGORIES, "")).toBe(true);
    expect(matchesFilter(entry("unknown"), ["cards"], "")).toBe(false);
  });
});

describe("the list", () => {
  it("merges pages and pushes once each, newest first by time then id", () => {
    const a = entry("card_created", {}, 100);
    const b = entry("git_commit", {}, 50);
    const c = entry("card_moved", {}, 100);
    const merged = mergeEntries([a, b], [c, a]);
    expect(merged.map((e) => e.id)).toEqual([c.id, a.id, b.id]);
    expect(nextCursor(merged)).toEqual({ at: 50, id: b.id });
    expect(nextCursor([])).toBeNull();
  });

  it("takes a push only into the view its query drew, and never below the loaded bottom", () => {
    const loaded = [entry("card_created", {}, 300), entry("card_created", {}, 200)];
    const fresh = entry("card_moved", { cardTitle: "Alpha" }, 400);
    const old = entry("git_commit", {}, 100);
    const elsewhere = entry("card_created", {}, 500, "other");
    expect(pushedIntoView(loaded, [fresh, old, elsewhere], "ws", LOG_CATEGORIES, "", true)).toEqual([fresh]);
    // Everything is loaded: an old one has nowhere to be missing from.
    expect(pushedIntoView(loaded, [old], "ws", LOG_CATEGORIES, "", false)).toEqual([old]);
    expect(pushedIntoView(loaded, [fresh], "ws", ["git"], "", true)).toEqual([]);
    expect(pushedIntoView(loaded, [fresh], "ws", LOG_CATEGORIES, "beta", true)).toEqual([]);
  });

  it("cuts the list into days in this machine's time zone", () => {
    const now = new Date(2026, 9, 26, 15, 0);
    const at = (d: Date) => Math.floor(d.getTime() / 1000);
    const list = [
      entry("card_created", {}, at(new Date(2026, 9, 26, 9, 0))),
      entry("card_created", {}, at(new Date(2026, 9, 26, 0, 5))),
      entry("card_created", {}, at(new Date(2026, 9, 25, 23, 55))),
      entry("card_created", {}, at(new Date(2026, 9, 20, 12, 0))),
      entry("card_created", {}, at(new Date(2025, 11, 31, 12, 0))),
    ];
    const days = groupByDay(list, now);
    expect(days.map((d) => [d.label, d.entries.length])).toEqual([
      ["Today", 2],
      ["Yesterday", 1],
      ["Tuesday 20 October", 1],
      ["Wednesday 31 December 2025", 1],
    ]);
    expect(dayLabel(at(now), now)).toBe("Today");
  });
});

describe("the card a row names", () => {
  const plan = (path: string) => ({ path, fileName: path.split("/").at(-1)! });
  const tree = {
    rootPath: "/r",
    rootMissing: false,
    contexts: [
      { folderPath: "/r", plans: [plan("/r/.gavin-root/plans/archive/a.md"), plan("/r/.gavin-root/plans/b.md")] },
      { folderPath: "/r/sub", plans: [plan("/r/sub/.gavin/plans/b.md")] },
    ],
  } as unknown as GavinTree;

  it("is found by file name wherever it was filed since, in its own context first", () => {
    const archived = entry("card_moved", { cardFile: "a.md", cardPath: "/r/.gavin-root/plans/a.md" });
    expect(cardTarget(archived, tree, new Set())).toEqual({ state: "open", path: "/r/.gavin-root/plans/archive/a.md" });
    const sub = entry("card_created", { cardFile: "b.md", cardPath: "/r/sub/.gavin/plans/b.md" });
    expect(cardTarget(sub, tree, new Set())).toEqual({ state: "open", path: "/r/sub/.gavin/plans/b.md" });
    expect(cardTarget(entry("card_created", { cardFile: "z.md" }), tree, new Set())).toEqual({ state: "unknown" });
  });

  it("is gone for every entry once the log says it was deleted, until it is made again", () => {
    const created = entry("card_created", { cardFile: "b.md" }, 100);
    const deleted = entry("card_deleted", { cardFile: "b.md" }, 200);
    const gone = deletedCards([deleted, created]);
    expect(gone.has("b.md")).toBe(true);
    expect(cardTarget(created, tree, gone)).toEqual({ state: "gone" });
    const remade = entry("card_created", { cardFile: "b.md" }, 300);
    expect(deletedCards([remade, deleted, created]).has("b.md")).toBe(false);
  });
});

describe("clearing", () => {
  it("offers the five spans, measured back on the calendar, and names the action", () => {
    const now = new Date(2026, 9, 26, 12, 0);
    const options = clearOptions(now);
    expect(options.map((o) => o.label)).toEqual(["1 month", "3 months", "6 months", "1 year", "Everything"]);
    expect(new Date(options[0].olderThan! * 1000).getMonth()).toBe(8);
    expect(new Date(options[3].olderThan! * 1000).getFullYear()).toBe(2025);
    expect(options[4].olderThan).toBeNull();
    expect(clearConfirm(options[0]).confirmLabel).toBe("Clear older than 1 month");
    expect(clearConfirm(options[4]).confirmLabel).toBe("Clear the whole log");
    expect(clearConfirm(options[4]).lines.join(" ")).toContain("Cards, runs and their history stay");
  });
});
