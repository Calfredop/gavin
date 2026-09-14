import { describe, it, expect } from "vitest";
import {
  RUNNABLE_TOOL_KINDS,
  cannotRunAloneReason,
  editDraftFor,
  isRunnableStandalone,
  isRunOpen,
  lastRunByTool,
  listedTools,
  matchesToolSearch,
  runBlockedReason,
  toolCwdLabel,
  toolRunAxis,
  toolRunChip,
  toolRunSentence,
  toolRunTip,
  toolRunVerdict,
  toolsEmptyMessage,
  type ToolRun,
} from "$lib/workspace/workspaceTools";
import { BUILTIN_TOOLS, type Tool, type ToolKind } from "$lib/orchestration/orchestrationTools";
import { runIndicator } from "$lib/ui/indicators";
import type { DaemonCompat } from "$lib/core/daemonCompat";

function tool(over: Partial<Tool> = {}): Tool {
  return {
    id: "u1",
    name: "Deploy",
    description: "ships it",
    kind: "command",
    body: "./deploy.sh",
    params: [],
    scope: "workspace",
    cwd: null,
    ...over,
  };
}

function run(over: Partial<ToolRun> = {}): ToolRun {
  return {
    id: 1,
    toolId: "u1",
    sessionId: "s-1",
    command: "./deploy.sh",
    launchCwd: "/r",
    conversationId: null,
    startedAt: 1_000_000,
    endedAt: null,
    exitCode: null,
    outcome: "running",
    ...over,
  };
}

const V30: DaemonCompat = { daemonVersion: 30, appVersion: 30, degraded: false };
const V29: DaemonCompat = { daemonVersion: 29, appVersion: 30, degraded: true };

const STEP_ONLY: ToolKind[] = ["gavin", "until", "pr", "review", "critique"];

// Every kind is one or the other, and nothing else says so: a kind added
// to ToolKind and forgotten in both lists takes a Run button whose
// tooltip is the daemon version, on a tool that cannot run.
const EVERY_KIND: ToolKind[] = [
  "agent",
  "command",
  "script",
  "gavin",
  "until",
  "pr",
  "review",
  "critique",
];

describe("which tools run standalone", () => {
  it("names exactly the three kinds a Run button can start", () => {
    expect(RUNNABLE_TOOL_KINDS).toEqual(["agent", "command", "script"]);
  });

  it("sorts every kind into runnable or step-only, with nothing left over", () => {
    expect([...RUNNABLE_TOOL_KINDS, ...STEP_ONLY].sort()).toEqual([...EVERY_KIND].sort());
  });

  // The ones that are missing are those whose bodies are completion
  // RULES: an until step sends the rail backwards, a pr step is nothing
  // but waiting on one, a review step nothing but waiting on a person,
  // and a gavin tool's body names a rail action. A human can AUTHOR
  // every kind -- this is the narrower question.
  it("drops the kinds that only mean something on a rail", () => {
    for (const kind of STEP_ONLY) {
      expect(isRunnableStandalone({ kind })).toBe(false);
    }
    for (const kind of RUNNABLE_TOOL_KINDS) {
      expect(isRunnableStandalone({ kind })).toBe(true);
    }
  });

  // The two halves must stay complementary: a kind with no sentence
  // would take a dark Run button whose tooltip is the daemon version.
  it("has a reason for every kind that cannot run, and none for the rest", () => {
    for (const kind of STEP_ONLY) {
      expect(cannotRunAloneReason(kind), kind).toMatch(/step/);
    }
    for (const kind of RUNNABLE_TOOL_KINDS) {
      expect(cannotRunAloneReason(kind), kind).toBeNull();
    }
  });

  // Listed, not filtered: the tab edits tools now, and a tool switched
  // to Loop-until must not vanish from under the cursor that switched it.
  it("lists the whole shipped library, step-only kinds included", () => {
    const ids = listedTools(BUILTIN_TOOLS).map((t) => t.id);
    expect(ids).toContain("builtin:start-rail");
    expect(ids).toContain("builtin:until");
    expect(ids).toContain("builtin:await-pr");
    expect(ids).toContain("builtin:consolidate-repo");
    expect(ids).toHaveLength(BUILTIN_TOOLS.length);
  });

  // The human's own tools are what they came here to run; sixteen
  // built-ins above them would bury the one that matters.
  it("puts this workspace's own tools first, then global, then built-in", () => {
    const list = listedTools([
      tool({ id: "b", name: "Zebra", scope: "builtin" }),
      tool({ id: "g", name: "Apple", scope: "global" }),
      tool({ id: "w", name: "Mango", scope: "workspace" }),
    ]);
    expect(list.map((t) => t.id)).toEqual(["w", "g", "b"]);
  });

  it("sorts alphabetically within a scope", () => {
    const list = listedTools([
      tool({ id: "b", name: "Beta" }),
      tool({ id: "a", name: "Alpha" }),
    ]);
    expect(list.map((t) => t.name)).toEqual(["Alpha", "Beta"]);
  });
});

