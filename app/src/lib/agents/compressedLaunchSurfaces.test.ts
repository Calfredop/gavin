import { describe, it, expect } from "vitest";
import { allSources, source } from "$lib/sources";
import { FEATURE_MIN_VERSION } from "$lib/core/daemonCompat";

// The static pre-flight for compressed launches.
//
// Whether a session is compressed is the daemon's decision, made as it
// spawns the process, and it is decided from one thing the app says: the
// profile doing the launching (`CreateSession`'s `profileId`). Everything
// the app DECIDES about that is pure and covered where it lives
// (compression.test.ts, compressionDriver.test.ts, and
// `profileIdForLaunch` in layoutState.test.ts). What no suite can see is
// the WIRING, and here the wiring is the whole feature:
//
// - A surface that launches an agent and names no profile launches it
//   uncompressed, in a workspace whose switch is on, and nothing anywhere
//   says why. It type-checks, it runs, and the agent works.
// - A surface that names one without asking `profileIdForLaunch` sends a
//   widened request to a daemon that parses it and drops the field --
//   the payload `min_version_for` is structurally blind to.
// - A shell that names one hands the human's own terminal the routing
//   variables, and their project's test suite starts talking to its
//   model through Headroom.
//
// So this does not name the surfaces and check them. It finds every call
// that creates a session, in every source file, and makes each one
// answer for itself: it carries a profile, or it is a shell and says
// why. A surface added next year fails here until somebody decides which
// it is.

/// Everything that ends in the daemon's `CreateSession`.
const CREATORS = [
  "backend.createSession",
  "createDaemonSession",
  "createSessionOnRailPage",
  "createSessionOnPage",
  "createSessionForCard",
  "createSessionOnNewPage",
  "createTiledPage",
];

interface Call {
  file: string;
  /// The call's own text, arguments and all, on one line.
  text: string;
}

/// The source with its comments blanked: a call quoted in prose is not
/// a call. Line comments only, which is every comment these files have.
function withoutComments(text: string): string {
  return text
    .split("\n")
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? "" : line))
    .join("\n");
}

/// A call as it would read written on one line, however it is wrapped.
function onOneLine(call: string): string {
  return call
    .replace(/\s+/g, " ")
    .replace(/\( /g, "(")
    .replace(/,? \)/g, ")");
}

/// Every call to a creator in one file. Definitions and imports are not
/// calls: a definition is preceded by `function`, and an import names no
/// arguments.
function callsIn(file: string, raw: string): Call[] {
  const text = withoutComments(raw);
  const calls: Call[] = [];
  for (const creator of CREATORS) {
    const pattern = new RegExp(`(?<![\\w.])${creator.replace(".", "\\.")}\\(`, "g");
    for (const match of text.matchAll(pattern)) {
      const before = text.slice(Math.max(0, match.index - 12), match.index);
      if (/function\s+$/.test(before)) continue;
      let depth = 1;
      let end = match.index + match[0].length;
      while (depth > 0 && end < text.length) {
        if (text[end] === "(") depth += 1;
        else if (text[end] === ")") depth -= 1;
        end += 1;
      }
      calls.push({ file, text: onOneLine(text.slice(match.index, end)) });
    }
  }
  return calls;
}

const CALLS: Call[] = Object.entries(allSources()).flatMap(([file, text]) => callsIn(file, text));

/// A launch that names no profile, and why that is right. `[file, the
/// call as written, what it launches]`.
const SHELLS: [string, string, string][] = [
  [
    "layoutState.ts",
    "backend.createSession(freshSessionCwd(workspaceId), undefined, workspaceRootPath(workspaceId) ?? undefined)",
    "a new tab or a split: the human's own shell",
  ],
  [
    "layoutState.ts",
    "backend.createSession(sessionCwd, undefined, workspaceRoot)",
    "a new page, with the agent box unticked",
  ],
  [
    "layoutState.ts",
    "backend.createSession(cwd, command, workspaceRoot)",
    "createDaemonSession's own no-profile form: an argument not made",
  ],
  [
    "layoutState.ts",
    "createSessionForCard(workspaceId, cwd, command)",
    "createSessionOnPage's fallback, in its no-profile form",
  ],
  [
    "orchestrationState.ts",
    "createSessionOnPage(workspaceId, pageId, cwd, command)",
    "the rail page seam's no-profile form",
  ],
  [
    "orchestrationState.ts",
    "createSessionOnRailPage(workspaceId, railId, cwd, command)",
    "a new worktree's setup, which is a script and no agent",
  ],
  [
    "gitState.ts",
    "createSessionForCard(workspaceId, s.cwd, `git mergetool --no-prompt -- ${quoted}`)",
    "git mergetool",
  ],
];

