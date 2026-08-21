// The tool library, as pure data and pure functions (tools spec T7). No
// Svelte, no Tauri, no I/O -- toolsState.ts owns every side effect and
// orchestrationState.ts owns launching. TS mirrors of crates/protocol's
// ToolDef/ToolParam (camelCase on the wire).
//
// A tool is a reusable unit of work droppable onto a rail: an agent
// prompt, a shell command line, or a bash script. Built-ins are
// constants here and never reach the daemon; everything else is stored
// per workspace or global to the machine.

export type ToolKind = "agent" | "command" | "script";

/// Where a tool came from. `builtin` is read-only -- the library dialog
/// offers Duplicate instead of Edit. Derived from the wire's
/// `workspaceId`, never stored: null is global, a string is that
/// workspace's own.
export type ToolScope = "builtin" | "global" | "workspace";

export interface ToolParam {
  /// `{{name}}` in the body.
  name: string;
  label: string;
  default: string;
}

export interface Tool {
  /// Built-ins use "builtin:<slug>"; everything else is a UUID.
  id: string;
  name: string;
  description: string;
  kind: ToolKind;
  body: string;
  params: ToolParam[];
  scope: ToolScope;
}

/// One tool as the daemon stores it. `workspaceId` IS the scope.
export interface ToolRecord {
  id: string;
  workspaceId: string | null;
  name: string;
  description: string;
  kind: ToolKind;
  body: string;
  params: ToolParam[];
  position: number;
}

export const TOOL_KINDS: ToolKind[] = ["agent", "command", "script"];

export function toolKindLabel(kind: ToolKind): string {
  return kind === "agent" ? "Agent prompt" : kind === "command" ? "Bash command" : "Bash script";
}

export function isBuiltinId(id: string): boolean {
  return id.startsWith("builtin:");
}

// ---- The built-in set ------------------------------------------------------
// Ten tools covering every example the card named, and demonstrating all
// three kinds. Data, not code: nothing about running these is special.
//
// Substitution is LITERAL (spec T3) -- the tool author owns the quoting.
// The bodies below are written with that in mind.

