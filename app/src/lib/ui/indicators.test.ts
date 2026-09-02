import { describe, it, expect } from "vitest";
import { render } from "svelte/server";
import {
  AXIS_LABEL,
  AGENT_STATES,
  PRIORITY_LEVELS,
  agentIndicator,
  agentIndicatorByState,
  agentExitedIndicator,
  allIndicators,
  gitIndicator,
  priorityIndicator,
  shellRestartedIndicator,
  unsavedEditsIndicator,
  type Indicator,
} from "./indicators";

/// The rendered lucide class of an indicator's glyph -- the only stable
/// identity an icon component has from the outside. Two indicators that
/// render the same class ARE the same shape on screen, whatever the two
/// import names happen to be.
function glyphClass(indicator: Indicator): string {
  const body = render(indicator.icon, { props: { size: 11 } }).body;
  const classes = [...body.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/));
  // Every lucide svg carries "lucide-icon lucide lucide-<name>"; only the
  // last of those says which glyph it is.
  const named = classes.filter((c) => c.startsWith("lucide-") && c !== "lucide-icon");
  expect(named.length, `${indicator.axis}/${indicator.state} rendered no lucide-<name> class`).toBeGreaterThan(0);
  return named[named.length - 1];
}

describe("the indicator vocabulary", () => {
  it("names its axis in every tooltip", () => {
    for (const indicator of allIndicators()) {
      expect(
        indicator.tip.startsWith(`${AXIS_LABEL[indicator.axis]} · `),
        `${indicator.axis}/${indicator.state} tooltip "${indicator.tip}" does not lead with its axis`
      ).toBe(true);
      // The screen-reader label is the same sentence: a badge that reads
      // one way to the eye and another to a reader is two vocabularies.
      expect(indicator.label).toBe(indicator.tip);
    }
  });

  // The bug this module exists to kill: an amber dot meant priority on
  // the board, unsaved edits on a file tab and a dirty checkout on a
  // terminal tab. Shape now carries the axis, so no shape may be shared.
  it("gives every axis a glyph of its own", () => {
    const owner = new Map<string, string>();
    for (const indicator of allIndicators()) {
      const glyph = glyphClass(indicator);
      const previous = owner.get(glyph);
      if (previous !== undefined) {
        expect(
          previous,
          `${glyph} is drawn by both the ${previous} and ${indicator.axis} axes -- the glyph no longer says which question the badge answers`
        ).toBe(indicator.axis);
      }
      owner.set(glyph, indicator.axis);
    }
    expect(owner.size).toBeGreaterThan(1);
  });

  // Within an axis a shared glyph is fine (git dirty and git clean are
  // both a branch) as long as the tone separates them. What is never
  // fine is two states a reader cannot tell apart at all -- which is
  // exactly what medium and high priority used to be.
  it("makes every state within an axis distinguishable", () => {
    const seen = new Set<string>();
    for (const indicator of allIndicators()) {
      const key = `${indicator.axis}/${glyphClass(indicator)}/${indicator.tone}`;
      expect(seen.has(key), `two ${indicator.axis} states render identically (${key})`).toBe(false);
      seen.add(key);
    }
  });

  // Motion is a claim about right now. Anything else that span would be
  // decoration, and a tab bar of spinning badges says nothing at all.
  it("spins only what is actually in motion", () => {
    for (const indicator of allIndicators()) {
      expect(
        Boolean(indicator.spin),
        `${indicator.axis}/${indicator.state} spins but does not mean "happening right now"`
      ).toBe(indicator.axis === "agent" && indicator.state === "working");
    }
  });

  // Colour's whole job is now this table. A state that means "wants a
  // human" and renders accent, or a running one that renders danger,
  // would put the app back where it started.
  it("spends each tone on one meaning", () => {
    expect(agentIndicatorByState("working").tone).toBe("accent");
    expect(agentIndicatorByState("waiting_for_input").tone).toBe("warning");
    expect(agentIndicatorByState("idle").tone).toBe("neutral");
    expect(agentIndicatorByState("exited").tone).toBe("neutral");
    expect(gitIndicator(true).tone).toBe("warning");
    // Not an amber ring: "nothing to report" must not be drawn in the
    // colour the app uses for "come and look at this".
    expect(gitIndicator(false).tone).toBe("neutral");
    expect(unsavedEditsIndicator().tone).toBe("accent");
    expect(shellRestartedIndicator().tone).toBe("success");
  });
});

describe("agentIndicator", () => {
  it("maps each daemon status to its own badge", () => {
    for (const status of ["working", "waiting_for_input", "idle"] as const) {
      expect(agentIndicator(status).state).toBe(status);
      expect(agentIndicator(status).axis).toBe("agent");
    }
  });

  // A session the daemon has not spoken about yet is not a fifth state:
  // it looks exactly like the idle one, which is what the callers drew
  // before this module existed.
  it("reads an unknown status as idle", () => {
    expect(agentIndicator(undefined)).toBe(agentIndicator("idle"));
  });

  // A card outlives the session it was bound to, so "exited" has to be
  // sayable even though the daemon never reports it as a status.
  it("keeps exited outside the daemon's status set", () => {
    expect(agentExitedIndicator().state).toBe("exited");
    expect(AGENT_STATES).toContain("exited");
  });
});

describe("priorityIndicator", () => {
  it("draws the four levels as a ramp", () => {
    const glyphs = PRIORITY_LEVELS.map((level) => {
      const indicator = priorityIndicator(level);
      expect(indicator, `${level} has no badge`).not.toBeNull();
      return glyphClass(indicator as Indicator);
    });
    expect(new Set(glyphs).size, `the priority ramp reuses a glyph: ${glyphs.join(", ")}`).toBe(
      PRIORITY_LEVELS.length
    );
  });

  // The specific regression: medium and high were both --warning, so a
  // board could not show the difference between them at all.
  it("separates medium from high", () => {
    const medium = priorityIndicator("medium") as Indicator;
    const high = priorityIndicator("high") as Indicator;
    expect(glyphClass(medium)).not.toBe(glyphClass(high));
    expect(medium.tone).not.toBe(high.tone);
  });

  // Quiet at the bottom, loud at the top -- and never quiet by being
  // painted in a surface token, which is how "low" used to disappear.
  it("spends colour only at the top of the ramp", () => {
    expect((priorityIndicator("low") as Indicator).tone).toBe("neutral");
    expect((priorityIndicator("medium") as Indicator).tone).toBe("neutral");
    expect((priorityIndicator("high") as Indicator).tone).toBe("warning");
    expect((priorityIndicator("urgent") as Indicator).tone).toBe("danger");
  });

  it("draws nothing when no priority is set", () => {
    for (const empty of ["none", "", null, undefined, "  ", "High", "critical"]) {
      expect(priorityIndicator(empty), `"${empty}" produced a badge`).toBeNull();
    }
  });
});
