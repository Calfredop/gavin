import { describe, it, expect } from "vitest";
import {
  DEFAULT_AGENT_SHARE,
  DIVIDER_PX,
  MIN_HOME_PANE_PX,
  agentShareFromWidth,
  homeGridColumns,
  resolveAgentShare,
} from "$lib/hub/homeSplit";

describe("agentShareFromWidth", () => {
  it("turns a dragged width into the agent cell's share of the row", () => {
    expect(agentShareFromWidth(300, 1200)).toBe(0.25);
    expect(agentShareFromWidth(720, 1200)).toBe(DEFAULT_AGENT_SHARE);
  });

  it("keeps the summaries column from being swallowed", () => {
    // (1200 - 240) / 1200: the right-hand column keeps its minimum.
    expect(agentShareFromWidth(1200, 1200)).toBe(0.8);
    expect(agentShareFromWidth(4000, 1200)).toBe(0.8);
  });

  it("keeps the agent cell visible", () => {
    expect(agentShareFromWidth(0, 1200)).toBe(0.2);
    expect(agentShareFromWidth(-500, 1200)).toBe(0.2);
  });

  // A narrow pane cannot honour both minimums; the shipped split beats
  // pinning one cell open and clipping the other away entirely.
  it("falls back to the default when there is no room for two minimums", () => {
    expect(agentShareFromWidth(100, 400)).toBe(DEFAULT_AGENT_SHARE);
    expect(agentShareFromWidth(300, MIN_HOME_PANE_PX * 2)).toBe(DEFAULT_AGENT_SHARE);
  });

  // offsetWidth is 0 while the hub tab is hidden or still laying out.
  it("falls back when the row has no width to divide", () => {
    expect(agentShareFromWidth(400, 0)).toBe(DEFAULT_AGENT_SHARE);
    expect(agentShareFromWidth(400, -10)).toBe(DEFAULT_AGENT_SHARE);
  });
});

describe("resolveAgentShare", () => {
  it("uses the shipped split when nothing has been dragged", () => {
    expect(resolveAgentShare(undefined)).toBe(DEFAULT_AGENT_SHARE);
    expect(resolveAgentShare(null)).toBe(DEFAULT_AGENT_SHARE);
  });

  it("keeps a dragged share", () => {
    expect(resolveAgentShare(0.32)).toBe(0.32);
  });

  // config.json is hand-editable, and a share outside the band would put
  // one cell -- and the divider itself -- off the pane.
  it("ignores a share that would leave nothing to drag back", () => {
    expect(resolveAgentShare(0)).toBe(DEFAULT_AGENT_SHARE);
    expect(resolveAgentShare(1)).toBe(DEFAULT_AGENT_SHARE);
    expect(resolveAgentShare(5)).toBe(DEFAULT_AGENT_SHARE);
    expect(resolveAgentShare(-2)).toBe(DEFAULT_AGENT_SHARE);
    expect(resolveAgentShare(Number.NaN)).toBe(DEFAULT_AGENT_SHARE);
    expect(resolveAgentShare("0.5" as unknown as number)).toBe(DEFAULT_AGENT_SHARE);
  });
});

describe("homeGridColumns", () => {
  it("spends the row on the two cells and the divider between them", () => {
    expect(homeGridColumns(DEFAULT_AGENT_SHARE)).toBe(`0.6fr ${DIVIDER_PX}px 0.4fr`);
  });

  // Without the rounding this reads `0.30000000000000004fr`.
  it("never emits a float artefact as a track size", () => {
    expect(homeGridColumns(0.7)).toBe(`0.7fr ${DIVIDER_PX}px 0.3fr`);
    expect(homeGridColumns(0.3328)).toBe(`0.3328fr ${DIVIDER_PX}px 0.6672fr`);
  });
});