export const BUILTIN_TOOLS: Tool[] = [
  {
    id: "builtin:commit",
    name: "Commit changes",
    description: "An agent reads the diff and commits it in logical chunks. Never pushes.",
    kind: "agent",
    scope: "builtin",
    params: [],
    body:
      "Commit the uncommitted work in this checkout.\n\n" +
      "1. Read `git status` and `git diff` (staged and unstaged) before deciding anything.\n" +
      "2. Group unrelated changes into SEPARATE commits rather than one catch-all.\n" +
      "3. Write a conventional-commit subject for each (`feat(scope): …`, `fix(scope): …`), " +
      "describing what changed and why, not which files moved.\n" +
      "4. Do NOT push, and do not amend or rewrite any existing commit.\n\n" +
      "If there is nothing to commit, say so and stop — that is a success, not a problem.",
  },
  {
    id: "builtin:push",
    name: "Push branch",
    description: "Pushes the checked-out branch, setting upstream on first push.",
    kind: "command",
    scope: "builtin",
    params: [{ name: "remote", label: "Remote", default: "origin" }],
    body: "git push -u {{remote}} HEAD",
  },
  {
    id: "builtin:merge",
    name: "Merge a branch",
    description:
      "An agent merges a branch in, resolving conflicts or aborting cleanly rather than " +
      "leaving the checkout mid-merge.",
    kind: "agent",
    scope: "builtin",
    params: [{ name: "branch", label: "Branch to merge in", default: "main" }],
    body:
      "Merge the branch `{{branch}}` into the branch checked out in this worktree.\n\n" +
      "1. Run `git merge --no-edit {{branch}}`.\n" +
      "2. If it conflicts, resolve each conflict by understanding BOTH sides — never by " +
      "taking one wholesale — then run the project's tests before committing the merge.\n" +
      "3. If you cannot resolve a conflict confidently, run `git merge --abort` and explain " +
      "exactly what blocked you. An aborted merge is a better outcome than a wrong one.\n\n" +
      "Do not push.",
  },
  {
    id: "builtin:open-pr",
    name: "Open a pull request",
    description: "Opens a PR from the current branch with the GitHub CLI. Requires `gh`.",
    kind: "command",
    scope: "builtin",
    params: [{ name: "base", label: "Base branch", default: "main" }],
    body: "gh pr create --fill --base {{base}} --head \"$(git rev-parse --abbrev-ref HEAD)\"",
  },
  {
    id: "builtin:run-tests",
    name: "Run tests",
    description: "Runs the project's test command. The step is done when it exits 0.",
    kind: "command",
    scope: "builtin",
    params: [{ name: "command", label: "Test command", default: "npm test" }],
    body: "{{command}}",
  },
  {
    id: "builtin:unity-tests",
    name: "Run Unity tests",
    description: "Runs a Unity project's test platform in batch mode, logging to the terminal.",
    kind: "command",
    scope: "builtin",
    params: [
      {
        name: "unity",
        label: "Unity executable",
        default: "/Applications/Unity/Hub/Editor/6000.0.32f1/Unity.app/Contents/MacOS/Unity",
      },
      { name: "project", label: "Project path", default: "." },
      { name: "platform", label: "Test platform (EditMode / PlayMode)", default: "EditMode" },
      { name: "results", label: "Results file", default: "TestResults.xml" },
    ],
    body:
      '"{{unity}}" -runTests -batchmode -projectPath "{{project}}" ' +
      '-testPlatform {{platform}} -testResults "{{results}}" -logFile -',
  },
  {
    id: "builtin:browser-test",
    name: "Browser test (Chrome)",
    description: "An agent drives the Claude-in-Chrome tools through a checklist against a URL.",
    kind: "agent",
    scope: "builtin",
    params: [
      { name: "url", label: "URL", default: "http://localhost:5173" },
      {
        name: "checks",
        label: "Checks (one per line)",
        default: "- the page renders with no console errors",
      },
    ],
    body:
      "Use the Claude-in-Chrome browser tools to test {{url}}.\n\n" +
      "Open it in a NEW tab, then verify each of these:\n{{checks}}\n\n" +
      "Read the console with read_console_messages and report any errors. " +
      "Report pass/fail per check with the evidence you actually saw — never assume a " +
      "check passed because the page loaded. Close the tab when you are done.",
  },
  {
    id: "builtin:code-review",
    name: "Review this branch",
    description: "An agent reviews the branch's diff and reports findings. Changes nothing.",
    kind: "agent",
    scope: "builtin",
    params: [{ name: "base", label: "Compare against", default: "main" }],
    body:
      "Review the changes on this branch against `{{base}}`.\n\n" +
      "Look for correctness bugs first, then reuse and simplification opportunities. " +
      "For each finding give the file:line, what breaks, and a concrete failing case. " +
      "Rank most-severe first, and say plainly if you find nothing.\n\n" +
      "Do NOT change any code — this is a review, not a fix.",
  },
  {
    id: "builtin:notify",
    name: "Send a notification",
    description: "A macOS notification via osascript. A quote in the text will break it.",
    kind: "command",
    scope: "builtin",
    params: [
      { name: "title", label: "Title", default: "gavin" },
      { name: "message", label: "Message", default: "The rail reached this step." },
    ],
    body: `osascript -e 'display notification "{{message}}" with title "{{title}}"'`,
  },
  {
    id: "builtin:send-email",
    name: "Send an email (Mail.app)",
    description: "Sends through macOS Mail.app via osascript. A quote in the text will break it.",
    kind: "script",
    scope: "builtin",
    params: [
      { name: "to", label: "To", default: "" },
      { name: "subject", label: "Subject", default: "gavin: the rail finished" },
      { name: "body", label: "Body", default: "The rail reached this step." },
    ],
    // The heredoc is single-quoted, so the SHELL expands nothing inside
    // it -- every {{param}} is already substituted by the time this runs.
    body: [
      "set -euo pipefail",
      "osascript <<'APPLESCRIPT'",
      'tell application "Mail"',
      "  set gavinMessage to make new outgoing message with properties " +
        '{subject:"{{subject}}", content:"{{body}}", visible:false}',
      "  tell gavinMessage",
      "    make new to recipient at end of to recipients with properties " +
        '{address:"{{to}}"}',
      "    send",
      "  end tell",
      "end tell",
      "APPLESCRIPT",
    ].join("\n"),
  },
];

// ---- Resolution ------------------------------------------------------------

/// The whole library the tab offers: built-ins, then the daemon's rows.
/// A workspace tool SHADOWS a global one with the same id -- ids are
/// unique in SQLite, so that only happens when a tool changed scope and
/// a stale row survived, in which case the workspace's own wins.
export function toolLibrary(records: ToolRecord[]): Tool[] {
  const byId = new Map<string, Tool>();
  for (const tool of BUILTIN_TOOLS) byId.set(tool.id, tool);
  for (const record of records) {
    // A built-in id in the store is not writable through the app, but a
    // hand-edited database must not be able to replace a built-in.
    if (isBuiltinId(record.id)) continue;
    const existing = byId.get(record.id);
    if (existing && existing.scope === "workspace" && record.workspaceId === null) continue;
    byId.set(record.id, {
      id: record.id,
      name: record.name,
      description: record.description,
      kind: record.kind,
      body: record.body,
      params: record.params,
      scope: record.workspaceId === null ? "global" : "workspace",
    });
  }
  return [...byId.values()];
}

