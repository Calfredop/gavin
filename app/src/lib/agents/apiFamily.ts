// The API a custom agent speaks, which is what lets Headroom compress it
// (`2026-09-28-headroom-design.md`, "The recipes", the Custom row).
//
// Pure. The value lives on a CustomProfile (`apiFamily`), and the host
// attaches it to every launch of a non-stock profile
// (`api_family_for_daemon` in session.rs). The daemon turns it into the
// recipe at spawn.
//
// Gavin knows nothing of a custom agent's binary. What routes one through
// Headroom is the variable its API's SDK reads, so naming the family is
// naming the recipe. None, the default, is no recipe: the agent launches
// exactly as it did before there was a choice.

import type { CustomProfile } from "$lib/cards/complexity";

/// The stored words. The empty string is None.
export type ApiFamily = "" | "anthropic" | "openai";

/// The picker's rows, None first because it is the default.
export const API_FAMILIES: readonly { value: ApiFamily; label: string }[] = [
  { value: "", label: "None" },
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI-compatible" },
];

function normalizeFamily(raw: string | undefined | null): ApiFamily {
  const family = raw?.trim() ?? "";
  return API_FAMILIES.find((row) => row.value === family)?.value ?? "";
}

/// The family a named custom profile (or the legacy single-custom fields)
/// carries. Prefer `profileId` against `customProfiles`; fall back to
/// `customApiFamily` for configs that have not migrated yet.
export function apiFamilyOf(
  defaults: { customApiFamily?: string; customProfiles?: CustomProfile[] },
  profileId?: string
): ApiFamily {
  if (profileId) {
    const profile = defaults.customProfiles?.find((p) => p.id === profileId);
    if (profile) return normalizeFamily(profile.apiFamily);
  }
  if (defaults.customProfiles?.length === 1) {
    return normalizeFamily(defaults.customProfiles[0].apiFamily);
  }
  return normalizeFamily(defaults.customApiFamily);
}

/// `defaults` with the family set on the named profile (or the sole
/// custom profile / legacy field). None clears the key.
export function withApiFamily<
  T extends { customApiFamily?: string; customProfiles?: CustomProfile[] },
>(defaults: T, family: ApiFamily, profileId?: string): T {
  const profiles = defaults.customProfiles ? [...defaults.customProfiles] : [];
  const targetId = profileId ?? (profiles.length === 1 ? profiles[0].id : undefined);
  if (targetId) {
    const index = profiles.findIndex((p) => p.id === targetId);
    if (index >= 0) {
      const next = { ...profiles[index] };
      if (family) next.apiFamily = family;
      else delete next.apiFamily;
      profiles[index] = next;
      const rest = { ...defaults, customProfiles: profiles };
      delete rest.customApiFamily;
      return rest;
    }
  }
  const rest = { ...defaults };
  delete rest.customApiFamily;
  return family ? { ...rest, customApiFamily: family } : rest;
}