describe("editDraftFor", () => {
  // A copy, always: the list re-renders from the store the moment a save
  // lands, and a draft that WAS the library entry would fight that.
  it("hands back a detached copy of a stored tool", () => {
    const original = tool({ params: [{ name: "env", label: "Env", default: "staging" }] });
    const draft = editDraftFor(original, "new-id");
    expect(draft.id).toBe(original.id);
    expect(draft).not.toBe(original);
    draft.params[0].default = "prod";
    expect(original.params[0].default).toBe("staging");
  });

  // A built-in cannot be saved, so editing one means copying it -- the
  // same answer the library's own list gives from its own row.
  it("turns a built-in into a duplicate it can actually save", () => {
    const draft = editDraftFor(BUILTIN_TOOLS[0], "new-id");
    expect(draft.id).toBe("new-id");
    expect(draft.scope).toBe("workspace");
    expect(draft.name).toContain("(copy)");
  });
});

describe("lastRunByTool", () => {
  it("is empty for a workspace that has run nothing", () => {
    expect(lastRunByTool([]).size).toBe(0);
  });

  // Row ids ascend with time and `startedAt` has one-second resolution,
  // so a relaunch inside one second is ordered by id or not at all.
  it("keeps the highest id when a tool has more than one row", () => {
    const runs = [
      run({ id: 4, toolId: "u1", startedAt: 10 }),
      run({ id: 9, toolId: "u1", startedAt: 10 }),
      run({ id: 2, toolId: "u2" }),
    ];
    expect(lastRunByTool(runs).get("u1")?.id).toBe(9);
    expect(lastRunByTool(runs).get("u2")?.id).toBe(2);
  });

  it("knows an open run from a finished one", () => {
    expect(isRunOpen(run({ outcome: "running" }))).toBe(true);
    expect(isRunOpen(run({ outcome: "passed" }))).toBe(false);
    expect(isRunOpen(undefined)).toBe(false);
  });
});

describe("what a run means", () => {
  it("names an exit code when there was one", () => {
    expect(toolRunSentence(run({ outcome: "failed", exitCode: 2 }))).toContain("code 2");
    expect(toolRunSentence(run({ outcome: "passed", exitCode: 0 }))).toContain("exited cleanly");
  });

  // An agent tool's session never exits, so its verdict has no code --
  // and a sentence claiming one would be the row inventing evidence.
  it("never claims an exit code an agent run does not have", () => {
    const sentence = toolRunSentence(run({ outcome: "failed", exitCode: null }));
    expect(sentence).not.toMatch(/code/);
    expect(sentence).toMatch(/agent/);
    expect(toolRunSentence(run({ outcome: "passed", exitCode: null }))).toMatch(/turn ended/);
  });

  // `abandoned` is gavin admitting what it did not see. Reading it as a
  // failure would blame the tool for the daemon restarting.
  it("says an unwatched end was not recorded rather than that it failed", () => {
    expect(toolRunVerdict(run({ outcome: "abandoned" }))).toBe("not recorded");
    expect(toolRunSentence(run({ outcome: "abandoned" }))).toMatch(/not recorded/);
  });

  it("has an answer for an outcome this build does not know", () => {
    expect(toolRunVerdict(run({ outcome: "invented" }))).toBe("unknown");
    expect(toolRunSentence(run({ outcome: "invented" }))).toMatch(/no record/);
  });
});

