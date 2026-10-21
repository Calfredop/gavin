// The activity calendar's two reads on the Demo Workstation: a year of
// runs, commits and pushes believable enough to zoom through.
//
// A real Workstation reads them off what it already keeps -- the
// daemon's run tables (`activity_runs`, v78) and git (`git_activity`).
// The demo has a few hours of each, so the year behind them is drawn:
// seeded by the workspace and the local date, so a day reads the same on
// every visit and in every suite, busier on weekdays, quieter over two
// holiday stretches, over the demo's own cards, tools and files. What a
// visitor ran on the phone today is in it too.
import type { ActivityCommit, ActivityPush, ActivityRun, GitActivity } from "$lib/activity/activity";
import { DemoFailure, text, type Answer, type DemoCommand, type DemoContext } from "$companion/demo/answer";

/// mulberry32: small, fast and the same everywhere.
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function number(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new DemoFailure(`missing argument "${name}"`);
  return value;
}

/// Each local day whose midnight falls in `[since, until)`, oldest first.
function daysIn(since: number, until: number): Date[] {
  const first = new Date(since * 1000);
  const out: Date[] = [];
  for (let d = new Date(first.getFullYear(), first.getMonth(), first.getDate()); d.getTime() < until * 1000; ) {
    if (d.getTime() >= since * 1000) out.push(d);
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  }
  return out;
}

/// How much happens on a day, 0..1: weekdays most, Sundays least, and
/// the two weeks around New Year and a fortnight in August off.
function busyness(day: Date): number {
  const holiday =
    (day.getMonth() === 11 && day.getDate() >= 22) ||
    (day.getMonth() === 0 && day.getDate() <= 4) ||
    (day.getMonth() === 7 && day.getDate() >= 8 && day.getDate() <= 21);
  if (holiday) return 0.05;
  return [0.15, 1, 1, 0.95, 1, 0.85, 0.35][day.getDay()];
}

function seedOf(workspace: string, what: string, day: Date): number {
  return hash(`${workspace}:${what}:${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`);
}

/// Seconds into a day, in working hours with a few late ones.
function timeOfDay(next: () => number): number {
  const hour = next() < 0.12 ? 19 + next() * 4 : 9 + next() * 9;
  return Math.floor(hour * 3600);
}

function workspaceOf(args: Record<string, unknown>, demo: DemoContext): string {
  const id = text(args, "workspaceId");
  if (!demo.state.workspaces.workspaces.some((w) => w.id === id)) {
    throw new DemoFailure(`the Demo Workstation has no workspace ${JSON.stringify(id)}`);
  }
  return id;
}

const OUTCOMES: [string, number | null][] = [
  ["exited", 0],
  ["exited", 0],
  ["exited", 0],
  ["exited", 0],
  ["exited", 0],
  ["replaced", null],
  ["exited", 1],
  ["unlinked", null],
  ["abandoned", null],
];

function drawnRuns(workspace: string, demo: DemoContext, since: number, until: number, now: number): ActivityRun[] {
  // By file name, which a card keeps when the demo's loop moves it to
  // `done/`: a day's runs land on the same cards however the board moved.
  const cards = (demo.state.trees[workspace]?.contexts ?? [])
    .flatMap((c) => c.plans)
    .sort((a, b) => a.fileName.localeCompare(b.fileName))
    .map((p) => p.path);
  if (cards.length === 0) return [];
  const tools = [
    ...demo.state.tools.filter((t) => t.workspaceId === workspace).map((t) => t.id),
    "builtin:commit",
  ];
  const runs: ActivityRun[] = [];
  for (const day of daysIn(since, until)) {
    const next = generator(seedOf(workspace, "runs", day));
    const count = Math.floor(next() * 6 * busyness(day));
    for (let i = 0; i < count; i++) {
      const startedAt = Math.floor(day.getTime() / 1000) + timeOfDay(next);
      const length = 120 + Math.floor(next() * 80 * 60);
      const tool = next() < 0.15;
      const [outcome, exitCode] = OUTCOMES[Math.floor(next() * OUTCOMES.length)];
      if (startedAt + length >= now) continue;
      runs.push({
        kind: tool ? "tool" : "card",
        workspaceId: workspace,
        path: tool ? null : cards[Math.floor(next() * cards.length)],
        toolId: tool ? tools[Math.floor(next() * tools.length)] : null,
        sessionId: `s-demo-${workspace}-${startedAt}-${i}`,
        command: tool ? null : "claude",
        startedAt,
        endedAt: outcome === "abandoned" ? null : startedAt + length,
        exitCode: tool ? (outcome === "exited" ? exitCode : null) : exitCode,
        outcome: tool ? (exitCode === 1 ? "failed" : outcome === "abandoned" ? "abandoned" : "passed") : outcome,
      });
    }
  }
  return runs;
}

