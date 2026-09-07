// The icons a human can put ON something, as opposed to the ones gavin
// puts on things itself.
//
// Every other glyph in the app is DERIVED -- ui/indicators.ts answers
// "what state is this in", ui/toolKindIcon.ts answers "what is this made
// of" -- and both are lookups precisely so nobody can choose. This one is
// the opposite: a curated set offered to the human, whose only meaning is
// the one they attach to it. A tool wearing a rocket means what its
// author meant by a rocket.
//
// Curated rather than "all of lucide" for two reasons. A picker over
// seven thousand icons is a search box with no answer -- the human does
// not know what they are looking for, they are looking for something that
// will do. And every name here is an import: the module is loaded by the
// four surfaces that draw a tool, so the list is a real cost and a
// thousand icons would be a real one.
//
// The stored value is the NAME, never the component and never an image.
// That is what makes an icon this app's own vocabulary rather than the
// daemon's: the daemon keeps the string and validates nothing (it has
// nothing to validate against), and a name this build cannot resolve
// falls back to the tool's kind rather than erroring -- which is the
// honest reading of a glyph a NEWER gavin picked.

import type { Component } from "svelte";
import {
  // Run
  Play,
  Rocket,
  Zap,
  Terminal,
  Code,
  Wrench,
  Hammer,
  Settings,
  // Agents and checks
  Bot,
  Sparkles,
  Brain,
  Eye,
  Search,
  ListChecks,
  ClipboardCheck,
  Gauge,
  // Git
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitCommitHorizontal,
  FolderGit2,
  History,
  Upload,
  Download,
  // Files
  FileText,
  FileCode2,
  FileDiff,
  FolderOpen,
  FolderTree,
  Paperclip,
  StickyNote,
  Table,
  // Warnings and guards
  TriangleAlert,
  OctagonAlert,
  Bug,
  Flame,
  ShieldCheck,
  Lock,
  Key,
  Radar,
  // Things
  Database,
  Boxes,
  Package,
  Cloud,
  Globe,
  Server,
  Star,
  Flag,
  // Chores
  RefreshCw,
  Repeat,
  BrushCleaning,
  Trash2,
  Timer,
  Link,
  Send,
  Target,
} from "@lucide/svelte";

export interface LibraryIcon {
  /// What is stored on the tool, and the only part of an entry that
  /// survives to disk. Kebab-case, and gavin's OWN key rather than
  /// lucide's -- two of these (`history`, `file-code-2`) are aliases
  /// whose underlying lucide name has already been renamed once, and a
  /// tool must not lose its icon because an icon package tidied up.
  name: string;
  /// The picker's tooltip, and what a search matches on besides the
  /// name. Says what the picture IS, not what it should be used for --
  /// the meaning is the human's to attach.
  label: string;
  icon: Component<{ size?: number }>;
}

export interface IconGroup {
  title: string;
  icons: LibraryIcon[];
}