// The badge is composed by WorkspaceToolsHubView from `toolRunAxis` and
// `toolRunTip` -- the rule here, the glyph lookup there, because
// `ui/indicators.ts` pulls the whole @lucide/svelte barrel and this
// module is reached from bootstrap. These assert the composition the way
// the view performs it.
describe("the run badge", () => {
  const badge = (run: ToolRun) => {
    const axis = toolRunAxis(run);
    return { ...runIndicator(axis.outcome, axis.exitCode), tip: toolRunTip(run) };
  };

  // Shape and tone are the app's single run vocabulary: a tool run that
  // drew its own glyph would be a fourth badge for a question the app
  // already answers.
  it("lands on the run axis, in the tone that answer deserves", () => {
    expect(badge(run({ outcome: "passed" })).axis).toBe("run");
    expect(badge(run({ outcome: "passed" })).tone).toBe("success");
    expect(badge(run({ outcome: "failed" })).tone).toBe("danger");
    expect(badge(run({ outcome: "running" })).tone).toBe("accent");
    expect(badge(run({ outcome: "abandoned" })).tone).toBe("warning");
  });

  // An agent that broke has no exit code, and the run axis needs a
  // non-zero one to reach danger. Without this a failed agent run would
  // draw as a clean finish.
  it("still reads danger for an agent failure with no exit code", () => {
    expect(toolRunAxis(run({ outcome: "failed", exitCode: null }))).toEqual({
      outcome: "exited",
      exitCode: 1,
    });
    expect(badge(run({ outcome: "failed", exitCode: null })).tone).toBe("danger");
  });

  // The one thing not borrowed. The run axis's danger tip says "ended
  // with a non-zero exit code", which is false about an agent that
  // stopped talking.
  it("says what actually happened rather than the card axis's wording", () => {
    const tip = toolRunTip(run({ outcome: "failed", exitCode: null }));
    expect(tip).toMatch(/^Run · /);
    expect(tip).not.toMatch(/non-zero/);
  });

  it("never spins — a row in a history is a record, not motion", () => {
    for (const outcome of ["running", "passed", "failed", "abandoned"]) {
      expect(Boolean(badge(run({ outcome })).spin)).toBe(false);
    }
  });
});

describe("toolRunChip", () => {
  const NOW = 2_000_000_000;

  it("is nothing at all for a tool nobody has run", () => {
    expect(toolRunChip(undefined, NOW)).toBeNull();
  });

  it("reads the verdict and the age off the END of the run", () => {
    const chip = toolRunChip(
      run({ outcome: "passed", startedAt: 1_000_000, endedAt: NOW / 1000 - 300 }),
      NOW
    );
    expect(chip).toBe("passed · 5m ago");
  });

  // An open run has no end, so its age is how long it has been going --
  // the one case where measuring against now is the honest answer.
  it("ages an open run from its start", () => {
    expect(toolRunChip(run({ outcome: "running", startedAt: NOW / 1000 - 120 }), NOW)).toBe(
      "running · 2m ago"
    );
  });
});

describe("toolCwdLabel", () => {
  it("says nothing when the tool runs at the root", () => {
    expect(toolCwdLabel({ cwd: null })).toBeNull();
    expect(toolCwdLabel({ cwd: "  " })).toBeNull();
    expect(toolCwdLabel({ cwd: "." })).toBeNull();
  });

  // The human's own spelling. The resolved absolute path would be wider
  // and say less.
  it("shows the directory exactly as it was typed", () => {
    expect(toolCwdLabel({ cwd: "apps/web" })).toBe("apps/web");
    expect(toolCwdLabel({ cwd: "/elsewhere" })).toBe("/elsewhere");
  });
});