export function findTool(library: Tool[], toolId: string): Tool | undefined {
  return library.find((t) => t.id === toolId);
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/// Every distinct `{{placeholder}}` in a body, in first-appearance
/// order. The library dialog uses this to flag a placeholder no param
/// declares -- the single most likely authoring mistake.
export function placeholdersIn(body: string): string[] {
  const seen: string[] = [];
  for (const match of body.matchAll(PLACEHOLDER)) {
    if (!seen.includes(match[1])) seen.push(match[1]);
  }
  return seen;
}

/// Placeholders the body uses that no parameter declares.
export function undeclaredPlaceholders(tool: Pick<Tool, "body" | "params">): string[] {
  const declared = new Set(tool.params.map((p) => p.name));
  return placeholdersIn(tool.body).filter((name) => !declared.has(name));
}

/// The body with every declared `{{param}}` replaced by the step's
/// override, else the param's default.
///
/// Substitution is LITERAL and one-pass: a value containing `{{x}}` is
/// NOT re-scanned, so a parameter can never expand into another. An
/// UNDECLARED placeholder is left verbatim -- silently blanking a typo
/// like `{{brnach}}` would turn an authoring mistake into a command that
/// runs against the wrong thing.
export function resolveToolBody(
  tool: Pick<Tool, "body" | "params">,
  overrides: Record<string, string>
): string {
  const value = new Map<string, string>();
  for (const param of tool.params) {
    value.set(param.name, overrides[param.name] ?? param.default);
  }
  return tool.body.replace(PLACEHOLDER, (whole, name: string) => value.get(name) ?? whole);
}

/// A one-line summary of the params a step actually OVERRODE, for the
/// chip. Empty when the step runs the tool as it ships, which is the
/// common case and deserves no visual weight.
export function describeOverrides(
  tool: Pick<Tool, "params">,
  overrides: Record<string, string>
): string {
  return tool.params
    .filter((p) => p.name in overrides && overrides[p.name] !== p.default)
    .map((p) => `${p.name}=${overrides[p.name]}`)
    .join(" · ");
}

/// Drops overrides equal to the tool's own default, so a later edit to
/// that default still reaches steps that never deliberately overrode it
/// (spec §5.4). Also drops overrides for params the tool no longer has.
export function pruneOverrides(
  tool: Pick<Tool, "params">,
  overrides: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const param of tool.params) {
    const value = overrides[param.name];
    if (value !== undefined && value !== param.default) out[param.name] = value;
  }
  return out;
}

/// A blank tool for the library dialog's New. Workspace-scoped by
/// default: the narrower scope is the safer one to start from.
export function emptyTool(id: string): Tool {
  return {
    id,
    name: "",
    description: "",
    kind: "command",
    body: "",
    params: [],
    scope: "workspace",
  };
}

/// A built-in copied into an editable tool. The name is suffixed so the
/// duplicate is distinguishable in a list beside its original.
export function duplicateTool(tool: Tool, id: string): Tool {
  return {
    ...tool,
    id,
    name: `${tool.name} (copy)`,
    params: tool.params.map((p) => ({ ...p })),
    scope: "workspace",
  };
}

/// Wire shape for a save. Built-ins can never be saved, so this refuses
/// them rather than letting the daemon's error be the only guard.
export function toRecord(tool: Tool, workspaceId: string, position: number): ToolRecord {
  if (tool.scope === "builtin") throw new Error("a built-in tool cannot be saved");
  return {
    id: tool.id,
    workspaceId: tool.scope === "global" ? null : workspaceId,
    name: tool.name.trim(),
    description: tool.description.trim(),
    kind: tool.kind,
    body: tool.body,
    params: tool.params,
    position,
  };
}

/// What is wrong with a tool the human is editing, or null. Checked in
/// the dialog so the message names the field rather than arriving as a
/// daemon error after the save.
export function validateTool(tool: Tool): string | null {
  if (!tool.name.trim()) return "A tool needs a name.";
  if (!tool.body.trim()) return "A tool needs a body.";
  const seen = new Set<string>();
  for (const param of tool.params) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(param.name)) {
      return `“${param.name}” is not a usable parameter name — letters, digits and underscores, not starting with a digit.`;
    }
    if (seen.has(param.name)) return `Two parameters are both called “${param.name}”.`;
    seen.add(param.name);
  }
  return null;
}