function isShell(call: Call): boolean {
  return SHELLS.some(([file, text]) => file === call.file && text === call.text);
}

describe("every session that is created answers for its profile", () => {
  it("finds the calls at all", () => {
    // A sweep that matched nothing would pass everything below.
    expect(CALLS.length).toBeGreaterThan(20);
    for (const file of ["cardRunActions.ts", "orchestrationState.ts", "GitWorktreeSwitcher.svelte"]) {
      expect(CALLS.some((call) => call.file === file), file).toBe(true);
    }
  });

  it("names a profile, or is a shell that says why", () => {
    const unanswered = CALLS.filter((call) => !isShell(call) && !/profileId/.test(call.text)).map(
      (call) => `${call.file}: ${call.text}`
    );

    expect(unanswered).toEqual([]);
  });

  it("lists no shell that is not there", () => {
    const stale = SHELLS.filter(
      ([file, text]) => !CALLS.some((call) => call.file === file && call.text === text)
    ).map(([file, text]) => `${file}: ${text}`);

    expect(stale).toEqual([]);
  });

  it("gives every shell its reason", () => {
    expect(SHELLS.filter(([, , why]) => !why.trim())).toEqual([]);
  });
});

describe("every surface that launches an agent asks the gate", () => {
  // The widened payload's consumers, by name: each of these starts an
  // agent, and each gets the profile it sends from the one function that
  // knows whether the daemon can read it.
  const SURFACES: [string, string][] = [
    ["cardRunActions.ts", "a card's run, develop, resume, review and re-launch"],
    ["orchestrationState.ts", "a rail's card steps, agent tool steps and resumes, and Organize"],
    ["bestOfNActions.ts", "every candidate of a best-of-N run"],
    ["workspaceToolsActions.ts", "an agent tool run from the Tools tab"],
    ["codeReviewActions.ts", "Review with agent"],
    ["criticalReviewActions.ts", "every reviewer of a critical review"],
    ["gitState.ts", "the hidden commit run"],
    ["layoutState.ts", "the main agent, and a new page opened on the agent"],
    ["GitWorktreeSwitcher.svelte", "an agent opened in a worktree"],
  ];

  for (const [file, what] of SURFACES) {
    it(`asks profileIdForLaunch for ${what}`, () => {
      expect(source(file)).toContain("profileIdForLaunch(");
    });
  }

  it("and nothing launches an agent with a profile it made up", () => {
    // A profile reaches a creator from `profileIdForLaunch`, or from a
    // parameter that was handed one. A literal id, or an agent's own
    // `.profileId` passed straight through, skips the version gate.
    const skipping = CALLS.filter(
      (call) =>
        /["'`](claude-code|codex|gemini|cursor|opencode|kimi-code|custom)["'`]/.test(call.text) ||
        /\b\w+\.profileId\s*[,)]/.test(call.text.replace(/spec\.profileId/g, ""))
    ).map((call) => `${call.file}: ${call.text}`);

    expect(skipping).toEqual([]);
  });

  it("names the agent that is actually launching when the fallback chain walked", () => {
    const rail = source("orchestrationState.ts");
    expect(rail).toContain("profileIdForLaunch(launchAgent)");
    // The card launches resolve the fallback into `agent` itself.
    const cards = source("cardRunActions.ts");
    expect(cards).toContain("return { decision, agent: agentForProfile(workspaceId, decision.profileId) };");
  });

  it("names none for a tool that is not an agent's", () => {
    for (const file of ["workspaceToolsActions.ts", "orchestrationState.ts"]) {
      expect(source(file), file).toContain(
        'const profileId = tool.kind === "agent" ? profileIdForLaunch(agent) : undefined;'
      );
    }
  });

  it("names none for a worktree's setup run with no agent after it", () => {
    expect(source("GitForkDialog.svelte")).toContain(
      "if (run) onRunInWorktree(path, run.line, run.agentAfter);"
    );
    expect(source("GitWorktreeSwitcher.svelte")).toContain(
      "launchesAgent ? profileIdForLaunch(agent) : undefined"
    );
  });
});