describe("runBlockedReason", () => {
  const base = {
    compat: V30,
    rootPath: "/r",
    tool: tool(),
    lastRun: undefined,
    platform: "macos" as const,
  };

  it("lets a runnable tool in a rooted workspace run", () => {
    expect(runBlockedReason(base)).toBeNull();
  });

  // The gate with a real consumer. Against a v29 daemon there is nowhere
  // to keep the run, and a Run button that launches a session and then
  // reports nothing is worse than one that is dark.
  it("names the daemon version first, because nothing else can lift it", () => {
    expect(runBlockedReason({ ...base, compat: V29 })).toMatch(/v30/);
  });

  it("refuses a tool that only means something on a rail", () => {
    const reason = runBlockedReason({ ...base, tool: tool({ kind: "until" }) });
    expect(reason).toMatch(/rail/);
  });

  // Ahead of the daemon gate, because nothing lifts it: offering a
  // version number as the reason would send the human to upgrade
  // something that leaves a completion rule exactly as unrunnable.
  it("names the kind before the daemon, since upgrading cannot help", () => {
    const reason = runBlockedReason({ ...base, compat: V29, tool: tool({ kind: "pr" }) });
    expect(reason).toMatch(/step/);
    expect(reason).not.toMatch(/v30/);
  });

  // Beside the kind and ahead of the daemon: no upgrade and no edit
  // moves a tool onto an operating system it does not run on, so a
  // version number here would send the human to fix the wrong thing.
  it("refuses a tool that cannot run on this platform, before the daemon gate", () => {
    const mailer = tool({ name: "Send an email (Mail.app)", platforms: ["macos"] });
    expect(runBlockedReason({ ...base, tool: mailer })).toBeNull();
    const reason = runBlockedReason({ ...base, compat: V29, tool: mailer, platform: "linux" });
    expect(reason).toBe("\u201cSend an email (Mail.app)\u201d runs only on macOS.");
    expect(reason).not.toMatch(/v30/);
  });

  // Outside a Tauri window there is no platform to ask, and a gate that
  // read that as "unsupported" would dark every Run button in a preview.
  it("lets a restricted tool run when the platform could not be told", () => {
    const mailer = tool({ name: "Send an email (Mail.app)", platforms: ["macos"] });
    expect(runBlockedReason({ ...base, tool: mailer, platform: null })).toBeNull();
  });

  it("refuses when the workspace has no root to run in", () => {
    expect(runBlockedReason({ ...base, rootPath: null })).toMatch(/root folder/);
  });

  // An absolute directory needs no root, so this one still runs -- the
  // check is "is there anywhere to run", not "is there a root".
  it("still runs a tool whose directory is absolute", () => {
    expect(
      runBlockedReason({ ...base, rootPath: null, tool: tool({ cwd: "/elsewhere" }) })
    ).toBeNull();
  });

  // Not an error: it is the tool doing what it was asked. Said last for
  // that reason.
  it("says a tool already running is already running", () => {
    const reason = runBlockedReason({ ...base, lastRun: run({ outcome: "running" }) });
    expect(reason).toMatch(/already running/);
  });

  it("lets a finished tool run again", () => {
    expect(runBlockedReason({ ...base, lastRun: run({ outcome: "failed" }) })).toBeNull();
  });
});

describe("search and the empty state", () => {
  it("matches a name, a description or a kind, but never the body", () => {
    const t = tool({ name: "Deploy", description: "ships it", body: "SECRETWORD" });
    expect(matchesToolSearch(t, "depl")).toBe(true);
    expect(matchesToolSearch(t, "ships")).toBe(true);
    expect(matchesToolSearch(t, "command")).toBe(true);
    expect(matchesToolSearch(t, "secretword")).toBe(false);
  });

  it("matches everything on an empty search", () => {
    expect(matchesToolSearch(tool(), "   ")).toBe(true);
  });

  it("says nothing while there is anything to show", () => {
    expect(toolsEmptyMessage([tool()], "")).toBeNull();
  });

  // Two different emptinesses: a library with nothing in it, and a
  // search that found nothing. Telling somebody to write a tool when
  // they have twenty and mistyped one is the wrong instruction.
  it("distinguishes an empty library from an empty search", () => {
    expect(toolsEmptyMessage([], "")).toMatch(/New tool/);
    expect(toolsEmptyMessage([], "zzz")).toMatch(/zzz/);
  });
});
