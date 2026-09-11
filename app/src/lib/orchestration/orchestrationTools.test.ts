import { describe, it, expect } from "vitest";
// @ts-expect-error node builtins are untyped here -- @types/node is not a
// dependency of this app, and vite.config.js reaches for a node global the
// same way. Used only to `bash -n` the shipped tool bodies (below).
import { execFileSync } from "node:child_process";
import {
  BUILTIN_TOOLS,
  toolLibrary,
  findTool,
  placeholdersIn,
  undeclaredPlaceholders,
  resolveToolBody,
  describeOverrides,
  pruneOverrides,
  duplicateTool,
  emptyTool,
  toRecord,
  validateTool,
  isBuiltinId,
  toolKindLabel,
  gavinActionOf,
  toolPlatformBlockedReason,
  resolveToolParam,
  resolveToolCwd,
  startRailWorkspaceChoices,
  GAVIN_ACTIONS,
  type Tool,
  type ToolRecord,
  TOOL_KINDS,
  PR_BODY,
  REVIEW_BODY,
  type ToolKind,
  bodyForKind,
  toolBodyEditor,
  toolKindParamNote,
} from "$lib/orchestration/orchestrationTools";

function record(over: Partial<ToolRecord> = {}): ToolRecord {
  return {
    id: "u1",
    workspaceId: "ws-1",
    name: "Deploy",
    description: "",
    kind: "command",
    body: "./deploy.sh {{env}}",
    params: [{ name: "env", label: "Environment", default: "staging" }],
    position: 0,
    cwd: null,
    icon: null,
    ...over,
  };
}