describe("the gate", () => {
  it("is the version that widened CreateSession", () => {
    expect(FEATURE_MIN_VERSION.compressedLaunch).toBe(47);
    expect(source("daemonCompat.ts")).toContain("compressedLaunch: 47");
  });

  it("is read where the profile is named, and where the daemon is told", () => {
    expect(source("layoutState.ts")).toContain(
      'if (featureBlockedReason(get(daemonCompat), "compressedLaunch")) return undefined;'
    );
    expect(source("compressionDriver.ts")).toContain(
      'return featureBlockedReason(compat, "compressedLaunch");'
    );
  });

  // The host is the last thing between the app and the wire, and it
  // withholds the field itself: a surface that forgot to ask is still
  // not a widened request on an older daemon's socket.
  it("is backed by the host, which withholds the field from an older daemon", () => {
    const RUST = import.meta.glob("../../../src-tauri/src/session.rs", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    const session = Object.values(RUST)[0];
    expect(session).toContain("if daemon_version < protocol::COMPRESSED_LAUNCH_MIN_VERSION {");
    expect(session).toContain("let daemon_version = lanes.compat().daemon_version;");
    expect(session).toContain("let profile_id = profile_for_daemon(daemon_version, profile_id);");
  });

  // v48's custom API family rides the same request, and the host is
  // the one that sends it: from the custom agent's settings, with the
  // custom profile only, and never to a daemon that would drop it.
  it("is joined by the custom API family, which the host attaches and withholds itself", () => {
    const RUST = import.meta.glob("../../../src-tauri/src/session.rs", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    const session = Object.values(RUST)[0];
    expect(FEATURE_MIN_VERSION.customApiFamily).toBe(48);
    expect(session).toContain("if daemon_version < protocol::CUSTOM_API_FAMILY_MIN_VERSION {");
    // Named customs made the guard "any non-stock profile", not the one
    // retired `custom` id.
    expect(session).toContain("if crate::config::is_stock_profile_id(id) {");
    expect(session).toContain(
      "let api_family = api_family_for_daemon(daemon_version, profile_id, api_family);"
    );
    // Resolved from the named custom profiles the settings hold.
    expect(session).toContain(
      "crate::config::api_family_for_profile(&defaults, &[], profile_id.as_deref())"
    );
    // Both routes a launch takes, the local daemon and an ssh host's.
    expect(session.match(/profile_id\.as_deref\(\),\n\s+api_family\.as_deref\(\),/g)).toHaveLength(2);
    // Its one consumer in the app: the picker that sets it.
    expect(source("GlobalSettingsView.svelte")).toContain(
      'const apiFamilyBlocked = $derived(featureBlockedReason($daemonCompat, "customApiFamily"));'
    );
    expect(source("GlobalSettingsView.svelte")).toContain("disabled={Boolean(apiFamilyBlocked)}");
  });

  // A launch is never refused over it. Every other widened payload
  // greys a control out; this one launches the agent as it always did.
  it("never stands between a launch and its session", () => {
    const gate = source("layoutState.ts");
    const at = gate.indexOf("export function profileIdForLaunch(");
    const body = gate.slice(at, gate.indexOf("\n}\n", at));
    expect(body).not.toContain("setError");
    expect(body).not.toContain("throw");
  });
});

describe("the switch", () => {
  it("is written as a setting, never through the layout save", () => {
    const state = source("layoutState.ts");
    expect(state).toContain("await saveWorkspaceSettings(workspaceId, { headroom: enabled });");
    expect(source("workspaceSettings.ts")).toContain('"headroom",');
  });

  it("is told to the daemon by the window holding the app's duties, and no other", () => {
    const state = source("layoutState.ts");
    expect(state).toContain("unlisteners.push(await initCompression());");
    expect(state).toContain("unlisteners.push(whileHoldingAppDuties(startCompressionSwitch));");
  });

  it("is resolved by the one function, wherever it is resolved", () => {
    // A second resolution is a second opinion: a Settings row that said
    // "on" over a daemon that had been told "off".
    const resolvers = Object.entries(allSources())
      .filter(([, text]) => /\.headroom\b/.test(withoutComments(text)))
      .map(([file]) => file)
      .sort();

    expect(resolvers).toEqual(["compression.ts"]);
  });
});
