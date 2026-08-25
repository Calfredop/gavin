/// Composing a chosen model onto an agent's launch command, and the
/// option list a model picker renders. Pure and separate from settings.ts
/// because every launcher needs the first half and both settings panels
/// need the second -- the .svelte files stay templates over this.

/// The sentinel a picker uses for "type your own". Never a model name
/// itself and never written to config: choosing it reveals a text box,
/// and what the user types there is what gets stored.
export const CUSTOM_MODEL = "__custom__";

export interface ModelOption {
  value: string;
  label: string;
}

/// The spellings of a flag that a hand-written command might use. Only
/// `--model` has a short form worth knowing about, and all four CLIs that
/// take a model spell it the same two ways.
function flagAliases(flag: string): string[] {
  return flag === "--model" ? ["--model", "-m"] : [flag];
}

/// Whether the command already names a model. Token-wise, not a substring
/// match: `--modelling` contains `--model` and means something else
/// entirely, and treating it as a hit would silently drop the user's
/// chosen model.
export function commandSpecifiesModel(command: string, flag: string): boolean {
  if (!flag) return false;
  const aliases = flagAliases(flag);
  return command
    .split(/\s+/)
    .some((token) => aliases.some((alias) => token === alias || token.startsWith(`${alias}=`)));
}

/// `command` plus `<flag> <model>`, when there is a model to add, a flag
/// to add it with, and the command does not already carry one. Returns
/// `command` untouched otherwise -- callers hand this straight to a
/// shell, so doing nothing is the safe failure.
///
/// A command that already names a model WINS: it is the more specific
/// statement of intent, and two `--model` flags is an argv error rather
/// than a preference the agent could resolve.
export function composeLaunchCommand(command: string, flag: string, model: string): string {
  const chosen = model.trim();
  if (!chosen || !flag || commandSpecifiesModel(command, flag)) return command;
  return `${command} ${flag} ${chosen}`;
}

/// The rows a model picker renders: inherit, then each preset, then
/// Custom. The inherit row is labelled with the value it inherits, so a
/// panel never shows an empty box that is secretly doing something.
///
/// Empty for a profile with no flag -- gavin has no verified way to put a
/// model on that command, and the panel must say so rather than offer a
/// control that cannot work.
export function modelOptions(
  profile: { modelFlag: string; models: string[] },
  globalDefault: string
): ModelOption[] {
  if (!profile.modelFlag) return [];
  const inherited = globalDefault.trim();
  return [
    { value: "", label: inherited ? `Default (${inherited})` : "(unset)" },
    ...profile.models.map((m) => ({ value: m, label: m })),
    { value: CUSTOM_MODEL, label: "Custom…" },
  ];
}
