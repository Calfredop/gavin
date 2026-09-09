import { describe, it, expect } from "vitest";
import {
  agentActionToApply,
  availableAgentActions,
  buildCreatePlanArgs,
  composedCardView,
  toggleAgentAction,
  AGENT_ACTIONS,
  AGENT_ACTION_LABELS,
  composeHint,
  composeKeyAction,
  composeWindowKeyAction,
  defaultComposeStatus,
  railToApply,
  COMPOSE_KINDS,
  DEFAULT_COMPOSE_KIND,
  composeSlot,
  composeCloseAction,
  NEW_CARD_STATUS,
} from "$lib/cards/cardCompose";
import { AUTO_COMMIT_BLOCK } from "$lib/git/autoCommit";
import { isPermanentColumn, type CardView } from "$lib/planBoard";
import type { MergedBoard } from "$lib/board/boardSearch";
import { source } from "$lib/sources";

describe("COMPOSE_KINDS", () => {
  it("opens on task, so ⌘N files runnable work by default", () => {
    expect(DEFAULT_COMPOSE_KIND).toBe("task");
  });

  it("offers the note chip last", () => {
    expect(COMPOSE_KINDS).toEqual(["task", "plan", "note"]);
  });

  it("starts on the kind it offers first", () => {
    expect(COMPOSE_KINDS[0]).toBe(DEFAULT_COMPOSE_KIND);
  });
});

describe("buildCreatePlanArgs", () => {
  it("slugs the title into a file name", () => {
    const r = buildCreatePlanArgs({ kind: "note", title: "Fix the Login Flow!", body: "", status: "To Do" }, []);
    expect(r).toEqual({ fileName: "fix-the-login-flow.md", title: "Fix the Login Flow!", status: "To Do", body: undefined, kind: "note" });
  });

  it("suffixes on collision until free", () => {
    const r = buildCreatePlanArgs(
      { kind: "plan", title: "Demo", body: "b", status: "Done" },
      ["demo.md", "demo-2.md"]
    );
    expect(r).toMatchObject({ fileName: "demo-3.md", body: "b" });
  });

  it("errors on empty or unusable titles", () => {
    expect(buildCreatePlanArgs({ kind: "note", title: "   ", body: "", status: "x" }, [])).toHaveProperty("error");
    expect(buildCreatePlanArgs({ kind: "note", title: "!!!", body: "", status: "x" }, [])).toHaveProperty("error");
  });

  it("passes a task's prompt body through", () => {
    const r = buildCreatePlanArgs({ kind: "task", title: "T", body: "  do the thing  ", status: "To Do" }, []);
    expect(r).toMatchObject({ kind: "task", body: "do the thing" });
  });

  it("turns attached files into the frontmatter line CreatePlan writes", () => {
    const r = buildCreatePlanArgs(
      {
        kind: "task",
        title: "Fix login",
        body: "",
        status: "To Do",
        attachments: ["docs/spec.md", "/Users/x/shot.png"],
      },
      []
    );
    expect(r).toMatchObject({ attachments: "docs/spec.md, /Users/x/shot.png" });
  });

  it("gives a card with nothing attached no attachments line at all", () => {
    expect(
      buildCreatePlanArgs({ kind: "task", title: "T", body: "", status: "To Do" }, [])
    ).toMatchObject({ attachments: undefined });
    expect(
      buildCreatePlanArgs({ kind: "task", title: "T", body: "", status: "To Do", attachments: [] }, [])
    ).toMatchObject({ attachments: undefined });
  });

  it("folds the auto-commit block into the body, so one write files the whole card", () => {
    const r = buildCreatePlanArgs(
      { kind: "task", title: "T", body: "do the thing", status: "To Do", autoCommit: true },
      []
    );
    expect(r).toMatchObject({ body: `do the thing\n\n${AUTO_COMMIT_BLOCK}` });
  });

  it("makes the block the whole body when the prompt was left empty", () => {
    const r = buildCreatePlanArgs(
      { kind: "plan", title: "T", body: "  ", status: "To Do", autoCommit: true },
      []
    );
    expect(r).toMatchObject({ body: AUTO_COMMIT_BLOCK });
  });

  it("leaves the body alone when auto commit is off or absent", () => {
    expect(
      buildCreatePlanArgs(
        { kind: "task", title: "T", body: "do the thing", status: "To Do", autoCommit: false },
        []
      )
    ).toMatchObject({ body: "do the thing" });
    expect(
      buildCreatePlanArgs({ kind: "task", title: "T", body: "do the thing", status: "To Do" }, [])
    ).toMatchObject({ body: "do the thing" });
  });

  it("never puts the block on a note, even with the flag still set", () => {
    // The chips hide the checkbox on note but do not clear it, so the
    // flag can arrive true on a card nothing will ever execute.
    const r = buildCreatePlanArgs(
      { kind: "note", title: "T", body: "remember this", status: "To Do", autoCommit: true },
      []
    );
    expect(r).toMatchObject({ body: "remember this" });
  });
});