describe("the built-in set", () => {
  const builtin = (id: string): Tool => {
    const tool = BUILTIN_TOOLS.find((t) => t.id === id);
    if (!tool) throw new Error(`no built-in ${id}`);
    return tool;
  };

  it("ships seventeen tools with unique builtin: ids", () => {
    expect(BUILTIN_TOOLS).toHaveLength(17);
    const ids = BUILTIN_TOOLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(isBuiltinId)).toBe(true);
  });

  // The library dialog lists tools by name, so two tools sharing one is
  // a tool the human cannot pick deliberately.
  it("gives every built-in a distinct name", () => {
    const names = BUILTIN_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("covers every example the card named", () => {
    const ids = BUILTIN_TOOLS.map((t) => t.id);
    for (const wanted of [
      "builtin:commit",
      "builtin:push",
      "builtin:merge",
      "builtin:browser-test",
      "builtin:unity-tests",
      "builtin:send-email",
      "builtin:notify",
    ]) {
      expect(ids).toContain(wanted);
    }
  });

  // Both merge DIRECTIONS ship, and the names say which is which. A tool
  // step always runs in the rail's own checkout (executeToolLaunch), so a
  // merge authored there can only ever pull a branch IN -- it cannot land
  // the rail's work anywhere, and no parameter value makes it: git refuses
  // to check `main` out while another worktree holds it, and merging a
  // branch into itself is a no-op that still exits 0.
  it("names the in-bound merge for its direction", () => {
    const tool = builtin("builtin:merge");
    expect(tool.name).toMatch(/^Update from/);
    expect(tool.params.map((p) => p.name)).toEqual(["branch"]);
  });

  it("ships a merge that lands this rail's branch on another one", () => {
    const tool = builtin("builtin:merge-into");
    expect(tool.kind).toBe("agent");
    expect(tool.params.map((p) => [p.name, p.default])).toEqual([["base", "main"]]);
    // The whole bug in one assertion: the merge must run in the checkout
    // that HOLDS the base branch, which is never this one.
    expect(tool.body).toContain("git worktree list");
    expect(tool.body).toContain("git -C");
  });

  it("demonstrates every kind", () => {
    const kinds = new Set(BUILTIN_TOOLS.map((t) => t.kind));
    expect([...kinds].sort()).toEqual([
      "agent",
      "command",
      "gavin",
      "pr",
      "review",
      "script",
      "until",
    ]);
  });

  // The gate a rail stops at. Its whole contract is negative -- it runs
  // nothing, resolves nothing and asks for nothing -- so what is worth
  // pinning is that it stayed that way: a parameter added here would be
  // a field nothing substitutes, and a body that stopped being the fixed
  // one would be a command line the scheduler never runs.
  it("ships a Manual review gate that runs nothing and takes no parameters", () => {
    const tool = builtin("builtin:manual-review");
    expect(tool.kind).toBe("review");
    expect(tool.body).toBe(REVIEW_BODY);
    expect(tool.params).toEqual([]);
    // The description names the button that ends the wait: the step
    // offers Skip and Mark done like every running step, and a gate
    // whose exit the human has to guess at is a wedged rail.
    expect(tool.description).toContain("Skip");
  });

  // Chaining rails is the whole point: the last step of one rail arms
  // the next. Nothing else in the app can do it, which is why this is
  // the one built-in that is not a prompt or a command line.
  it("ships a Start rail action naming the rail by parameter", () => {
    const tool = builtin("builtin:start-rail");
    expect(tool.kind).toBe("gavin");
    expect(gavinActionOf(tool)).toBe("start-rail");
    // No default on either: a shipped rail name would arm somebody
    // else's rail, and a shipped workspace would send it somewhere the
    // human never chose. Blank `workspace` is this rail's own.
    expect(tool.params.map((p) => [p.name, p.default])).toEqual([
      ["rail", ""],
      ["workspace", ""],
    ]);
  });

  it("gives every gavin built-in a body naming a real action", () => {
    for (const tool of BUILTIN_TOOLS) {
      if (tool.kind !== "gavin") continue;
      expect(GAVIN_ACTIONS, tool.id).toContain(tool.body.trim());
    }
  });

  it("is marked builtin scope throughout, so nothing offers to edit one", () => {
    expect(BUILTIN_TOOLS.every((t) => t.scope === "builtin")).toBe(true);
  });

  // The authoring mistake this whole check exists to catch, applied to
  // the tools we ship ourselves.
  it("declares every placeholder its bodies use", () => {
    for (const tool of BUILTIN_TOOLS) {
      expect(undeclaredPlaceholders(tool), tool.id).toEqual([]);
    }
  });

  it("gives every parameter a label", () => {
    for (const tool of BUILTIN_TOOLS) {
      for (const param of tool.params) expect(param.label, `${tool.id}.${param.name}`).not.toBe("");
    }
  });

  // The bodies are SHELL SOURCE, and an unbalanced quote in one ships a
  // tool that fails the instant a rail reaches it. `bash -n` parses
  // without executing, so this costs nothing and catches the whole class.
  // (Repo is macOS-only per docs/dev-setup.md, so bash is a given.)
  it("every command and script built-in is syntactically valid shell", () => {
    for (const tool of BUILTIN_TOOLS) {
      if (tool.kind !== "command" && tool.kind !== "script") continue;
      const body = resolveToolBody(tool, {});
      expect(() => execFileSync("bash", ["-n"], { input: body, stdio: "pipe" }), tool.id).not.toThrow();
    }
  });

  // Same rule, with parameters filled in: substitution is literal, so a
  // value can only ever be pasted in verbatim, and the shipped defaults
  // must not be the thing that breaks it.
  it("stays valid shell with a parameter carrying spaces", () => {
    for (const tool of BUILTIN_TOOLS) {
      if (tool.kind !== "command" && tool.kind !== "script") continue;
      const filled = Object.fromEntries(tool.params.map((p) => [p.name, "a b c"]));
      const body = resolveToolBody(tool, filled);
      expect(() => execFileSync("bash", ["-n"], { input: body, stdio: "pipe" }), tool.id).not.toThrow();
    }
  });

  // Both notifiers, and a third branch for neither. The two that matter
  // are the ORDER -- osascript is tried first so a mac with Homebrew's
  // notify-send on it keeps notifying the way it always did -- and the
  // non-zero exit, which is the only thing separating "could not tell
  // you" from "told you".
  it("notifies through whichever notifier this machine has, and fails loudly with neither", () => {
    const tool = builtin("builtin:notify");
    // A branch cannot be one command line. `script` and not `gavin`:
    // the Tools tab's Run button is live for a script and dark for an
    // action, and testing a notification on its own is the whole reason
    // to press it.
    expect(tool.kind).toBe("script");
    const body = tool.body;
    expect(body.indexOf("osascript")).toBeLessThan(body.indexOf("notify-send"));
    expect(body).toContain("command -v osascript");
    expect(body).toContain("command -v notify-send");
    expect(body).toContain("exit 1");
    // The package, not just the binary: "notify-send: not found" sends
    // the human to a search engine, "install libnotify-bin" does not.
    expect(body).toContain("libnotify-bin");
    // It declares no `platforms`, deliberately. Needing something
    // installed is not the same fact as having nowhere to run, and
    // naming the missing package beats hiding the tool.
    expect(tool.platforms).toBeUndefined();
    expect(tool.description).toContain("notify-send");
  });

  // The one tool with nothing to fall back to: no Mail.app elsewhere,
  // `xdg-email` only opens a composer, and real sending wants an SMTP
  // account gavin does not hold.
  it("marks the Mail.app tool macOS-only, and nothing else", () => {
    expect(builtin("builtin:send-email").platforms).toEqual(["macos"]);
    const restricted = BUILTIN_TOOLS.filter((t) => t.platforms);
    expect(restricted.map((t) => t.id)).toEqual(["builtin:send-email"]);
  });

  it("names each kind for the dialog", () => {
    expect(toolKindLabel("agent")).toBe("Agent prompt");
    expect(toolKindLabel("command")).toBe("Bash command");
    expect(toolKindLabel("script")).toBe("Bash script");
    expect(toolKindLabel("gavin")).toBe("Gavin action");
  });
});

describe("toolLibrary", () => {
  it("is the built-ins plus the stored rows", () => {
    const library = toolLibrary([record()]);
    expect(library).toHaveLength(BUILTIN_TOOLS.length + 1);
    expect(findTool(library, "u1")?.name).toBe("Deploy");
  });

  it("labels a null workspaceId global and a set one workspace", () => {
    const library = toolLibrary([record({ id: "u1" }), record({ id: "g1", workspaceId: null })]);
    expect(findTool(library, "u1")?.scope).toBe("workspace");
    expect(findTool(library, "g1")?.scope).toBe("global");
  });

  // A hand-edited database must not be able to replace a shipped tool.
  it("ignores a stored row claiming a builtin: id", () => {
    const library = toolLibrary([record({ id: "builtin:push", name: "Hijacked" })]);
    expect(findTool(library, "builtin:push")?.name).toBe("Push branch");
  });

  it("is just the built-ins when nothing is stored", () => {
    expect(toolLibrary([])).toHaveLength(BUILTIN_TOOLS.length);
  });

  it("carries a stored icon through to the tool", () => {
    const library = toolLibrary([record({ icon: "rocket" })]);
    expect(findTool(library, "u1")?.icon).toBe("rocket");
  });

  // A row written by a daemon older than v33 has no `icon` key at all,
  // and `undefined` reaching a template would be a second spelling of
  // "wears its kind's glyph" that every consumer has to remember.
  it("reads a row with no icon key as no icon", () => {
    const older = record();
    delete (older as Partial<ToolRecord>).icon;
    expect(findTool(toolLibrary([older]), "u1")?.icon).toBeNull();
  });
});

describe("placeholders", () => {
  it("finds each distinct name once, in first-appearance order", () => {
    expect(placeholdersIn("{{b}} then {{a}} then {{b}}")).toEqual(["b", "a"]);
  });

  it("tolerates whitespace inside the braces", () => {
    expect(placeholdersIn("{{ env }}")).toEqual(["env"]);
  });

  it("ignores something that is not a placeholder", () => {
    expect(placeholdersIn("{{1bad}} {single} {{}}")).toEqual([]);
  });

  it("reports the ones no parameter declares", () => {
    expect(
      undeclaredPlaceholders({
        body: "git merge {{brnach}} into {{base}}",
        params: [{ name: "base", label: "Base", default: "main" }],
      })
    ).toEqual(["brnach"]);
  });
});

describe("resolveToolBody", () => {
  const tool = {
    body: "./deploy.sh {{env}} --tag {{tag}}",
    params: [
      { name: "env", label: "Env", default: "staging" },
      { name: "tag", label: "Tag", default: "latest" },
    ],
  };

  it("uses the default for a parameter with no override", () => {
    expect(resolveToolBody(tool, {})).toBe("./deploy.sh staging --tag latest");
  });

  it("uses the override where there is one", () => {
    expect(resolveToolBody(tool, { env: "prod" })).toBe("./deploy.sh prod --tag latest");
  });

  it("substitutes every occurrence of one parameter", () => {
    expect(
      resolveToolBody({ body: "{{a}}/{{a}}", params: [{ name: "a", label: "A", default: "x" }] }, {})
    ).toBe("x/x");
  });

  it("substitutes whitespace-padded placeholders too", () => {
    expect(
      resolveToolBody({ body: "{{ a }}", params: [{ name: "a", label: "A", default: "x" }] }, {})
    ).toBe("x");
  });

  // Leaving it verbatim turns an authoring typo into something visible
  // rather than a command that silently runs against the wrong thing.
  it("leaves an undeclared placeholder alone", () => {
    expect(resolveToolBody({ body: "git merge {{brnach}}", params: [] }, {})).toBe(
      "git merge {{brnach}}"
    );
  });

  // One pass, so a parameter can never expand into another parameter.
  it("does not re-scan a substituted value", () => {
    expect(
      resolveToolBody(
        {
          body: "{{a}}",
          params: [
            { name: "a", label: "A", default: "{{b}}" },
            { name: "b", label: "B", default: "boom" },
          ],
        },
        {}
      )
    ).toBe("{{b}}");
  });

  it("accepts an empty override, which is not the same as absent", () => {
    expect(resolveToolBody(tool, { env: "" })).toBe("./deploy.sh  --tag latest");
  });
});

describe("overrides", () => {
  const tool = {
    params: [
      { name: "env", label: "Env", default: "staging" },
      { name: "tag", label: "Tag", default: "latest" },
    ],
  };

  it("summarises only what actually differs from the default", () => {
    expect(describeOverrides(tool, { env: "prod", tag: "latest" })).toBe("env=prod");
  });

  it("summarises nothing when the step runs the tool as it ships", () => {
    expect(describeOverrides(tool, {})).toBe("");
  });

  it("prunes overrides equal to the default, so a later default edit reaches the step", () => {
    expect(pruneOverrides(tool, { env: "staging", tag: "v2" })).toEqual({ tag: "v2" });
  });

  it("prunes overrides for parameters the tool no longer declares", () => {
    expect(pruneOverrides(tool, { gone: "x", env: "prod" })).toEqual({ env: "prod" });
  });

  it("keeps a deliberate empty override", () => {
    expect(pruneOverrides(tool, { env: "" })).toEqual({ env: "" });
  });
});

describe("toolPlatformBlockedReason", () => {
  const mailer = { name: "Send an email (Mail.app)", platforms: ["macos"] as const };

  it("says nothing about a tool that declares no platforms", () => {
    expect(toolPlatformBlockedReason({ name: "Push branch" }, "linux")).toBeNull();
    expect(toolPlatformBlockedReason({ name: "Push branch", platforms: [] }, "linux")).toBeNull();
  });

  it("says nothing on a platform the tool declares", () => {
    expect(toolPlatformBlockedReason(mailer, "macos")).toBeNull();
  });

  // Names the TOOL, because two of the three callers -- the stall on a
  // rail step and the refusal in `launch()` -- have no row beside them
  // saying which tool is meant.
  it("names the tool and where it runs, everywhere else", () => {
    expect(toolPlatformBlockedReason(mailer, "linux")).toBe(
      "“Send an email (Mail.app)” runs only on macOS."
    );
    expect(toolPlatformBlockedReason(mailer, "windows")).toBe(
      "“Send an email (Mail.app)” runs only on macOS."
    );
  });

  it("lists several platforms readably", () => {
    expect(
      toolPlatformBlockedReason({ name: "X", platforms: ["macos", "linux"] }, "windows")
    ).toBe("“X” runs only on macOS or Linux.");
  });

  // The null is the whole reason the platform type has one. A gate that
  // read "could not tell" as "not supported" would refuse in every unit
  // test and every browser preview -- the one place a wrong refusal is
  // invisible until it ships.
  it("blocks nothing when the platform could not be told", () => {
    expect(toolPlatformBlockedReason(mailer, null)).toBeNull();
  });
});

describe("editing", () => {
  it("starts a new tool workspace-scoped — the narrower scope", () => {
    expect(emptyTool("u9").scope).toBe("workspace");
  });

  it("duplicates a built-in into an editable workspace tool", () => {
    const copy = duplicateTool(BUILTIN_TOOLS[1], "u9");
    expect(copy.id).toBe("u9");
    expect(copy.scope).toBe("workspace");
    expect(copy.name).toBe("Push branch (copy)");
    expect(copy.body).toBe(BUILTIN_TOOLS[1].body);
  });

  it("deep-copies params, so editing the duplicate cannot touch the built-in", () => {
    const copy = duplicateTool(BUILTIN_TOOLS[1], "u9");
    copy.params[0].default = "upstream";
    expect(BUILTIN_TOOLS[1].params[0].default).toBe("origin");
  });

  // Duplicating the macOS-only mailer is exactly how a Linux human
  // re-points it at msmtp or a script of their own, so the copy must not
  // inherit the refusal -- and could not keep it anyway, since toRecord
  // names the record's fields one by one and this is not among them.
  it("drops a built-in's platform restriction, so the copy runs where the human is", () => {
    const mailer = BUILTIN_TOOLS.find((t) => t.id === "builtin:send-email") as Tool;
    expect(mailer.platforms).toEqual(["macos"]);
    const copy = duplicateTool(mailer, "u9");
    expect(copy.platforms).toBeUndefined();
    expect(toolPlatformBlockedReason(copy, "linux")).toBeNull();
    expect("platforms" in toRecord(copy, "ws-1", 0)).toBe(false);
  });

  it("maps a global tool to a null workspaceId on the wire", () => {
    const tool: Tool = { ...emptyTool("u1"), name: "x", body: "y", scope: "global" };
    expect(toRecord(tool, "ws-1", 3).workspaceId).toBeNull();
  });

  it("maps a workspace tool to its workspace id", () => {
    const tool: Tool = { ...emptyTool("u1"), name: "x", body: "y" };
    expect(toRecord(tool, "ws-1", 3).workspaceId).toBe("ws-1");
  });

  it("trims the name and description on the way out", () => {
    const tool: Tool = { ...emptyTool("u1"), name: "  x  ", description: " d ", body: "y" };
    const out = toRecord(tool, "ws-1", 0);
    expect(out.name).toBe("x");
    expect(out.description).toBe("d");
  });

  it("refuses to turn a built-in into a save", () => {
    expect(() => toRecord(BUILTIN_TOOLS[0], "ws-1", 0)).toThrow();
  });

  // An untouched field is not a directory. Both spellings have to reach
  // the daemon as null, or the launcher would have to resolve `""`
  // against the root and the row would show a blank directory.
  it("normalises a blank working directory to absent", () => {
    const tool: Tool = { ...emptyTool("u1"), name: "x", body: "y" };
    expect(toRecord({ ...tool, cwd: "  " }, "ws-1", 0).cwd).toBeNull();
    expect(toRecord({ ...tool, cwd: null }, "ws-1", 0).cwd).toBeNull();
    expect(toRecord({ ...tool, cwd: " apps/web " }, "ws-1", 0).cwd).toBe("apps/web");
  });

  // Same rule for the icon, one version later: "wears its kind's glyph"
  // has to have one spelling on the wire, or every reader has to
  // remember that "" is a second absence.
  it("normalises a blank icon to absent", () => {
    const tool: Tool = { ...emptyTool("u1"), name: "x", body: "y" };
    expect(toRecord({ ...tool, icon: "  " }, "ws-1", 0).icon).toBeNull();
    expect(toRecord({ ...tool, icon: null }, "ws-1", 0).icon).toBeNull();
    expect(toRecord({ ...tool, icon: " rocket " }, "ws-1", 0).icon).toBe("rocket");
  });

  // The deliberate half: an icon this build cannot draw is still a
  // choice its author made -- from a newer gavin, or from a library
  // entry since renamed -- and an unrelated edit must not take it away.
  // `toolIcon` degrades the DRAWING; the record keeps the fact.
  it("keeps an icon name it cannot resolve rather than dropping it", () => {
    const tool: Tool = { ...emptyTool("u1"), name: "x", body: "y", icon: "teleporter" };
    expect(toRecord(tool, "ws-1", 0).icon).toBe("teleporter");
  });
});

describe("authoring a kind", () => {
  // All of them, and the order matters: the three that also run on their
  // own come first, because the Tools tab is where most tools are
  // written.
  it("offers every kind, runnable ones first", () => {
    expect(TOOL_KINDS).toEqual([
      "agent",
      "command",
      "script",
      "until",
      "pr",
      "review",
      "gavin",
    ]);
  });

  // Every kind, checked against the type rather than against a list
  // written out here: a kind added to ToolKind and forgotten in
  // TOOL_KINDS is a tool nobody can author, and nothing else fails.
  it("leaves no kind unauthorable", () => {
    const kinds: ToolKind[] = [
      "agent",
      "command",
      "script",
      "gavin",
      "until",
      "pr",
      "review",
    ];
    expect([...TOOL_KINDS].sort()).toEqual([...kinds].sort());
  });

  it("gives each kind a body editor of the shape its body actually has", () => {
    expect(toolBodyEditor("agent")).toMatchObject({ shape: "text", mono: false, rows: 8 });
    expect(toolBodyEditor("command")).toMatchObject({ shape: "text", mono: true, rows: 3 });
    expect(toolBodyEditor("script")).toMatchObject({ shape: "text", mono: true, rows: 8 });
    // The check IS the body, so it is a command line -- but the field
    // has to say "check", or a human writes a step and expects it to run
    // once.
    expect(toolBodyEditor("until")).toMatchObject({ shape: "text", label: "Check command" });
    expect(toolBodyEditor("gavin").shape).toBe("action");
    expect(toolBodyEditor("pr").shape).toBe("none");
    // Nothing to write for the same reason `pr` has nothing: the step
    // runs no source at all. A text box here would invite a prompt
    // nobody would ever read.
    expect(toolBodyEditor("review").shape).toBe("none");
  });

  // A stray click on a chip must cost a click, not an authored body --
  // and the two kinds with a FIXED body are the two that can destroy
  // one. `review` joins `pr` in that rule rather than beside it.
  it("stashes an authored body across a switch to review and back", () => {
    expect(bodyForKind("review", "npm test", null)).toBe(REVIEW_BODY);
    expect(bodyForKind("command", REVIEW_BODY, "npm test")).toBe("npm test");
    // Nothing was ever put away, so there is nothing to restore and the
    // fixed body stays rather than being swapped for an empty box.
    expect(bodyForKind("command", REVIEW_BODY, null)).toBe(REVIEW_BODY);
  });

  it("names the parameters the three argument kinds read, and nobody else's", () => {
    expect(toolKindParamNote("until")).toContain("`max`");
    expect(toolKindParamNote("pr")).toContain("`require`");
    expect(toolKindParamNote("gavin")).toContain("`rail`");
    // `review` reads none: it takes no arguments at all, and a note
    // promising one would send a human looking for a field to fill in.
    for (const kind of ["agent", "command", "script", "review"] as const) {
      expect(toolKindParamNote(kind), kind).toBeNull();
    }
  });
});

describe("bodyForKind", () => {
  // `validateTool` refuses an empty body, and `gavinActionOf` reads this
  // one: a switch that left a prompt behind would save a gavin tool
  // naming nothing.
  it("imposes the fixed body on the two kinds that do not author one", () => {
    expect(bodyForKind("pr", "npm test", null)).toBe(PR_BODY);
    expect(bodyForKind("gavin", "npm test", null)).toBe(GAVIN_ACTIONS[0]);
  });

  it("keeps a gavin body that already names an action", () => {
    expect(bodyForKind("gavin", "  start-rail  ", null)).toBe("start-rail");
  });

  it("leaves an authored body alone when the new kind authors one too", () => {
    expect(bodyForKind("script", "npm test", null)).toBe("npm test");
    expect(bodyForKind("until", "npm test", "stashed")).toBe("npm test");
  });

  // The whole point of the stash: clicking the wrong chip costs a click,
  // not eight lines of prompt. A fixed body is not source, so nothing is
  // lost by replacing it.
  it("restores the stashed body when a fixed one is switched away from", () => {
    expect(bodyForKind("agent", PR_BODY, "Review the diff.")).toBe("Review the diff.");
    expect(bodyForKind("command", "start-rail", "npm test")).toBe("npm test");
  });

  it("keeps the fixed body when there is nothing stashed to put back", () => {
    expect(bodyForKind("agent", PR_BODY, null)).toBe(PR_BODY);
  });

  // A new tool's body is blank, and blank is worth restoring: reading an
  // empty stash as "nothing was put away" is what leaves "await-pr"
  // sitting in a brand-new tool's Command field.
  it("restores a stashed body that was empty", () => {
    expect(bodyForKind("command", PR_BODY, "")).toBe("");
  });
});

describe("validateTool", () => {
  const ok: Tool = { ...emptyTool("u1"), name: "Deploy", body: "./deploy.sh" };

  it("passes a complete tool", () => {
    expect(validateTool(ok)).toBeNull();
  });

  it("needs a name", () => {
    expect(validateTool({ ...ok, name: "  " })).toMatch(/name/);
  });

  it("needs a body", () => {
    expect(validateTool({ ...ok, body: "\n" })).toMatch(/body/);
  });

  it("rejects a parameter name that cannot be a placeholder", () => {
    expect(validateTool({ ...ok, params: [{ name: "1x", label: "", default: "" }] })).toMatch(/1x/);
  });

  it("rejects two parameters with the same name", () => {
    expect(
      validateTool({
        ...ok,
        params: [
          { name: "a", label: "", default: "" },
          { name: "a", label: "", default: "" },
        ],
      })
    ).toMatch(/both/);
  });

  // Unreachable from the dialog, which offers only the three authorable
  // kinds -- but such a tool would stall every step it was dropped onto,
  // with the mistake discoverable only when a rail reached one.
  it("rejects a gavin tool whose body names no action", () => {
    expect(validateTool({ ...ok, kind: "gavin", body: "stop-rail" })).toMatch(/stop-rail/);
    expect(validateTool({ ...ok, kind: "gavin", body: "start-rail" })).toBeNull();
  });

  // Only the BODY is substituted (resolveToolBody); resolveToolCwd
  // resolves, it does not substitute. A directory with a placeholder in
  // it would look parameterised and would not be, and the session would
  // start in a folder literally called `{{env}}`.
  it("rejects a placeholder in the working directory", () => {
    expect(validateTool({ ...ok, cwd: "builds/{{env}}" })).toMatch(/working directory/);
    expect(validateTool({ ...ok, cwd: "builds/staging" })).toBeNull();
  });
});

describe("gavinActionOf", () => {
  const tool = (over: Partial<Tool> = {}): Tool => ({ ...emptyTool("u1"), ...over });

  it("reads the action out of a gavin tool's body", () => {
    expect(gavinActionOf(tool({ kind: "gavin", body: " start-rail\n" }))).toBe("start-rail");
  });

  it("is null for a tool of any other kind, whatever its body says", () => {
    expect(gavinActionOf(tool({ kind: "command", body: "start-rail" }))).toBeNull();
  });

  // A plan written by a NEWER gavin can name an action this build does
  // not implement. Guessing would run the wrong one.
  it("is null for an action this version does not know", () => {
    expect(gavinActionOf(tool({ kind: "gavin", body: "delete-everything" }))).toBeNull();
  });
});

describe("startRailWorkspaceChoices", () => {
  const ws = (id: string, rootPath: string | null = "/x") => ({ id, name: id, rootPath });

  it("offers every other rooted workspace", () => {
    const choices = startRailWorkspaceChoices([ws("ws-1"), ws("ws-2"), ws("ws-3")], "ws-1");
    expect(choices.map((w) => w.id)).toEqual(["ws-2", "ws-3"]);
  });

  it("excludes the rail's own workspace", () => {
    expect(startRailWorkspaceChoices([ws("ws-1")], "ws-1")).toEqual([]);
  });

  // An unrooted workspace has no `.gavin-root` and so no orchestration
  // plan -- offering it would be a pick that always refuses.
  it("excludes an unrooted workspace", () => {
    const choices = startRailWorkspaceChoices([ws("ws-1"), ws("ws-2", null)], "ws-1");
    expect(choices).toEqual([]);
  });
});

describe("resolveToolParam", () => {
  const tool = { params: [{ name: "rail", label: "Rail", default: "Deploy" }] };

  it("prefers the step's override", () => {
    expect(resolveToolParam(tool, { rail: "Docs" }, "rail")).toBe("Docs");
  });

  it("falls back to the tool's own default", () => {
    expect(resolveToolParam(tool, {}, "rail")).toBe("Deploy");
  });

  // An override the human deliberately blanked is NOT the default: they
  // cleared the field, and the caller has to see that.
  it("keeps an override that is empty", () => {
    expect(resolveToolParam(tool, { rail: "" }, "rail")).toBe("");
  });

  it("is empty for a parameter the tool does not declare", () => {
    expect(resolveToolParam(tool, { other: "x" }, "other")).toBe("");
  });
});

// A tool's own working directory (v30). Only a STANDALONE run reads it:
// a rail step runs in the rail's checkout and never asks the tool, which
// railStepCwd's own test pins from the other side.
describe("resolveToolCwd", () => {
  it("is the workspace root when the tool names no directory", () => {
    expect(resolveToolCwd({ cwd: null }, "/r")).toBe("/r");
    expect(resolveToolCwd({}, "/r")).toBe("/r");
    expect(resolveToolCwd({ cwd: "   " }, "/r")).toBe("/r");
    expect(resolveToolCwd({ cwd: "." }, "/r")).toBe("/r");
  });

  it("resolves a relative directory against the root", () => {
    expect(resolveToolCwd({ cwd: "apps/web" }, "/r")).toBe("/r/apps/web");
    expect(resolveToolCwd({ cwd: "./apps/web" }, "/r")).toBe("/r/apps/web");
  });

  it("joins one root to one path however the root was spelled", () => {
    expect(resolveToolCwd({ cwd: "apps" }, "/r/")).toBe("/r/apps");
  });

  it("keeps an absolute directory exactly as written", () => {
    expect(resolveToolCwd({ cwd: "/elsewhere/repo" }, "/r")).toBe("/elsewhere/repo");
  });

  // An absolute path needs no root, so it still answers -- but a
  // relative one has nothing to resolve against, and guessing would
  // start a session wherever the app happens to be.
  it("refuses a relative directory with no root to resolve against", () => {
    expect(resolveToolCwd({ cwd: "apps/web" }, null)).toBeNull();
    expect(resolveToolCwd({ cwd: null }, null)).toBeNull();
    expect(resolveToolCwd({ cwd: "/abs" }, null)).toBe("/abs");
  });
});
