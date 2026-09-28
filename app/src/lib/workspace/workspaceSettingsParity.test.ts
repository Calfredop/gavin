import { describe, it, expect } from "vitest";
import { WORKSPACE_LAYOUT_KEYS, WORKSPACE_SETTINGS_KEYS } from "$lib/workspace/workspaceSettings";

// The two halves of the workspace state split are drawn twice: here, for
// the setters and the adoption of another writer's record, and in
// `workspace_settings.rs`, which is the one that refuses a patch naming
// layout and keeps a layout save's hands off the settings. If they
// disagree the desk breaks quietly: a key the frontend calls a setting
// and the host calls layout is refused at every write, and a key the host
// calls a setting but the frontend still writes through the layout save
// is kept in this window and lost on restart.

const RUST = import.meta.glob("../../../src-tauri/src/*.rs", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function rust(file: string): string {
  const found = Object.entries(RUST).find(([path]) => path.endsWith(`/${file}`));
  if (!found) throw new Error(`${file} not found`);
  return found[1];
}

/// The string literals of one `pub const NAME: &[&str] = &[ ... ];`,
/// comments skipped.
function rustKeys(name: string): string[] {
  const body = rust("workspace_settings.rs").match(new RegExp(`pub const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`));
  if (!body) throw new Error(`no ${name} in workspace_settings.rs`);
  const code = body[1].replace(/\/\/.*$/gm, "");
  return [...code.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("workspace settings parity with the host", () => {
  it("draws the layout on the same keys", () => {
    expect([...WORKSPACE_LAYOUT_KEYS].sort()).toEqual(rustKeys("LAYOUT_KEYS").sort());
  });

  it("draws the settings on the same keys", () => {
    expect([...WORKSPACE_SETTINGS_KEYS].sort()).toEqual(rustKeys("SETTINGS_KEYS").sort());
  });

  it("reads the Rust lists at all", () => {
    // A regex that stopped matching would compare two empty lists green.
    expect(rustKeys("LAYOUT_KEYS")).toContain("pages");
    expect(rustKeys("SETTINGS_KEYS")).toContain("autoCommit");
  });
});
