// The Settings panels' search box -- the per-workspace tab and the
// app-wide modal both use it, so "search settings" means the same thing
// in either place.
//
// Whole SECTIONS hide or show together, not rows inside one: a settings
// screen is a handful of named panes, and the box narrows "which pane
// has this" rather than pretending to be a row-level filter it would
// have to reach into a dozen unrelated control shapes to do honestly.
// Each section carries the words a human would type for it -- its
// title, its row labels, a few of its own nouns -- not the connecting
// prose around them.

import { matchesFields, queryTokens } from "$lib/search";

export interface SettingsSection {
  id: string;
  keywords: string[];
}

export interface SettingsSearch {
  filtering: boolean;
  shown: number;
  total: number;
  visible: (id: string) => boolean;
}

export function searchSettings(sections: SettingsSection[], query: string): SettingsSearch {
  const tokens = queryTokens(query);
  if (tokens.length === 0) {
    return { filtering: false, shown: sections.length, total: sections.length, visible: () => true };
  }
  const kept = new Set(sections.filter((s) => matchesFields(tokens, s.keywords)).map((s) => s.id));
  return {
    filtering: true,
    shown: kept.size,
    total: sections.length,
    visible: (id) => kept.has(id),
  };
}
