// One glyph per tool kind, in one place.
//
// This was four identical ternaries -- the drawer, the library dialog,
// the Tools tab and the rail's own step chip each carried a private copy
// -- and every one of them ended in a bare `: FileCode2`, so a kind
// added to `ToolKind` and forgotten in a file rendered as a script with
// nothing to say it was wrong. Three of the four had already been edited
// twice in step by hand; the fourth would eventually not be.
//
// Deliberately NOT in ui/indicators.ts, which is the app's badge
// vocabulary: a tool kind is not a state anything is IN, it has no tone
// and no axis, and indicators.ts is reached from `layoutState.bootstrap`
// where its lucide import already costs seconds. This module is imported
// by components only.

import type { Component } from "svelte";
import {
  Bot,
  Eye,
  FileCode2,
  GitPullRequest,
  Repeat,
  Terminal,
  Zap,
} from "@lucide/svelte";
import type { Tool, ToolKind } from "../orchestrationTools";
import { iconByName } from "./iconLibrary";

/// The icon a tool of this kind draws, everywhere a tool is listed.
///
/// A `Record` rather than a chain of ternaries, so a new `ToolKind` is a
/// TYPE ERROR here rather than a script icon on three surfaces. The
/// glyphs say what the kind does rather than what it is made of: `review`
/// is an eye because the step is somebody looking, which is the same
/// reason the badge beside it on a running review step is one.
const TOOL_KIND_ICON: Record<ToolKind, Component<{ size?: number }>> = {
  agent: Bot,
  command: Terminal,
  script: FileCode2,
  gavin: Zap,
  until: Repeat,
  pr: GitPullRequest,
  review: Eye,
};

export function toolKindIcon(kind: ToolKind): Component<{ size?: number }> {
  // A kind written by a NEWER gavin arrives here as a string this build
  // has no entry for. A script icon is the honest fallback -- it is what
  // the four hand-written ternaries all defaulted to -- and it beats
  // rendering nothing at all beside a name.
  return TOOL_KIND_ICON[kind] ?? FileCode2;
}

/// The glyph a PARTICULAR tool draws: the one its author picked, else
/// the one its kind imposes.
///
/// The distinction the kind lookup cannot make on its own, and the whole
/// reason a tool can carry an icon (v33): six `command` tools on one
/// rail are six identical terminals, and at chip size the name is
/// truncated to a few characters, so the glyph is the only thing left
/// that could tell them apart and it is the one thing they all share.
///
/// A name this build cannot resolve falls back to the kind rather than
/// to a placeholder. That covers both directions of skew -- an icon a
/// NEWER gavin offered, and one dropped from the library -- and in both
/// the kind's glyph is what the tool drew before anybody picked, which
/// is a real answer where a question mark would not be.
export function toolIcon(tool: Pick<Tool, "kind" | "icon">): Component<{ size?: number }> {
  return iconByName(tool.icon) ?? toolKindIcon(tool.kind);
}
