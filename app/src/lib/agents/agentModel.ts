/// Composing a chosen model and effort onto an agent's launch command,
/// and the option lists their pickers render. Pure and separate from settings.ts
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

/// Whether a flag is safe to write into a shell command as it stands.
/// Every token has to be inert: unlike a model or an effort LEVEL, a flag
/// is appended unquoted -- it has to stay a flag -- and the workspace's
/// own `[agent] effort_flag` arrives in a repo's config.toml, where
/// `--x; curl … | sh` is a string like any other. A flag with a shell
/// character in it is dropped rather than quoted into something the
/// agent would then refuse.
function flagIsInert(flag: string): boolean {
  const tokens = flag.trim().split(/\s+/);
  return tokens.every((token) => token !== "" && !SHELL_SPECIAL.test(token));
}

/// Whether the command already sets an effort, by the same token rule as
/// `commandSpecifiesModel`. Only the flag's LAST token is looked for:
/// codex's `-c model_reasoning_effort=` is a generic override flag and a
/// key, and it is the key that says the effort is set -- a command that
/// already carries `-c model="gpt-5"` has not chosen one.
///
/// An attached flag (ending in `=`) matches any token it begins, so
/// `model_reasoning_effort="high"` counts; a separated one matches itself
/// or its own `=` form, so `--effortless` does not. The env-assignment
/// shape below rides the attached rule: `KIMI_MODEL_THINKING_EFFORT=low`
/// at the front of the command is a token that begins with
/// `KIMI_MODEL_THINKING_EFFORT=`.
export function commandSpecifiesEffort(command: string, flag: string): boolean {
  const last = flag.trim().split(/\s+/).pop() ?? "";
  if (!last) return false;
  const tokens = command.split(/\s+/);
  if (last.endsWith("=")) return tokens.some((token) => token.startsWith(last));
  return tokens.some((token) => token === last || token.startsWith(`${last}=`));
}

/// The effort "flag" that is not a flag: an env-assignment shape
/// (`KIMI_MODEL_THINKING_EFFORT=`), for an agent whose effort knob is an
/// environment variable. Distinct from an attached flag because it goes
/// BEFORE the command, not after it -- `KIMI_MODEL_THINKING_EFFORT=low
/// kimi ...` -- and gavin composes every launch through `sh -c`, so the
/// prefix composes like a flag. The shape is deliberately narrow
/// (screaming-shell-variable only) so a lowercase `-c key=` override
/// keeps its append meaning.
const EFFORT_ENV_SHAPE = /^[A-Z][A-Z0-9_]*=$/;

/// `command` plus the effort, when there is one to add, a usable flag to
/// add it with, and the command does not already carry one. Returns
/// `command` untouched otherwise, for `composeLaunchCommand`'s reason.
///
/// Three shapes, the `AgentProfile::effort_flag` convention the Rust
/// table documents: a flag ending in `=` takes the level attached
/// (`-c model_reasoning_effort=high`), an env-assignment shape
/// (`EFFORT_ENV_SHAPE`) is PREPENDED before the whole command
/// (`KIMI_MODEL_THINKING_EFFORT=low kimi ...`), and anything else takes
/// the level as the next argument (`--effort high`). The level is quoted
/// exactly as a model name is, and in the attached shape the quotes still
/// close on the same word: `--think='a b'` is one argv.
export function composeEffort(command: string, flag: string, effort: string): string {
  const chosen = effort.trim();
  const usable = flag.trim();
  if (!chosen || !usable || !flagIsInert(usable) || commandSpecifiesEffort(command, usable)) {
    return command;
  }
  const level = quoteModel(chosen);
  if (EFFORT_ENV_SHAPE.test(usable)) return `${usable}${level} ${command}`;
  return usable.endsWith("=") ? `${command} ${usable}${level}` : `${command} ${usable} ${level}`;
}

/// The rows an EFFORT picker renders: inherit (labelled with what it
/// inherits), each level the CLI documents, then Custom. The same shape
/// as `modelChoices`, and the same sentinel, so a panel that already
/// draws a model picker draws this one with the same template.
export function effortChoices(
  profile: { efforts: string[] },
  inheritedDefault: string
): ModelOption[] {
  return modelChoices({ models: profile.efforts }, inheritedDefault);
}

/// The rows a SETTINGS effort picker renders -- empty for a profile with
/// no effort flag, for `modelOptions`' reason: a control that cannot
/// reach the agent is worse than no control.
export function effortOptions(
  profile: { effortFlag: string; efforts: string[] },
  globalDefault: string
): ModelOption[] {
  if (!profile.effortFlag) return [];
  return effortChoices(profile, globalDefault);
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

/// Whether the model row shows its free-text box rather than the picker.
///
/// Two ways in, and the second is the one a picker alone would lose: the
/// human opened the box from the picker's "Custom…" row, OR the
/// workspace already holds a model that is not among this profile's
/// presets -- typed here earlier, or written into config.toml by hand.
/// Without that second clause the picker would draw one of the presets
/// as selected while the workspace ran something else.
///
/// `ownModel` is what the workspace holds of its OWN, never the resolved
/// one: a model inherited from the app-wide default is not this
/// workspace's answer, and offering to edit it here would be offering to
/// edit somebody else's setting.
export function modelIsCustom(boxOpen: boolean, ownModel: string, presets: readonly string[]): boolean {
  return boxOpen || (ownModel !== "" && !presets.includes(ownModel));
}

/// The effort levels to suggest for a row that may or may not name a
/// profile -- a complexity table row, where an empty profile means "this
/// workspace's agent", which the table cannot see.
///
/// A named profile gets its own levels. An unnamed one gets every level
/// any profile documents, deduped in first-seen order, because the row
/// has to offer SOMETHING and a suggestion is only that: the box stays
/// free text, and a level the eventual agent lacks is caught by the
/// launch (`composeEffort` drops an effort it has no flag for).
export function effortPresets(
  profiles: readonly { id: string; efforts?: string[] }[],
  profileId: string
): string[] {
  const id = profileId.trim();
  if (id) return [...(profiles.find((p) => p.id === id)?.efforts ?? [])];
  const out: string[] = [];
  for (const profile of profiles) {
    for (const level of profile.efforts ?? []) {
      if (!out.includes(level)) out.push(level);
    }
  }
  return out;
}