describe("defaultComposeStatus", () => {
  it("keeps the column that asked", () => {
    expect(defaultComposeStatus(["To Do", "In Progress", "Done"], "In Progress")).toBe("In Progress");
  });

  it("falls back to the leftmost column when nothing asked", () => {
    expect(defaultComposeStatus(["To Do", "Done"], null)).toBe("To Do");
  });

  it("falls back when the asking column is gone (renamed or deleted)", () => {
    expect(defaultComposeStatus(["To Do", "Done"], "Backlog")).toBe("To Do");
  });

  it("has no status to offer on a board with no columns", () => {
    expect(defaultComposeStatus([], "To Do")).toBeNull();
  });
});

describe("railToApply", () => {
  it("places a task or a plan on the picked rail", () => {
    expect(railToApply("task", "r1", ["r1", "r2"])).toBe("r1");
    expect(railToApply("plan", "r2", ["r1", "r2"])).toBe("r2");
  });

  it("never puts a note on a rail", () => {
    expect(railToApply("note", "r1", ["r1"])).toBeNull();
  });

  it("drops a rail deleted since the picker rendered", () => {
    expect(railToApply("task", "r9", ["r1"])).toBeNull();
  });

  it("no pick, no placement", () => {
    expect(railToApply("task", null, ["r1"])).toBeNull();
  });
});

describe("availableAgentActions", () => {
  const ctx = { kind: "task" as const, railId: null, canRun: true, canDevelop: true };

  it("offers run first — it is the action the composer's own shape asks for", () => {
    // ⌘N opens on the task chip with a prompt field, so the card being
    // typed is meant to be executed; develop is the detour back to an
    // interview and sits second.
    expect(availableAgentActions(ctx)).toEqual(["run", "develop"]);
    expect(AGENT_ACTIONS[0]).toBe("run");
  });

  it("keeps run to tasks and lets develop cover plans too", () => {
    // A plan's body is never inlined into the prompt, so running one
    // filed here would launch an agent at a checklist nobody wrote.
    expect(availableAgentActions({ ...ctx, kind: "plan" })).toEqual(["develop"]);
  });

  it("offers a note neither — nothing executes it and nothing shapes it", () => {
    expect(availableAgentActions({ ...ctx, kind: "note" })).toEqual([]);
  });

  it("takes both away once the card is going onto a rail", () => {
    // The rail launches the card when the human arms it; a second agent
    // started here would race that one or rewrite the card under it.
    expect(availableAgentActions({ ...ctx, railId: "r1" })).toEqual([]);
    expect(availableAgentActions({ ...ctx, kind: "plan", railId: "r1" })).toEqual([]);
  });

  it("offers only what the board handed the composer a handler for", () => {
    expect(availableAgentActions({ ...ctx, canRun: false })).toEqual(["develop"]);
    expect(availableAgentActions({ ...ctx, canDevelop: false })).toEqual(["run"]);
    expect(availableAgentActions({ ...ctx, canRun: false, canDevelop: false })).toEqual([]);
  });

  it("describes each action in one line, and never as the other one", () => {
    expect(AGENT_ACTION_LABELS.run.label).toBe("Run now with the agent");
    expect(AGENT_ACTION_LABELS.develop.label).toBe("Develop with agent on add");
    expect(AGENT_ACTION_LABELS.develop.hint).toContain("gavin-develop");
    expect(AGENT_ACTION_LABELS.develop.hint).toContain("does not start");
  });
});

