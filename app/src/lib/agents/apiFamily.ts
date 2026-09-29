// The API a custom agent speaks, which is what lets Headroom compress it
// (`2026-09-28-headroom-design.md`, "The recipes", the Custom row).
//
// Pure. The value is stored with the custom agent's other settings
// (`AgentDefaults.customApiFamily`, config.json), and the host attaches it
// to every launch of the custom profile (`api_family_for_daemon` in
// session.rs). The daemon turns it into the recipe at spawn.
//
// Gavin knows nothing of a custom agent's binary. What routes one through
// Headroom is the variable its API's SDK reads, so naming the family is
// naming the recipe. None, the default, is no recipe: the agent launches
// exactly as it did before there was a choice.

/// The stored words. The empty string is None.
export type ApiFamily = "" | "anthropic" | "openai";

/// The picker's rows, None first because it is the default.
export const API_FAMILIES: readonly { value: ApiFamily; label: string }[] = [
  { value: "", label: "None" },
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI-compatible" },
];

/// The family the stored settings name.
///
/// Absent is None: every config written before the setting existed, and
/// every one that never chose. So is a word this build does not know --
/// config.json is shared by the release and dev builds, and a family a
/// newer one added reaches a daemon that reads it as none, so None is
/// what it does here too.
export function apiFamilyOf(defaults: { customApiFamily?: string }): ApiFamily {
  const family = defaults.customApiFamily?.trim() ?? "";
  return API_FAMILIES.find((row) => row.value === family)?.value ?? "";
}

/// `defaults` with the family set. None is written as no key at all,
/// which is how config.json stores it and how `getAgentDefaults` hands
/// it back.
export function withApiFamily<T extends { customApiFamily?: string }>(
  defaults: T,
  family: ApiFamily
): T {
  const rest = { ...defaults };
  delete rest.customApiFamily;
  return family ? { ...rest, customApiFamily: family } : rest;
}
