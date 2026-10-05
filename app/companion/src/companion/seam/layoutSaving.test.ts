// "What I do on the phone never rearranges my desktop's pages and tabs"
// (spec, story 35). The Companion keeps its own view state on the Device,
// so the commands that SAVE the desktop's layout have no business leaving
// it -- and these suites hold that at the wire, where it cannot depend on
// every surface remembering.
import { afterEach, describe, expect, it } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import * as backend from "$lib/core/backend";
// One file, read raw. `$lib/sources` would answer the same question by
// loading every source in the desktop's library first.
import backendSource from "$lib/core/backend.ts?raw";
import { createChannelClient } from "$companion/channel/client";
import { loopback } from "$companion/channel/port";
import { createDemoWorkstation } from "$companion/demo/workstation";
import { disconnectChannel } from "$companion/remote/connection";
import { LAYOUT_SAVING_COMMANDS, refusedOnDevice } from "$companion/remote/remoteRole";
import { connectDemo, settle } from "$companion/testing/demoBench";
import { allowedToRemoteRole, tableSize } from "$companion/testing/remoteTable";

afterEach(() => disconnectChannel());

describe("the layout-saving commands", () => {
  it("are the four the desktop saves its pages and tabs with", () => {
    expect([...LAYOUT_SAVING_COMMANDS].sort()).toEqual(
      ["set_board_tabs", "set_card_tabs", "set_file_tabs", "set_workspaces_state"].sort()
    );
  });

  // A refusal for a command the desktop no longer sends protects
  // nothing, and the one it sends instead would go straight through.
  it.each([...LAYOUT_SAVING_COMMANDS])("%s is still a command the desktop's backend sends", (cmd) => {
    expect(backendSource).toContain(`invoke("${cmd}"`);
  });

  it.each([...LAYOUT_SAVING_COMMANDS])("%s is refused before it reaches the channel", async (cmd) => {
    const demo = connectDemo();
    await expect(invoke(cmd, {})).rejects.toBe(
      `"${cmd}" saves the desktop's layout, and the Companion keeps its own view state`
    );
    await settle();
    expect(demo.received()).toEqual([]);
  });

  it("are refused through every door the desktop's backend module has to them", async () => {
    const demo = connectDemo();
    const attempts = [
      backend.setWorkspacesState([], null, []),
      backend.setFileTabs({}),
      backend.setBoardTabs({}),
      backend.setCardTabs({}),
    ];
    for (const attempt of attempts) await expect(attempt).rejects.toMatch(/saves the desktop's layout/);
    await settle();
    expect(demo.received()).toEqual([]);
  });

  it.each([...LAYOUT_SAVING_COMMANDS])("%s is refused by the daemon's own table too", (cmd) => {
    expect(tableSize()).toBeGreaterThan(100);
    expect(allowedToRemoteRole(cmd)).toBe(false);
  });

  it("leave everything else alone", () => {
    for (const cmd of ["get_workspaces_state", "get_file_tabs", "set_board", "set_plan_frontmatter_field"]) {
      expect(refusedOnDevice(cmd)).toBeNull();
    }
  });
});

describe("a desktop plugin's command", () => {
  // The Tauri plugins the desktop imports (notifications, the clipboard,
  // the file picker) call `invoke("plugin:...")` through the same core
  // module, which here is the shim. They name a capability of the DESK's
  // window; what a phone may do natively is the shell's to grant, never
  // a bundle's to reach for (ADR 0005).
  it("is refused before it reaches the channel", async () => {
    const demo = connectDemo();
    await expect(invoke("plugin:notification|is_permission_granted")).rejects.toMatch(
      /is a desktop plugin's command/
    );
    await settle();
    expect(demo.received()).toEqual([]);
  });
});

describe("the Workstation's own gate", () => {
  // The shim is the bundle being well-behaved. This is the Workstation
  // not depending on it: the Demo refuses what a real one refuses the
  // Remote role, so a bundle that slipped one through would be told so
  // here exactly as it would at a desk.
  it.each([
    ...LAYOUT_SAVING_COMMANDS,
    "begin_pairing",
    "confirm_pairing",
    "list_devices",
    "revoke_device",
    "revoke_all_devices",
    "set_remote_access",
    "open_workspace_window",
    "hide_to_menu_bar",
    "set_sleep_hold",
    "install_update",
    "open_path_externally",
  ])("refuses %s to a bundle that sends it anyway", async (cmd) => {
    const demo = createDemoWorkstation();
    const client = createChannelClient(loopback(demo));
    await expect(client.invoke(cmd)).rejects.toThrow(`"${cmd}" is refused to the Remote role`);
    expect(demo.unanswered()).toEqual([]);
  });
});