describe("toggleAgentAction", () => {
  it("picks one and un-picks the other — they are one question", () => {
    expect(toggleAgentAction(null, "run")).toBe("run");
    expect(toggleAgentAction("develop", "run")).toBe("run");
    expect(toggleAgentAction("run", "develop")).toBe("develop");
  });

  it("un-picks on a second click, so 'no action' stays reachable", () => {
    // The reason these are checkboxes rather than radios: filing a card
    // with no agent on it is the ordinary case.
    expect(toggleAgentAction("run", "run")).toBeNull();
    expect(toggleAgentAction("develop", "develop")).toBeNull();
  });
});

describe("agentActionToApply", () => {
  it("takes the action the human ticked", () => {
    expect(agentActionToApply("develop", ["develop", "run"])).toBe("develop");
  });

  it("drops one whose checkbox has since gone off screen", () => {
    // Tick Run on a task, switch the chip to plan: the flag survives
    // under a control the composer has stopped drawing, and a card must
    // never be launched by a checkbox nobody can see. Same posture as
    // railToApply.
    expect(agentActionToApply("run", ["develop"])).toBeNull();
    expect(agentActionToApply("develop", [])).toBeNull();
  });

  it("no tick, no agent", () => {
    expect(agentActionToApply(null, ["develop", "run"])).toBeNull();
  });
});

describe("composedCardView", () => {
  const args = buildCreatePlanArgs(
    {
      kind: "task",
      title: "Fix login",
      body: "do it",
      status: "To Do",
      attachments: ["docs/a.md"],
      complexity: "intricate",
    },
    []
  );
  if ("error" in args) throw new Error(args.error);

  it("carries the level onto the view an action is handed", () => {
    // A card filed at "intricate" and acted on in the same gesture has
    // to reach the agent that level names, not the workspace's default.
    const view = composedCardView(args, "/ws/.gavin-root/plans/fix-login.md", "/ws/.gavin-root", "root", [
      "docs/a.md",
    ]);
    expect(view.complexity).toBe("intricate");
    expect(view.attachments).toEqual(["docs/a.md"]);
    expect(view.kind).toBe("task");
    expect(view.id).toBe("/ws/.gavin-root/plans/fix-login.md");
    expect(view.fileName).toBe("fix-login.md");
    expect(view.contextFolder).toBe("/ws/.gavin-root");
    expect(view.contextName).toBe("root");
    expect(view.status).toBe("To Do");
  });

  it("is a card nothing has happened to yet", () => {
    // Both actions launch off this view, and a fabricated parent, label
    // or checklist count would be a lie about a file just written.
    const view = composedCardView(args, "/p/t.md", "/p", "root", []);
    expect(view.parent).toBeNull();
    expect(view.parentBroken).toBe(false);
    expect(view.labels).toEqual([]);
    expect(view.nestedChildren).toEqual([]);
    expect(view.checklistTotal).toBe(0);
    expect(view.parseWarning).toBe(false);
  });

  it("copies the attachments rather than aliasing the composer's list", () => {
    // The composer clears its own list on every commit; a shared array
    // would empty the view's references out from under the launch.
    const live = ["docs/a.md"];
    const view = composedCardView(args, "/p/t.md", "/p", "root", live);
    live.length = 0;
    expect(view.attachments).toEqual(["docs/a.md"]);
  });
});

