import { describe, it, expect } from "vitest";
import { devReportOnlyPolicy } from "../../vite-dev-csp.js";

/// The mirror exists so the policy the bundle ENFORCES is the policy the
/// dev app REPORTS. Its whole value is that the two cannot drift, so
/// these pin the derivation rather than a hand-written expected string.
describe("devReportOnlyPolicy", () => {
  // `?raw` rather than node:fs: @types/node is not installed for a
  // browser bundle, so a `node:fs` import fails `npm run check` -- the
  // same constraint the other source-reading suites work under.
  const config = Object.values(
    import.meta.glob("../../src-tauri/tauri.conf.json", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>
  )[0];
  const origins = ["http://localhost:1420", "ws://localhost:1420"];

  it("mirrors the real tauri.conf.json policy", () => {
    const policy = devReportOnlyPolicy(config, origins);
    expect(policy).toBeTruthy();
    // The directives that actually contain the blast radius of a
    // compromised page: no remote script, no remote exfiltration.
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");
  });

  it("relaxes script-src and connect-src, and nothing else", () => {
    const configured = JSON.parse(config).app.security.csp as string;
    const mirrored = devReportOnlyPolicy(config, origins) as string;

    const split = (policy: string) =>
      new Map(
        policy
          .split(";")
          .map((d) => d.trim())
          .filter(Boolean)
          .map((d) => {
            const [name, ...sources] = d.split(/\s+/);
            return [name, sources] as const;
          })
      );

    const before = split(configured);
    const after = split(mirrored);
    expect([...after.keys()]).toEqual([...before.keys()]);

    for (const [name, sources] of before) {
      if (name === "script-src") {
        // Only in dev, and only because tauri-codegen hashes the two
        // inline bootstrap scripts for the bundle and cannot for HTML
        // vite serves. See vite-dev-csp.js.
        expect(after.get(name)).toEqual([...sources, "'unsafe-inline'"]);
      } else if (name === "connect-src") {
        expect(after.get(name)).toEqual([...sources, ...origins]);
      } else {
        expect(after.get(name)).toEqual(sources);
      }
    }
  });

  it("mirrors nothing when the app configures no policy", () => {
    expect(devReportOnlyPolicy('{"app":{"security":{"csp":null}}}', origins)).toBeNull();
    expect(devReportOnlyPolicy("{}", origins)).toBeNull();
  });

  it("keeps ipc: and the ipc.localhost origin, which the IPC fetch needs", () => {
    // tauri's ipc-protocol.js POSTs to ipc://localhost/<cmd> (macOS,
    // Linux) or http://ipc.localhost/<cmd> (Windows); blocking it makes
    // every invoke fall back to postMessage with a console warning.
    const policy = devReportOnlyPolicy(config, origins) as string;
    expect(policy).toContain("ipc:");
    expect(policy).toContain("http://ipc.localhost");
  });
});
