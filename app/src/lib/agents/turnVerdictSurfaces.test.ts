import { describe, it, expect } from "vitest";
import { svelteSources, tsSources } from "$lib/sources";

// The static pre-flight the card asks for: the strings a change relies
// on, grepped against the committed source. The rendered pass is the
// owner's, in the running app.
const SVELTE = svelteSources();
const TS = tsSources();

function source(name: string): string {
  const text = SVELTE[name] ?? TS[name];
  if (!text) throw new Error(`no source for ${name}`);
  return text;
}

describe("the daemon gate", () => {
  it("is entered in FEATURE_MIN_VERSION with a consumer that skips the request", () => {
    // CLAUDE.md's rule: an entry alone is a dead gate. The consumer here
    // is the driver refusing to ask, and the Settings switch saying why.
    expect(source("daemonCompat.ts")).toContain("turnVerdict: 39");
    expect(source("turnVerdictDriver.ts")).toContain(
      'featureBlockedReason(get(daemonCompat), "turnVerdict")'
    );
    const settings = source("GlobalSettingsView.svelte");
    expect(settings).toContain('featureBlockedReason($daemonCompat, "turnVerdict")');
    expect(settings).toContain("disabled={turnVerdictBlocked !== null}");
  });
});

describe("the settings copy", () => {
  it("says what leaves the machine, where it goes, and for which sessions", () => {
    const s = source("GlobalSettingsView.svelte");
    expect(s).toContain("What leaves this machine");
    expect(s).toContain("api.typesafe.ai");
    expect(s).toContain("last 40 rows");
    expect(s).toContain("For a session running a card or a rail step, and");
    expect(s).toContain("Nothing is sent for a");
    expect(s).toContain("terminal you opened yourself");
  });

  it("is off by default and says so", () => {
    const s = source("GlobalSettingsView.svelte");
    expect(s).toContain("checked={$typesafeSettings?.enabled ?? false}");
    expect(s).toContain("A second opinion and never a replacement");
  });

  it("takes the key as a password, tells whether one is set, and never shows it", () => {
    const s = source("GlobalSettingsView.svelte");
    expect(s).toContain('type="password"');
    expect(s).toContain("A key is set");
    // The only reads of the key state are the two booleans the host
    // answers with.
    expect(s).not.toMatch(/\$typesafeSettings\??\.(apiKey|api_key|key)\b/);
    expect(source("backend.ts")).toContain("typesafeSettings(): Promise<{ enabled: boolean; hasKey: boolean; changeAttribution: boolean }>");
    expect(source("backend.ts")).not.toMatch(/get_typesafe_api_key|typesafeApiKey\(\)/);
  });
});

describe("the wiring", () => {
  it("is started from the orchestration listeners and never imported statically by layoutState", () => {
    // The load-order rule turnVerdictState.ts's header is about.
    expect(source("orchestrationState.ts")).toContain(
      'await import("$lib/agents/turnVerdictDriver")'
    );
    expect(source("orchestrationState.ts")).toContain("stopTurnVerdict();");
    // Named in comments, never in an import.
    expect(source("layoutState.ts")).not.toMatch(/from "\$lib\/agents\/turnVerdict(State|Driver)"/);
    expect(source("turnVerdictState.ts")).not.toMatch(
      /from "\$lib\/(core\/layoutState|orchestration\/orchestrationState|board\/kanbanState)"/
    );
  });

  it("holds the tray line through a registered slot, not an import either", () => {
    // The same rule as above, for the half of this feature that speaks
    // to the human: the holder reads the verdict map, so layoutState
    // asks it through a slot it can never import (setStatusNoticeHold),
    // exactly as it reaches auto-resume and the rail's voice.
    expect(source("layoutState.ts")).not.toMatch(/from "\$lib\/agents\/verdictNotice/);
    expect(source("layoutState.ts")).toContain(
      "if (statusNoticeHold?.(sessionId, previousStatus, status)) return;"
    );
    expect(source("verdictNoticeState.ts")).toContain("setStatusNoticeHold(hold);");
    // Started and stopped with the driver, because a hold is meaningless
    // without something marking sessions pending.
    expect(source("turnVerdictDriver.ts")).toContain("startVerdictNotices()");
  });

  it("sends exactly one notification per quiet turn", () => {
    // The two paths are exclusive by construction: layoutState returns
    // before `notifyStatus` when the hold takes the transition, and the
    // holder is the only other caller of a status notification.
    const layout = source("layoutState.ts");
    const held = layout.indexOf("if (statusNoticeHold?.(sessionId, previousStatus, status)) return;");
    const inline = layout.indexOf("notifyStatus(state, sessionId, previousStatus, status);");
    expect(held).toBeGreaterThan(0);
    expect(inline).toBeGreaterThan(held);
    expect(layout).not.toContain("maybeNotifyTurnVerdict");
    // And the deferred one answers to the same workspace toggles the
    // inline one would have, rather than a second reading of them.
    expect(source("verdictNoticeState.ts")).toContain("notifyPrefsFor(state, sessionId)");
  });

  it("fires the status hook before the store update the scheduler reads on", () => {
    const s = source("layoutState.ts");
    const hook = s.indexOf("sessionStatusHook?.(sessionId, status, previousStatus);");
    const update = s.indexOf("sessionStatusById: { ...s.sessionStatusById, [sessionId]: status }");
    expect(hook).toBeGreaterThan(0);
    expect(update).toBeGreaterThan(hook);
  });

  it("every reader of a verdict subscribes to the store rather than reading it once", () => {
    // The verdict lands after the status change that provoked it, so a
    // one-time `get()` in a view would never see it.
    for (const name of ["FollowUpQueueView.svelte", "MainAgentPanel.svelte", "Pane.svelte"]) {
      expect(source(name), name).toContain("$turnVerdictById[");
    }
    expect(source("AppHubView.svelte")).toContain("verdicts: verdictsOf($turnVerdictById)");
    const orch = source("orchestrationState.ts");
    // Both a derived-store input and a scheduler tick input.
    expect(orch).toMatch(/nowStore,\s*turnVerdictById,\s*\]/);
    expect(orch).toMatch(/prReports,[\s\S]*?turnVerdictById,\s*\];/);
    expect(orch).toContain("verdictsOf(get(turnVerdictById))");
  });

  it("auto-resume waits for a pending verdict only where the table said unknown", () => {
    const s = source("autoResumeState.ts");
    expect(s).toContain("whenTurnVerdictSettles(sessionId)");
    expect(s).toContain("tableCannotName(owner, sessionId)");
    expect(s).toContain('verdictCause: refineCause("unknown", get(turnVerdictById)[sessionId])');
  });
});

describe("the pure module", () => {
  it("pins the measured model and keeps the questions verbatim", () => {
    const s = source("turnVerdict.ts");
    expect(s).toContain('TYPESAFE_MODEL = "jev-1.13.0"');
    // Mentioned as the thing NOT to pin; never the string that is sent.
    expect(s).not.toContain('"jev-latest"');
    expect(s).toContain("ACTIVE_NOUL_VETO = 0.7");
    expect(s).toContain("VERDICT_MIN_CONFIDENCE = 0.75");
    expect(s).toContain("CAUSE_MIN_CONFIDENCE = 0.9");
    expect(s).toContain("SCREEN_TAIL_ROWS = 40");
  });

  it("never sends the request itself", () => {
    expect(source("turnVerdict.ts")).not.toMatch(/\bfetch\(|invoke\(|from "\$lib\/core\/backend"/);
  });
});
