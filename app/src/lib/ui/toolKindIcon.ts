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
import type { ToolKind } from "../orchestrationTools";

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
