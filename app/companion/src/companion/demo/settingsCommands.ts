// What the Demo Workstation answers to the Workstation's app-wide settings:
// the reads the desk's bootstrap makes, and the writes its Settings page
// and the Companion's make.
//
// The host's shape, command by command (`session.rs`): each write replaces
// one setting in config.json -- null clears it back to gavin's default --
// and then announces `app-settings-synced`, naming who wrote it, so every
// window and every Device reads the settings again. A Device's write is
// announced under `companion` (`forwarding::FORWARDED_ORIGIN`): no desk
// window has that label, so every one of them takes the change.
import { DemoFailure, type Answer, type DemoCommand, type DemoContext } from "$companion/demo/answer";
import type { DemoSettings } from "$companion/demo/sampleData";

/// The origin the host gives a write a Device made.
export const DEVICE_ORIGIN = "companion";

function announce(demo: DemoContext): void {
  demo.emit("app-settings-synced", { origin: DEVICE_ORIGIN });
}

function nullable<T>(args: Record<string, unknown>, name: string, is: (v: unknown) => v is T): T | null {
  const value = args[name];
  if (value === null || value === undefined) return null;
  if (!is(value)) throw new DemoFailure(`invalid type for "${name}"`);
  return value;
}

const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isText = (v: unknown): v is string => typeof v === "string";
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/// One write: the new value in place, then the announcement.
function write<K extends keyof DemoSettings>(key: K, read: (args: Record<string, unknown>) => DemoSettings[K]): DemoCommand {
  return (args, demo) => {
    demo.state.settings[key] = read(args);
    announce(demo);
    return null;
  };
}

/// A copy of a stored object, so no caller holds the demo's own -- through
/// JSON, which is what the wire would have made of it anyway.
function copy<T>(value: T): T {
  return value === null ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export const SETTINGS_COMMANDS: Record<string, DemoCommand> = {
  get_theme_pref: (_args, demo): Answer<"getThemePref"> => demo.state.settings.theme,
  get_terminal_font_size: (_args, demo): Answer<"getTerminalFontSize"> => demo.state.settings.terminalFontSize,
  get_custom_resume_args: (_args, demo): Answer<"getCustomResumeArgs"> => demo.state.settings.customResumeArgs,
  get_auto_commit: (_args, demo): Answer<"getAutoCommit"> => demo.state.settings.autoCommit,
  get_require_review: (_args, demo): Answer<"getRequireReview"> => demo.state.settings.requireReview,
  get_headroom_default: (_args, demo): Answer<"getHeadroomDefault"> => demo.state.settings.headroom,
  get_git_tracking_default: (_args, demo): Answer<"getGitTrackingDefault"> => demo.state.settings.gitTracking,
  get_agent_model_defaults: (_args, demo): Answer<"getAgentModelDefaults"> => ({ ...demo.state.settings.agentModels }),
  get_agent_defaults: (_args, demo): Answer<"getAgentDefaults"> => copy(demo.state.settings.agentDefaults),
  get_launch_config: (_args, demo): Answer<"getLaunchConfig"> => copy(demo.state.settings.launch),
  get_playwright_pane_open: (_args, demo): Answer<"getPlaywrightPaneOpen"> => demo.state.settings.playwrightPaneOpen,

  // A blank theme is no theme: "System", stored as absence.
  set_theme_pref: write("theme", (args) => nullable(args, "theme", isText)?.trim() || null),
  set_terminal_font_size: write("terminalFontSize", (args) =>
    nullable(args, "size", (v): v is number => typeof v === "number" && v > 0)
  ),
  set_custom_resume_args: write("customResumeArgs", (args) => nullable(args, "customResumeArgs", isText)),
  set_auto_commit: write("autoCommit", (args) => nullable(args, "enabled", isBool)),
  set_require_review: write("requireReview", (args) => nullable(args, "enabled", isBool)),
  set_git_tracking_default: write("gitTracking", (args) => nullable(args, "tracked", isBool)),
  // Only the two words the host takes (`browser_view.rs`).
  set_playwright_pane_open: write("playwrightPaneOpen", (args) =>
    nullable(args, "value", (v): v is string => v === "auto" || v === "chip")
  ),

  // An empty model removes the profile's entry rather than storing "",
  // so the picker's inherit row can undo a default.
  set_agent_model_default: (args, demo) => {
    const profileId = nullable(args, "profileId", isText);
    const model = nullable(args, "model", isText);
    if (!profileId || model === null) throw new DemoFailure('missing argument "profileId" or "model"');
    const models = { ...demo.state.settings.agentModels };
    if (model.trim()) models[profileId] = model.trim();
    else delete models[profileId];
    demo.state.settings.agentModels = models;
    announce(demo);
    return null;
  },

  // Wholesale, as the host takes them: the panel hands back the whole
  // struct, so no field is saved while another is dropped.
  set_agent_defaults: write("agentDefaults", (args) => {
    const defaults = nullable(args, "agentDefaults", isObject);
    if (!defaults) throw new DemoFailure('missing argument "agentDefaults"');
    return copy(defaults) as unknown as DemoSettings["agentDefaults"];
  }),
  set_launch_config: write("launch", (args) => copy(nullable(args, "launch", isObject)) as DemoSettings["launch"]),
};
