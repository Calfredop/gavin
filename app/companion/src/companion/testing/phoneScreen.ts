// A phone's terminal for the seam suites: a real xterm, fed what the
// Workstation sends a session's terminal over the channel, and read the
// way the terminal surface reads it.
//
// xterm parses and keeps its buffer without a page to draw on, so this is
// the same parser, the same modes and the same rows the phone has -- the
// only thing missing is the drawing. It listens and asks for the repaint
// exactly as the desk's terminal registry does, so what it holds is what
// a phone opening this session would hold.
import { Terminal } from "@xterm/xterm";
import { listen } from "@tauri-apps/api/event";
import * as backend from "$lib/core/backend";
import { logicalRows } from "$companion/surfaces/quickReplies";
import type { InputModes } from "$companion/surfaces/terminalInput";
import { settle } from "$companion/testing/demoBench";

/// About what an iPhone shows with the keyboard down (ticket 01).
const PHONE = { cols: 48, rows: 31 };

export interface PhoneScreen {
  /// The rows the quick replies read, after everything sent has landed.
  rows(): Promise<string[]>;
  modes(): Promise<InputModes>;
  /// Everything the terminal holds, history included, as text.
  text(): Promise<string>;
  close(): void;
}

export async function openScreen(sessionId: string): Promise<PhoneScreen> {
  const term = new Terminal({ ...PHONE, scrollback: 1000, allowProposedApi: true });
  let written: Promise<void> = Promise.resolve();
  const stop = await listen<[string, string]>("pty-output", (event) => {
    const [id, data] = event.payload;
    if (id !== sessionId) return;
    written = written.then(() => new Promise<void>((resolve) => term.write(data, resolve)));
  });
  await backend.snapshotSession(sessionId);

  async function landed(): Promise<void> {
    await settle();
    await written;
  }

  function lines(from: number): string[] {
    const buffer = term.buffer.active;
    const rows: { text: string; wrapped: boolean }[] = [];
    for (let y = from; y < buffer.length; y++) {
      const line = buffer.getLine(y);
      rows.push({ text: line?.translateToString(false) ?? "", wrapped: line?.isWrapped ?? false });
    }
    return logicalRows(rows);
  }

  return {
    async rows() {
      await landed();
      return lines(Math.max(0, term.buffer.active.length - 40));
    },
    async modes() {
      await landed();
      return {
        bracketedPasteMode: term.modes.bracketedPasteMode,
        applicationCursorKeysMode: term.modes.applicationCursorKeysMode,
      };
    },
    async text() {
      await landed();
      return lines(0).join("\n");
    },
    close() {
      stop();
      term.dispose();
    },
  };
}