/// The whole offer, in the order the picker draws it. Grouped rather than
/// alphabetical because a human picking an icon is browsing, not looking
/// up a name they already know: the groups are how you find the rocket
/// without knowing the word "rocket".
export const ICON_LIBRARY: IconGroup[] = [
  {
    title: "Run",
    icons: [
      { name: "play", label: "Play", icon: Play },
      { name: "rocket", label: "Rocket", icon: Rocket },
      { name: "zap", label: "Lightning", icon: Zap },
      { name: "terminal", label: "Terminal", icon: Terminal },
      { name: "code", label: "Code", icon: Code },
      { name: "wrench", label: "Wrench", icon: Wrench },
      { name: "hammer", label: "Hammer", icon: Hammer },
      { name: "settings", label: "Gear", icon: Settings },
    ],
  },
  {
    title: "Agents and checks",
    icons: [
      { name: "bot", label: "Robot", icon: Bot },
      { name: "sparkles", label: "Sparkles", icon: Sparkles },
      { name: "brain", label: "Brain", icon: Brain },
      { name: "eye", label: "Eye", icon: Eye },
      { name: "search", label: "Magnifier", icon: Search },
      { name: "list-checks", label: "Checklist", icon: ListChecks },
      { name: "clipboard-check", label: "Signed off", icon: ClipboardCheck },
      { name: "gauge", label: "Gauge", icon: Gauge },
    ],
  },
  {
    title: "Git",
    icons: [
      { name: "git-branch", label: "Branch", icon: GitBranch },
      { name: "git-merge", label: "Merge", icon: GitMerge },
      { name: "git-pull-request", label: "Pull request", icon: GitPullRequest },
      { name: "git-commit", label: "Commit", icon: GitCommitHorizontal },
      { name: "folder-git", label: "Repository", icon: FolderGit2 },
      { name: "history", label: "History", icon: History },
      { name: "upload", label: "Push", icon: Upload },
      { name: "download", label: "Pull", icon: Download },
    ],
  },
  {
    title: "Files",
    icons: [
      { name: "file-text", label: "Document", icon: FileText },
      { name: "file-code-2", label: "Source file", icon: FileCode2 },
      { name: "file-diff", label: "Diff", icon: FileDiff },
      { name: "folder-open", label: "Folder", icon: FolderOpen },
      { name: "folder-tree", label: "Tree", icon: FolderTree },
      { name: "paperclip", label: "Attachment", icon: Paperclip },
      { name: "sticky-note", label: "Note", icon: StickyNote },
      { name: "table", label: "Table", icon: Table },
    ],
  },
  {
    title: "Warnings and guards",
    icons: [
      { name: "triangle-alert", label: "Warning", icon: TriangleAlert },
      { name: "octagon-alert", label: "Stop", icon: OctagonAlert },
      { name: "bug", label: "Bug", icon: Bug },
      { name: "flame", label: "Fire", icon: Flame },
      { name: "shield-check", label: "Shield", icon: ShieldCheck },
      { name: "lock", label: "Lock", icon: Lock },
      { name: "key", label: "Key", icon: Key },
      { name: "radar", label: "Radar", icon: Radar },
    ],
  },
  {
    title: "Things",
    icons: [
      { name: "database", label: "Database", icon: Database },
      { name: "boxes", label: "Boxes", icon: Boxes },
      { name: "package", label: "Package", icon: Package },
      { name: "cloud", label: "Cloud", icon: Cloud },
      { name: "globe", label: "Globe", icon: Globe },
      { name: "server", label: "Server", icon: Server },
      { name: "star", label: "Star", icon: Star },
      { name: "flag", label: "Flag", icon: Flag },
    ],
  },
  {
    title: "Chores",
    icons: [
      { name: "refresh", label: "Refresh", icon: RefreshCw },
      { name: "repeat", label: "Repeat", icon: Repeat },
      { name: "broom", label: "Broom", icon: BrushCleaning },
      { name: "trash", label: "Bin", icon: Trash2 },
      { name: "timer", label: "Timer", icon: Timer },
      { name: "link", label: "Link", icon: Link },
      { name: "send", label: "Send", icon: Send },
      { name: "target", label: "Target", icon: Target },
    ],
  },
];

const BY_NAME = new Map<string, LibraryIcon>(
  ICON_LIBRARY.flatMap((group) => group.icons.map((entry) => [entry.name, entry] as const))
);

/// Every name the picker can produce, for a caller that needs the
/// vocabulary rather than the pictures.
export const ICON_NAMES: string[] = [...BY_NAME.keys()];

/// The component for a stored name, or null.
///
/// Null for a name no longer in the library -- a glyph dropped from it,
/// or one a NEWER gavin offered and this build has never heard of. Null
/// rather than a stand-in glyph on purpose: the caller already has a
/// better answer than any placeholder, which is whatever the thing drew
/// before it had an icon of its own.
export function iconByName(name: string | null | undefined): Component<{ size?: number }> | null {
  if (!name) return null;
  return BY_NAME.get(name)?.icon ?? null;
}

/// The picker's own label for a stored name, or null on the same terms
/// as `iconByName`.
export function iconLabel(name: string | null | undefined): string | null {
  if (!name) return null;
  return BY_NAME.get(name)?.label ?? null;
}

/// The library filtered to what a query matches, with an empty group
/// dropped rather than drawn as a heading over nothing.
///
/// Matches the LABEL as well as the name, because the two disagree
/// often enough to matter: the picture a human calls a warning is stored
/// as `triangle-alert`, and typing "warning" has to find it. A blank
/// query is the whole library, not none of it.
export function searchIcons(query: string): IconGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return ICON_LIBRARY;
  return ICON_LIBRARY.map((group) => ({
    title: group.title,
    icons: group.icons.filter(
      (entry) =>
        entry.name.includes(needle) ||
        entry.label.toLowerCase().includes(needle) ||
        group.title.toLowerCase().includes(needle)
    ),
  })).filter((group) => group.icons.length > 0);
}
