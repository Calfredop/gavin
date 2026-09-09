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

/// Whether a model name would mean something to a shell beyond itself.
/// The launch command goes to `/bin/sh -c`, so a name carrying any of
/// these has to be quoted or it is not the name that arrives.
///
/// Not hypothetical: Claude Code's 1M-context aliases are spelled
/// `sonnet[1m]` and `opus[1m]`, and `[1m]` is a glob character class. In
/// a checkout that happens to contain a file called `sonnetm`, `sh`
/// expands `--model sonnet[1m]` to `--model sonnetm` and the agent
/// silently runs on a model nobody chose. With no such file sh leaves it
/// alone, which is worse rather than better: the bug appears once, on one
/// machine, and never reproduces.
const SHELL_SPECIAL = /[^\w./:@=+-]/;

/// A model name as a shell will read it: bare when it is already inert,
/// single-quoted when it is not. Conditional rather than unconditional
/// because `launchCommand` is shown to the human in Settings, and
/// `claude --model 'sonnet'` reads like gavin is being superstitious.
function quoteModel(model: string): string {
  return SHELL_SPECIAL.test(model) ? `'${model.replaceAll("'", "'\\''")}'` : model;
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
  return `${command} ${flag} ${quoteModel(chosen)}`;
}

/// The rows themselves: inherit, then each preset, then Custom. The
/// inherit row is labelled with the value it inherits, so a panel never
/// shows an empty box that is secretly doing something.
///
/// Split from the flag gate below because a CARD's picker needs the rows
/// without it. A settings panel is configuring that agent, so offering a
/// model control it has no flag for would be offering a control that
/// cannot work -- but a card can carry a `model:` written when its agent
/// was a different one, and hiding the control there leaves a line the
/// human can see on the card and has no way to clear. The card surfaces
/// answer the flag question beside the control instead, as a warning.
export function modelChoices(
  profile: { models: string[] },
  inheritedDefault: string
): ModelOption[] {
  const inherited = inheritedDefault.trim();
  return [
    { value: "", label: inherited ? `Default (${inherited})` : "(unset)" },
    ...profile.models.map((m) => ({ value: m, label: m })),
    { value: CUSTOM_MODEL, label: "Custom…" },
  ];
}

/// The rows a SETTINGS model picker renders.
///
/// Empty for a profile with no flag -- gavin has no verified way to put a
/// model on that command, and the panel must say so rather than offer a
/// control that cannot work.
export function modelOptions(
  profile: { modelFlag: string; models: string[] },
  globalDefault: string
): ModelOption[] {
  if (!profile.modelFlag) return [];
  return modelChoices(profile, globalDefault);
}

/// The profile table with each row's runtime catalogue folded in.
///
/// Ordering is the whole design. A profile's own `models` are the stable
/// aliases gavin verified -- `sonnet` stays sonnet, `pro` stays pro --
/// so they lead; discovered names, which are dated ids the host read back
/// from the agent a moment ago, follow in the order that agent listed
/// them. Nobody is dropped and nobody is renamed: opencode's 450 rows are
/// long, but a picker that quietly omitted the provider a user actually
/// configured would be worse than a long one.
///
/// A profile with no entry, an entry that is empty, or a whole catalogue
/// that never arrived, comes back byte-identical -- which is why the
/// bootstrap can apply this unconditionally rather than testing first.
export function mergeDiscoveredModels<P extends { id: string; models: string[] }>(
  profiles: P[],
  catalog: Record<string, string[]>
): P[] {
  return profiles.map((profile) => {
    const discovered = (catalog[profile.id] ?? []).map((m) => m.trim()).filter(Boolean);
    if (discovered.length === 0) return profile;
    const merged = [...profile.models];
    for (const model of discovered) {
      if (!merged.includes(model)) merged.push(model);
    }
    return merged.length === profile.models.length ? profile : { ...profile, models: merged };
  });
}
