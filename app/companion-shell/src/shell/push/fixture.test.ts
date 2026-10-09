// The iOS Notification Service Extension's open, held to the daemon's seal
// by the table both read (test-fixtures/companion-notify): the extension's
// Swift is built for this Mac and run over it by scripts/notify-fixture.sh.
// Only on a Mac, which has swiftc and CryptoKit. Everywhere else the
// daemon's own suite still holds its seal to the table.
import { describe, expect, it } from "vitest";
// @ts-expect-error -- no Node types in this project, by design
import { execFileSync } from "node:child_process";

const onMac = (globalThis as { process?: { platform?: string } }).process?.platform === "darwin";

describe.skipIf(!onMac)("the extension's open against the shared table", () => {
  it("opens, refuses and lands every case as the table says", () => {
    const script = new URL("../../../scripts/notify-fixture.sh", import.meta.url).pathname;
    let out: string;
    try {
      out = execFileSync(script, { encoding: "utf8" });
    } catch (e) {
      const failed = e as { stdout?: string; stderr?: string; message: string };
      throw new Error(`${failed.stdout ?? ""}${failed.stderr ?? ""}` || failed.message);
    }
    expect(out).toMatch(/^(\d+) of \1 cases read as the table says$/m);
  }, 120_000);
});
