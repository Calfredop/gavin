// What every one of the Demo Workstation's answers is made of.
//
// Apart from commands.ts so that the command tables split out of it --
// the Git commands, the file commands -- can share these without
// importing the module that gathers them all.
import type * as backend from "$lib/core/backend";
import type { DemoState } from "$companion/demo/sampleData";

/// A command the demo understood and would not, or could not, carry out.
/// Its message is what the bundle's caller is told.
export class DemoFailure extends Error {}

export interface DemoContext {
  state: DemoState;
  /// What the desktop host does when it emits: every listener for the
  /// event hears it.
  emit(event: string, payload: unknown): void;
}

export type DemoCommand = (args: Record<string, unknown>, demo: DemoContext) => unknown;

/// What the desktop's backend module promises for one of its functions.
export type Answer<K extends keyof typeof backend> = (typeof backend)[K] extends (
  ...args: never[]
) => Promise<infer R>
  ? R
  : never;

/// A string argument, or the refusal a desktop command gives a caller
/// that left it out.
export function text(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string") throw new DemoFailure(`missing argument "${name}"`);
  return value;
}
