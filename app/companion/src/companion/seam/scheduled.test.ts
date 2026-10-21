// A workspace's Scheduled tasks from the phone (ADR 0010), read at the
// wire against the Demo Workstation: what the surface lists, what its
// controls ask the Workstation for -- and that nothing a phone does ever
// fires a task. The desk's scheduler fires; a phone's Run now is a
// question for the desk (ADR 0003).
import { afterEach, describe, expect, it } from "vitest";
import { get } from "svelte/store";
import { setPaused, unschedule } from "$lib/scheduling/scheduledActions";
import { scheduledTasks, startScheduledScheduler, tickScheduled } from "$lib/scheduling/scheduledState";
import type { BundleMessage } from "$companion/channel/messages";
import { loopback } from "$companion/channel/port";
import { DEMO } from "$companion/demo/sampleData";
import { createDemoWorkstation, type DemoWorkstation } from "$companion/demo/workstation";
import { disconnectChannel } from "$companion/remote/connection";
import { loadScheduled, runNowFromPhone } from "$companion/state/scheduled";
import { connectWorkstation, openWorkspace, showSurface } from "$companion/state/workstation";
import { codeOf, companionSources } from "$companion/testing/companionSources";
import { settle } from "$companion/testing/demoBench";
import { deviceStorage, resetDesktopStores } from "$companion/testing/desktopStores";
import { allowedToRemoteRole } from "$companion/testing/remoteTable";

/// What firing a task sends. A phone sends none of it, ever.
const FIRING = ["claim_scheduled_fire", "record_scheduled_launch", "create_session"];

let disconnect: (() => void) | null = null;

afterEach(() => {
  disconnect?.();
  disconnect = null;
  disconnectChannel();
  resetDesktopStores();
  scheduledTasks.set({});
});

async function visit(): Promise<DemoWorkstation> {
  const demo = createDemoWorkstation();
  disconnect = await connectWorkstation(loopback(demo), deviceStorage());
  await settle();
  openWorkspace(DEMO.atlas);
  showSurface("scheduled");
  await loadScheduled(DEMO.atlas);
  await settle();
  return demo;
}

function sent(demo: DemoWorkstation): string[] {
  return demo.received().flatMap((m: BundleMessage) => (m.type === "invoke" ? [m.cmd] : []));
}

function task(title: string) {
  const found = (get(scheduledTasks)[DEMO.atlas] ?? []).find((t) => t.title === title);
  if (!found) throw new Error(`no Scheduled task "${title}"`);
  return found;
}

describe("the Scheduled surface", () => {
  it("lists the desk's tasks, read through the desk's own loader", async () => {
    const demo = await visit();
    expect(sent(demo)).toContain("list_scheduled_tasks");
    expect((get(scheduledTasks)[DEMO.atlas] ?? []).map((t) => t.title)).toEqual([
      "Nightly dependency audit",
      "Weekly flaky test sweep",
    ]);
    expect(demo.unanswered()).toEqual([]);
  });

  it("pauses, resumes and unschedules on the desk", async () => {
    const demo = await visit();
    expect(await setPaused(DEMO.atlas, task("Nightly dependency audit"), true)).toBeNull();
    await settle();
    expect(task("Nightly dependency audit").paused).toBe(true);
    expect(await unschedule(DEMO.atlas, task("Weekly flaky test sweep"))).toBeNull();
    await settle();
    expect(task("Weekly flaky test sweep").rule).toBeNull();
    expect(sent(demo).filter((cmd) => cmd === "set_scheduled_task_field")).toHaveLength(2);
  });

  it("asks the desk for Run now, and fires nothing itself", async () => {
    const demo = await visit();
    expect(await runNowFromPhone(DEMO.atlas, task("Nightly dependency audit"))).toBeNull();
    await settle();
    expect(sent(demo)).toContain("scheduled_run_now_for_device");
    expect(task("Nightly dependency audit").fires[0].headline).toBe("Ran on the Demo Workstation");
    expect(sent(demo).filter((cmd) => FIRING.includes(cmd))).toEqual([]);
  });
});

describe("the phone never fires a task (ADR 0003)", () => {
  it("even when a slot is due and a pass is asked for by name", async () => {
    const demo = await visit();
    // Long past every slot of the nightly audit.
    await tickScheduled(DEMO.atlas, new Date(2030, 0, 1));
    const stop = startScheduledScheduler();
    await settle();
    stop();
    expect(sent(demo).filter((cmd) => FIRING.includes(cmd))).toEqual([]);
  });

  it("is refused the claim and the launch record at the Workstation", () => {
    expect(allowedToRemoteRole("claim_scheduled_fire")).toBe(false);
    expect(allowedToRemoteRole("record_scheduled_launch")).toBe(false);
    expect(allowedToRemoteRole("scheduled_run_now_for_device")).toBe(true);
  });

  it("never starts the scheduler from its own code", () => {
    const opened = Object.entries(companionSources()).filter(([name, text]) =>
      !name.endsWith(".test.ts") && /\bstartScheduledScheduler\b|\binitRunNowRequests\b/.test(codeOf(text))
    );
    expect(opened.map(([name]) => name)).toEqual([]);
  });
});