describe("composeKeyAction", () => {
  const press = (over: Partial<Record<string, unknown>> = {}) => ({
    key: "Enter",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  }) as Parameters<typeof composeKeyAction>[1];

  it("keeps the fast path: bare Enter in the title files the card", () => {
    expect(composeKeyAction("title", press(), true)).toBe("commit");
    expect(composeKeyAction("title", press(), false)).toBe("commit");
  });

  it("leaves a bare Enter in the body to the body", () => {
    // The reported bug is the OTHER half of this: the body had no
    // handler, so the footer still promised "Enter adds" there.
    expect(composeKeyAction("body", press(), true)).toBe("newline");
    expect(composeKeyAction("body", press(), false)).toBe("newline");
  });

  it("commits on the chord from either field", () => {
    expect(composeKeyAction("body", press({ metaKey: true }), true)).toBe("commit");
    expect(composeKeyAction("title", press({ metaKey: true }), true)).toBe("commit");
    expect(composeKeyAction("body", press({ ctrlKey: true }), false)).toBe("commit");
    expect(composeKeyAction("title", press({ ctrlKey: true }), false)).toBe("commit");
  });

  it("wants the platform's own chord, not the other one", () => {
    expect(composeKeyAction("body", press({ ctrlKey: true }), true)).toBeNull();
    expect(composeKeyAction("body", press({ metaKey: true }), false)).toBeNull();
  });

  it("gives the title a newline on shift", () => {
    expect(composeKeyAction("title", press({ shiftKey: true }), true)).toBe("newline");
    expect(composeKeyAction("body", press({ shiftKey: true }), true)).toBe("newline");
  });

  it("does not steal the shifted or alted chord", () => {
    expect(composeKeyAction("title", press({ metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(composeKeyAction("title", press({ altKey: true }), true)).toBeNull();
  });

  it("ignores every key that is not Enter", () => {
    expect(composeKeyAction("title", press({ key: "a" }), true)).toBeNull();
    expect(composeKeyAction("title", press({ key: "Escape" }), true)).toBeNull();
  });

  it("leaves an IME candidate's Enter alone", () => {
    expect(composeKeyAction("title", press({ isComposing: true }), true)).toBeNull();
    expect(composeKeyAction("title", press({ isComposing: true, metaKey: true }), true)).toBeNull();
  });
});

describe("composeWindowKeyAction", () => {
  const press = (over: Partial<Record<string, unknown>> = {}) => ({
    key: "Enter",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  }) as Parameters<typeof composeWindowKeyAction>[0];

  it("files the card from wherever focus is -- a chip, a button, nowhere", () => {
    // The reported bug: only the fields carried a handler, so the chord
    // did nothing while a kind chip, Add card, or the document held focus.
    expect(composeWindowKeyAction(press({ metaKey: true }), true)).toBe("commit");
    expect(composeWindowKeyAction(press({ ctrlKey: true }), false)).toBe("commit");
  });

  it("does not file it twice when a field already did", () => {
    // The field handler calls preventDefault, then the same event
    // reaches the window on its way up.
    expect(composeWindowKeyAction(press({ metaKey: true, defaultPrevented: true }), true)).toBeNull();
  });

  it("leaves a bare Enter alone -- that belongs to whatever has focus", () => {
    // Enter on the Add card button is a click, and in a textarea a
    // newline; neither is the window's to take.
    expect(composeWindowKeyAction(press(), true)).toBeNull();
    expect(composeWindowKeyAction(press({ shiftKey: true }), true)).toBeNull();
  });

  it("wants the platform's own chord, not the other one", () => {
    expect(composeWindowKeyAction(press({ ctrlKey: true }), true)).toBeNull();
    expect(composeWindowKeyAction(press({ metaKey: true }), false)).toBeNull();
  });

  it("does not steal the shifted or alted chord", () => {
    expect(composeWindowKeyAction(press({ metaKey: true, shiftKey: true }), true)).toBeNull();
    expect(composeWindowKeyAction(press({ metaKey: true, altKey: true }), true)).toBeNull();
  });

  it("ignores every key that is not Enter", () => {
    expect(composeWindowKeyAction(press({ key: "n", metaKey: true }), true)).toBeNull();
    expect(composeWindowKeyAction(press({ key: "Escape" }), true)).toBeNull();
  });

  it("leaves an IME candidate's Enter alone", () => {
    expect(composeWindowKeyAction(press({ isComposing: true, metaKey: true }), true)).toBeNull();
  });
});

describe("composeHint", () => {
  it("names Enter in the title and the chord in the body", () => {
    expect(composeHint("title", true)).toContain("Enter adds");
    expect(composeHint("body", true)).toContain("\u2318Enter adds");
    expect(composeHint("body", false)).toContain("Ctrl+Enter adds");
  });

  it("never promises a bare Enter files the card from the body", () => {
    expect(composeHint("body", true).startsWith("Enter adds")).toBe(false);
    expect(composeHint("body", false).startsWith("Enter adds")).toBe(false);
  });

  it("always says how to get out", () => {
    for (const field of ["title", "body"] as const)
      for (const mac of [true, false]) expect(composeHint(field, mac)).toContain("Esc closes");
  });
});

describe("NEW_CARD_STATUS", () => {
  // A card filed with a status no column carries lands in an auto
  // column, and composeSlot would place it at the end of THAT -- fine,
  // but not what the Plans tab means by filing a card. A permanent
  // column is the only status guaranteed to be on every board.
  it("names a column every board carries", () => {
    expect(isPermanentColumn(NEW_CARD_STATUS)).toBe(true);
  });
});

describe("composeSlot", () => {
  const NEW = "/ws/.gavin-root/plans/new.md";
  function card(fileName: string, over: Partial<CardView> = {}): CardView {
    return {
      id: `/ws/.gavin-root/plans/${fileName}`,
      title: fileName,
      status: "To Do",
      priority: null,
      order: null,
      kind: "task",
      parent: null,
      parentTitle: null,
      parentBroken: false,
      labels: [],
      checklistDone: 0,
      checklistTotal: 0,
      contextName: "root",
      contextFolder: "/ws",
      fileName,
      parseWarning: false,
      nestedChildren: [],
      ...over,
    };
  }
  function board(cards: Record<string, CardView[]>, auto: Record<string, CardView[]> = {}): MergedBoard {
    return {
      columns: Object.entries(cards).map(([name, planCards], i) => ({
        column: { id: `col-${name}`, name, position: i },
        planCards,
      })),
      autoColumns: Object.entries(auto).map(([status, planCards]) => ({ status, planCards })),
    };
  }

  it("appends to the end of the named column", () => {
    const merged = board({ "To Do": [card("a.md", { order: 1024 }), card("b.md", { order: 2048 })] });
    expect(composeSlot(merged, null, "To Do", NEW)).toEqual({
      cards: [
        { path: "/ws/.gavin-root/plans/a.md", order: 1024 },
        { path: "/ws/.gavin-root/plans/b.md", order: 2048 },
      ],
      index: 2,
    });
  });

  it("gives an empty column slot 0", () => {
    expect(composeSlot(board({ "To Do": [] }), null, "To Do", NEW)).toEqual({ cards: [], index: 0 });
  });

  it("matches the column by slug, not by spelling", () => {
    const merged = board({ "In Progress": [card("a.md")] });
    expect(composeSlot(merged, null, "in-progress", NEW)?.index).toBe(1);
  });

  it("finds an auto column when no real column carries the status", () => {
    const merged = board({ "To Do": [card("a.md")] }, { Blocked: [card("b.md"), card("c.md")] });
    expect(composeSlot(merged, null, "Blocked", NEW)?.index).toBe(2);
  });

  it("is null when the status resolves to no column at all", () => {
    expect(composeSlot(board({ "To Do": [] }), null, "Shipped", NEW)).toBeNull();
  });

  // A page-scoped board renumbers the WHOLE column (pageBoard.ts), so
  // "the end of what I can see" has to be translated into a slot in it.
  it("page-scoped: lands after the last card the page shows, not after the column", () => {
    const a = card("a.md");
    const b = card("b.md");
    const c = card("c.md");
    const merged = board({ "To Do": [a, b, c] });
    const scoped = board({ "To Do": [a, b] });
    expect(composeSlot(merged, scoped, "To Do", NEW)).toEqual({
      cards: [
        { path: a.id, order: null },
        { path: b.id, order: null },
        { path: c.id, order: null },
      ],
      index: 2,
    });
  });

  it("page-scoped: an empty page view appends to the whole column", () => {
    const merged = board({ "To Do": [card("a.md"), card("b.md")] });
    expect(composeSlot(merged, board({ "To Do": [] }), "To Do", NEW)?.index).toBe(2);
  });

  // The caller may read the projection after the optimistic patch has
  // already put the new card into it; handing it back to the order math
  // as one of its own neighbours would write it twice.
  it("leaves the card being placed out of its own block", () => {
    const merged = board({ "To Do": [card("a.md"), card("new.md"), card("z.md")] });
    const slot = composeSlot(merged, null, "To Do", NEW);
    expect(slot?.cards.map((c) => c.path)).toEqual([
      "/ws/.gavin-root/plans/a.md",
      "/ws/.gavin-root/plans/z.md",
    ]);
    expect(slot?.index).toBe(2);
  });

  it("page-scoped: excludes it from the page view too", () => {
    const a = card("a.md");
    const created = card("new.md");
    const z = card("z.md");
    const merged = board({ "To Do": [a, created, z] });
    const scoped = board({ "To Do": [a, created] });
    expect(composeSlot(merged, scoped, "To Do", NEW)?.index).toBe(1);
  });
});

describe("composeCloseAction", () => {
  const empty = { title: "", body: "", attachments: [] as string[] };

  it("closes an untouched composer on the first gesture", () => {
    expect(composeCloseAction(empty)).toBe("close");
  });

  it("confirms once a title has been typed", () => {
    expect(composeCloseAction({ ...empty, title: "Fix the login flow" })).toBe("confirm");
  });

  // The prompt is the half worth most: a title is retyped in seconds, a
  // paragraph of agent instructions is not.
  it("confirms on a body with no title", () => {
    expect(composeCloseAction({ ...empty, body: "Read the spec first." })).toBe("confirm");
  });

  // Picked with a file dialog, and the pick is gone with the modal.
  it("confirms on attachments alone", () => {
    expect(composeCloseAction({ ...empty, attachments: ["docs/spec.md"] })).toBe("confirm");
  });

  // A stray space from a click-through is not content, and prompting
  // over it would make the confirm feel arbitrary.
  it("treats whitespace-only fields as empty", () => {
    expect(composeCloseAction({ title: "  ", body: "\n\t ", attachments: [] })).toBe("close");
  });
});

// The policy above is only worth anything if every dismissal route in the
// template actually goes through it. Read from the source because the
// wiring IS the template -- there is no rendered assertion that catches an
// `onClose` handed straight to the backdrop again.
describe("CardComposeModal dismissal wiring", () => {
  const composer = source("CardComposeModal.svelte");

  it("hands Modal the guard, not onClose — Modal's backdrop and Escape both land there", () => {
    expect(composer).toContain("<Modal onClose={requestClose}>");
    expect(composer).not.toContain("<Modal {onClose}>");
  });

  it("routes the Cancel button through the same guard", () => {
    expect(composer).toContain('class="cancel" onclick={requestClose}');
  });

  it("offers the discard as the confirm's own choice", () => {
    expect(composer).toContain("<ConfirmPrompt");
    expect(composer).toContain('{ label: "Discard", danger: true, onPick: onClose }');
  });
});

// The composer is the one surface where the two actions meet, and every
// rule they share is invisible to the pure suite above: a checkbox wired
// to nothing renders perfectly, and a group whose two boxes each own
// their own flag looks identical until both are ticked. Source-read
// rather than mounted, following complexitySurfaces.test.ts.
describe("CardComposeModal agent actions", () => {
  const composer = source("CardComposeModal.svelte");

  it("draws the group from the shared list rather than two hand-written rows", () => {
    // Two independent `{#if}` blocks are how the pair stops being one
    // question -- and how one of them ends up with a rule the other
    // never got.
    expect(composer).toContain("<legend>Agent actions</legend>");
    expect(composer).toContain("{#each agentActions as action (action)}");
    expect(composer).toContain("AGENT_ACTION_LABELS[action].label");
  });

  it("holds ONE selection, so the boxes cannot both be on", () => {
    expect(composer).toContain("let agentAction = $state<AgentAction | null>(null)");
    expect(composer).toContain("checked={agentAction === action}");
    expect(composer).toContain("agentAction = toggleAgentAction(agentAction, action)");
    // The old per-action flag: a second one is how mutual exclusion
    // silently stops being mutual.
    expect(composer).not.toContain("runNow");
  });

  it("asks availableAgentActions what to draw, rather than re-deriving the rule", () => {
    expect(composer).toContain("availableAgentActions({");
    expect(composer).toContain("canRun: onRunCard !== null");
    expect(composer).toContain("canDevelop: onDevelopCard !== null");
    // Hidden entirely when there is nothing to offer: a heading over no
    // boxes reads as a broken control.
    expect(composer).toContain("{#if agentActions.length > 0}");
  });

  it("re-measures the tick against what is on screen before launching anything", () => {
    expect(composer).toContain("agentActionToApply(agentAction, agentActions)");
  });

  it("routes each action to its own handler, off one shared card view", () => {
    // Two separately-built views is how the level or the attachments
    // reach one launch route and not the other.
    expect(composer).toContain("composedCardView(args, path, contextFolder, ctxName, attachments)");
    expect(composer).toContain('action === "run" ? onRunCard?.(view) : onDevelopCard?.(view)');
  });

  it("clears the action after each card, and when a rail takes it over", () => {
    // It survives `reset()` nowhere: autoCommit and the level describe
    // the card, while this starts an agent, and inheriting that onto the
    // next card typed into the same open composer is a session nobody
    // asked for.
    expect(composer).toContain("agentAction = null;");
    expect(composer).toContain("if (railId) agentAction = null;");
  });
});
