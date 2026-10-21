// The Demo Workstation's two activity reads, asked over the channel the
// way the calendar asks them.
import { describe, expect, it } from "vitest";
import { buildEvents, indexEvents, loadWindow, type ActivityRun, type GitActivity } from "$lib/activity/activity";
import { createChannelClient } from "$companion/channel/client";
import { loopback } from "$companion/channel/port";
import { DEMO } from "$companion/demo/sampleData";
import { createDemoWorkstation } from "$companion/demo/workstation";

function bench() {
  return createChannelClient(loopback(createDemoWorkstation()));
}

const { since, until } = loadWindow(Date.now());

describe("the Demo's activity", () => {
  it("draws a year of runs over the workspace's own cards and tools, inside the window asked", async () => {
    const client = bench();
    const runs = (await client.invoke("activity_runs", { workspaceId: DEMO.atlas, since, until })) as ActivityRun[];
    expect(runs.length).toBeGreaterThan(200);
    expect(runs.every((r) => r.workspaceId === DEMO.atlas && r.startedAt >= since && r.startedAt < until)).toBe(true);
    expect(runs.some((r) => r.kind === "tool" && r.toolId)).toBe(true);
    expect(runs.filter((r) => r.kind === "card").every((r) => r.path?.startsWith(DEMO.atlasRoot))).toBe(true);
    for (let i = 1; i < runs.length; i++) expect(runs[i].startedAt).toBeGreaterThanOrEqual(runs[i - 1].startedAt);
  });

  it("reads the same day the same way on every visit", async () => {
    const a = await bench().invoke("activity_runs", { workspaceId: DEMO.notes, since, until });
    const b = await bench().invoke("activity_runs", { workspaceId: DEMO.notes, since, until });
    expect(a).toEqual(b);
  });

  it("has no runs for a workspace with no cards, and no history for a folder that is no repository", async () => {
    const client = bench();
    await expect(client.invoke("activity_runs", { workspaceId: DEMO.scratch, since, until })).resolves.toEqual([]);
    await expect(client.invoke("git_activity", { cwd: DEMO.home, since })).resolves.toEqual({ commits: [], pushes: [] });
  });

  it("draws commits on the repository's own files and pushes that each start where the last ended", async () => {
    const git = (await bench().invoke("git_activity", { cwd: DEMO.atlasRoot, since })) as GitActivity;
    expect(git.commits.length).toBeGreaterThan(200);
    expect(git.commits.every((c) => c.at >= since && c.files.length > 0)).toBe(true);
    expect(git.pushes.length).toBeGreaterThan(50);
    expect(git.pushes.at(-1)?.oldSha).toBeNull();
    for (let i = 0; i < git.pushes.length - 1; i++) expect(git.pushes[i].oldSha).toBe(git.pushes[i + 1].newSha);
    const busy = indexEvents(buildEvents([{ workspaceId: DEMO.atlas, workspaceName: "atlas-api", runs: [], git }]));
    expect(busy.days.size).toBeGreaterThan(150);
  });
});
