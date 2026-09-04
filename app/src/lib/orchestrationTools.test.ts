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
  resolveToolParam,
  resolveToolCwd,
  GAVIN_ACTIONS,
  type Tool,
  type ToolRecord,
} from "./orchestrationTools";

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
    ...over,
  };
}

describe("the built-in set", () => {
  const builtin = (id: string): Tool => {
    const tool = BUILTIN_TOOLS.find((t) => t.id === id);
    if (!tool) throw new Error(`no built-in ${id}`);
    return tool;
  };

  it("ships sixteen tools with unique builtin: ids", () => {
    expect(BUILTIN_TOOLS).toHaveLength(16);
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
    expect([...kinds].sort()).toEqual(["agent", "command", "gavin", "pr", "script", "until"]);
  });

  // Chaining rails is the whole point: the last step of one rail arms
  // the next. Nothing else in the app can do it, which is why this is
  // the one built-in that is not a prompt or a command line.
  it("ships a Start rail action naming the rail by parameter", () => {
    const tool = builtin("builtin:start-rail");
    expect(tool.kind).toBe("gavin");
    expect(gavinActionOf(tool)).toBe("start-rail");
    // No default: a shipped rail name would arm somebody else's rail.
    expect(tool.params.map((p) => [p.name, p.default])).toEqual([["rail", ""]]);
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
