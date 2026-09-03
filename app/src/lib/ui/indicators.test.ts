import { describe, it, expect } from "vitest";
import { render } from "svelte/server";
import {
  AXIS_LABEL,
  AGENT_STATES,
  PRIORITY_LEVELS,
  RAIL_STATES,
  STEP_STATES,
  agentIndicator,
  agentIndicatorByState,
  agentExitedIndicator,
  agentFailedIndicator,
  allIndicators,
  attentionIndicator,
  gitIndicator,
  priorityIndicator,
  railIndicator,
  stepIndicator,
  shellOrphanIndicator,
  shellRestartedIndicator,
  unsavedEditsIndicator,
  worktreeStaleIndicator,
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
    // Broken is the one agent state allowed the danger tone; a run the
    // daemon's restart cut short is unfinished work, so it asks in amber.
    expect(agentIndicatorByState("failed").tone).toBe("danger");
    expect(agentIndicatorByState("interrupted").tone).toBe("warning");
    expect(agentIndicator("unknown").tone).toBe("neutral");
    expect(shellRestartedIndicator(true).tone).toBe("warning");
    expect(shellOrphanIndicator().tone).toBe("danger");
    expect(gitIndicator(true).tone).toBe("warning");
    // Not an amber ring: "nothing to report" must not be drawn in the
    // colour the app uses for "come and look at this".
    expect(gitIndicator(false).tone).toBe("neutral");
    // Finished, clean -- the same word "success" carries everywhere. A
    // worktree nothing needs any more is over, not in trouble.
    expect(worktreeStaleIndicator().tone).toBe("success");
    expect(unsavedEditsIndicator().tone).toBe("accent");
    expect(shellRestartedIndicator().tone).toBe("success");
    // A rail and a step both borrow the app's one meaning of accent:
    // this is the thing happening now.
    expect(stepIndicator("running").tone).toBe("accent");
    expect(railIndicator("running").tone).toBe("accent");
    expect(stepIndicator("done").tone).toBe("success");
    expect(stepIndicator("stalled").tone).toBe("danger");
    expect(stepIndicator("pending").tone).toBe("neutral");
    expect(railIndicator("idle").tone).toBe("neutral");
    expect(railIndicator("paused").tone).toBe("warning");
  });
});

describe("stepIndicator", () => {
  // The defect the survey turned up. A chip drew `running` as an accent
  // ring and nothing else and `pending` as nothing at all, so half the
  // state machine was invisible and the visible half was a colour --
  // the same fault the board's amber dot had, one screen over.
  it("gives every state a glyph, including the two that used to draw none", () => {
    const glyphs = STEP_STATES.map((state) => glyphClass(stepIndicator(state)));
    expect(new Set(glyphs).size, `the step states share a glyph: ${glyphs.join(", ")}`).toBe(
      STEP_STATES.length
    );
  });

  // Motion belongs to the agent axis. A step is `running` for the whole
  // time its agent sits waiting on a human, so a spinner here would
  // claim movement precisely when there is none.
  it("does not spin while its agent might be standing still", () => {
    expect(stepIndicator("running").spin).toBeFalsy();
  });

  it("keeps the step axis clear of the agent's", () => {
    for (const state of STEP_STATES) expect(stepIndicator(state).axis).toBe("step");
  });
});

describe("railIndicator", () => {
  it("gives each rail state its own glyph", () => {
    const glyphs = RAIL_STATES.map((state) => glyphClass(railIndicator(state)));
    expect(new Set(glyphs).size, `the rail states share a glyph: ${glyphs.join(", ")}`).toBe(
      RAIL_STATES.length
    );
  });

  // A paused rail was stopped by the human; an agent whose turn ended
  // stopped by itself. Both wear a pause, and the enclosure is the only
  // thing telling them apart -- so it had better actually differ.
  it("draws its pause differently from the agent's", () => {
    expect(glyphClass(railIndicator("paused"))).not.toBe(
      glyphClass(attentionIndicator("turn-ended"))
    );
  });
});

describe("attentionIndicator", () => {
  // The identity that matters: an agent stuck on a question is ONE fact,
  // and a rail chip must not invent a second badge for what the board
  // card, the terminal tab and the sidebar row already draw.
  it("draws asking as the very badge every other surface uses", () => {
    expect(attentionIndicator("asking")).toBe(agentIndicator("waiting_for_input"));
  });

  // Both mean "come and look", so both are amber -- what separates them
  // is the glyph, which is the whole rule this module encodes.
  it("keeps both answers on the agent axis, in the wants-a-human tone", () => {
    for (const attention of ["asking", "turn-ended"] as const) {
      expect(attentionIndicator(attention).axis).toBe("agent");
      expect(attentionIndicator(attention).tone).toBe("warning");
    }
    expect(glyphClass(attentionIndicator("asking"))).not.toBe(
      glyphClass(attentionIndicator("turn-ended"))
    );
  });
});

describe("agentIndicator", () => {
  it("maps each daemon status to its own badge", () => {
    for (const status of ["working", "waiting_for_input", "failed", "unknown", "idle"] as const) {
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

  // A broken agent used to be indistinguishable from an idle one. The
  // failed badge is its own glyph, and the agent's own line about what
  // broke rides in the bubble without changing which badge it is.
  it("keeps a failed agent's reason on the failed badge", () => {
    const bare = agentFailedIndicator(null);
    const why = agentFailedIndicator("API Error: 529");
    expect(bare).toBe(agentIndicator("failed"));
    expect(why.state).toBe("failed");
    expect(why.icon).toBe(bare.icon);
    expect(why.tone).toBe("danger");
    expect(why.tip).toBe("Agent · stopped — API Error: 529");
    expect(why.label).toBe(why.tip);
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