const SUBJECTS: Record<string, string[]> = {
  "atlas-api": [
    "feat(auth): refresh tokens before they expire",
    "fix(auth): keep the session cookie on redirect",
    "feat(billing): prorate a plan change mid-cycle",
    "fix(billing): round invoice totals per line",
    "refactor(store): one connection pool per worker",
    "test(api): cover the rate limiter's burst",
    "docs: the webhook retry schedule",
    "chore(deps): bump the postgres driver",
  ],
  "field-notes": [
    "feat(sync): queue edits made offline",
    "fix(sync): merge two edits to one note",
    "feat(editor): checklists in a note",
    "fix(editor): keep the caret on paste",
    "style: the note list on a small screen",
    "test(sync): a conflict on reconnect",
  ],
};

function drawnGit(root: string, demo: DemoContext, since: number, now: number): GitActivity {
  const repo = demo.state.repos[root];
  if (!repo) return { commits: [], pushes: [] };
  const name = root.slice(root.lastIndexOf("/") + 1);
  const subjects = SUBJECTS[name] ?? ["chore: tidy up", "fix: an edge case", "feat: a small step"];
  const head = repo.commits[repo.branches[repo.head]];
  const paths = Object.keys(head?.tree ?? repo.index);
  const commits: ActivityCommit[] = [];
  const pushes: ActivityPush[] = [];
  let pushed: string | null = null;
  for (const day of daysIn(since, now + 1)) {
    const next = generator(seedOf(root, "git", day));
    const count = Math.floor(next() * 7 * busyness(day));
    const today: ActivityCommit[] = [];
    for (let i = 0; i < count; i++) {
      const at = Math.floor(day.getTime() / 1000) + timeOfDay(next);
      if (at >= now) continue;
      const sha = Array.from({ length: 5 }, () => Math.floor(next() * 0xffffffff).toString(16).padStart(8, "0")).join("");
      const files = new Set<string>();
      const touched = 1 + Math.floor(next() * Math.min(4, paths.length));
      for (let f = 0; f < touched && paths.length > 0; f++) files.add(paths[Math.floor(next() * paths.length)]);
      today.push({ sha, at, author: repo.author.name, subject: subjects[Math.floor(next() * subjects.length)], files: [...files] });
    }
    today.sort((a, b) => a.at - b.at);
    commits.push(...today);
    const last = today.at(-1);
    if (last && next() < 0.6) {
      const at = Math.min(last.at + 300 + Math.floor(next() * 3600), now - 1);
      pushes.push({ at, remoteRef: `${repo.remote.name}/${repo.head}`, oldSha: pushed, newSha: last.sha });
      pushed = last.sha;
    }
  }
  // Newest first, the order git walks them in.
  return { commits: commits.reverse(), pushes: pushes.reverse() };
}

export const ACTIVITY_COMMANDS: Record<string, DemoCommand> = {
  activity_runs: (args, demo): Answer<"activityRuns"> => {
    const workspace = workspaceOf(args, demo);
    const since = number(args, "since");
    const until = number(args, "until");
    const now = Math.floor(Date.now() / 1000);
    const ran: ActivityRun[] = demo.state.toolRuns
      .filter((r) => r.workspaceId === workspace && r.startedAt >= since && r.startedAt < until)
      .map((r) => ({
        kind: "tool",
        workspaceId: workspace,
        path: null,
        toolId: r.toolId,
        sessionId: r.sessionId,
        command: r.command,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        exitCode: r.exitCode,
        outcome: r.outcome,
      }));
    return [...drawnRuns(workspace, demo, since, until, now), ...ran].sort((a, b) => a.startedAt - b.startedAt);
  },
  git_activity: (args, demo): Answer<"gitActivity"> => {
    return drawnGit(text(args, "cwd"), demo, number(args, "since"), Math.floor(Date.now() / 1000));
  },
};
