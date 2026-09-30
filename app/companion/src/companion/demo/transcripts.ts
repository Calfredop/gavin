// What the Demo Workstation's terminals say.
//
// Each session starts part-way through its work, with enough behind it to
// scroll back through on a phone, and ends on what it is doing now: an
// agent at work, one asking in a menu, one asking in a sentence, one
// done, and a shell. Drawn the way the agents the desk runs draw -- the
// quick replies read these screens exactly as they read a real one.
//
// Plain data. What a terminal DOES with a keystroke is sessions.ts.
import type { AgentAsk, DemoTerminal } from "$companion/demo/sessions";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const AMBER = "\x1b[33m";
const OFF = "\x1b[0m";

/// Rows, each ended as a terminal ends a line.
export function rows(...lines: string[]): string {
  return lines.map((line) => `${line}\r\n`).join("");
}

/// How wide the demo's agents write: a phone's terminal (about 48
/// columns on an iPhone, keyboard down), less the agent's own margin. A
/// real agent wraps to the width its terminal reports; the demo's are
/// written once, for the screen the demo is for.
const WIDTH = 44;

const ITEM = /^\d+\. /;

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line !== "" && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === "" ? word : `${line} ${word}`;
    }
  }
  lines.push(line);
  return lines;
}

/// The agent speaking, in paragraphs: consecutive lines are one, a blank
/// line ends one, and so does a numbered item, whose own lines hang under
/// its text.
export function said(...lines: string[]): string[] {
  const paragraphs: string[] = [];
  let open = false;
  for (const line of lines) {
    if (line === "") {
      paragraphs.push("");
      open = false;
    } else if (open && !ITEM.test(line)) {
      paragraphs[paragraphs.length - 1] += ` ${line}`;
    } else {
      paragraphs.push(line);
      open = true;
    }
  }
  const out = paragraphs.flatMap((p) => {
    if (p === "") return [""];
    const hang = ITEM.test(p) ? "   " : "";
    return wrap(p, WIDTH - hang.length).map((line, i) => (i === 0 ? line : hang + line));
  });
  return out.map((line, i) => (i === 0 ? `${GREEN}⏺${OFF} ${line}` : line === "" ? "" : `  ${line}`));
}

/// A tool the agent ran, and what came back.
function ran(tool: string, result: string): string[] {
  return [`${GREEN}⏺${OFF} ${BOLD}${tool}${OFF}`, `  ${DIM}⎿  ${result}${OFF}`];
}

/// The spinner an agent shows while it works. `esc to interrupt` is what
/// the turn verdict and the quick replies both read as "still going".
export function working(what: string, elapsed: string): string {
  return `${AMBER}✻${OFF} ${what}… ${DIM}(${elapsed} · esc to interrupt)${OFF}`;
}

/// The agent's input box, waiting: bracketed paste on, as an agent's own
/// input turns it on, and the caret after its `>`.
export const COMPOSER = "\x1b[?2004h> ";

/// Leaving the input box: bracketed paste off again.
export const LEAVE_COMPOSER = "\x1b[?2004l";

/// A shell's prompt.
export function prompt(folder: string): string {
  return `${DIM}demo@workstation${OFF} ${BOLD}${folder}${OFF} % `;
}

function agent(output: string, ask: AgentAsk, reply: string | null = null): DemoTerminal {
  return { output, program: { kind: "agent", ask, line: "", reply } };
}

// ---- atlas-api --------------------------------------------------------

function atlasAgent(): DemoTerminal {
  return agent(
    rows(
      `${DIM}> what's left on the token refresh plan?${OFF}`,
      "",
      ...ran("Read(.gavin-root/plans/token-refresh.md)", "Read 64 lines"),
      "",
      ...said(
        "Three of the seven items are done:",
        "",
        "1. Refresh tokens are stored hashed, never in plain text.",
        "2. Each refresh token carries the family it was issued in.",
        "3. The access token lifetime is down to fifteen minutes.",
        "",
        "Left to do: rotating a refresh token every time it is used,",
        "revoking the whole family when an old one is replayed,",
        "migrating the sessions already stored, and the load test."
      ),
      "",
      ...said(
        "Nothing is blocked. The auth rail is running the rotation item",
        "now, and the session store question is waiting on you on the",
        "session store card."
      ),
      ""
    ) + COMPOSER,
    { kind: "composer" }
  );
}

function atlasAuth(): DemoTerminal {
  return agent(
    rows(
      `${DIM}> Rotate refresh tokens on use${OFF}`,
      "",
      ...ran("Read(src/auth/refresh.ts)", "Read 142 lines"),
      ...ran("Read(src/auth/tokens.ts)", "Read 88 lines"),
      ...ran("Grep(\"issueRefreshToken\", src/)", "Found 4 files"),
      "",
      ...said(
        "The refresh handler issues a new access token but hands back the",
        "same refresh token, so a stolen one stays good for thirty days.",
        "Rotating it means three changes:",
        "",
        "1. issue a fresh refresh token on every refresh,",
        "2. mark the old one used, in the same transaction,",
        "3. keep the family id, so reuse can be caught later."
      ),
      "",
      ...ran("Update(src/auth/refresh.ts)", "Updated with 31 additions and 9 removals"),
      ...ran("Update(src/auth/tokens.ts)", "Updated with 12 additions and 2 removals"),
      ...ran("Write(src/auth/refresh.test.ts)", "Wrote 96 lines"),
      ...ran("Bash(npm test -- src/auth)", "Tests: 2 failed, 41 passed"),
      "",
      ...said(
        "Two tests still expect the old token back. They were asserting",
        "the bug, so I am changing them to expect a new token and the old",
        "one marked used."
      ),
      "",
      ...ran("Update(src/auth/refresh.test.ts)", "Updated with 8 additions and 6 removals"),
      ...ran("Bash(npm test -- src/auth)", "Tests: 43 passed"),
      "",
      ...said("Green. Now the concurrent case: two refreshes racing with the same token."),
      "",
      working("Rotating refresh tokens on use", "2m 14s")
    ),
    { kind: "working" }
  );
}

/// The session store question, as the agent asks it.
export function storeMenu(): string {
  return rows(
    "",
    ...said(
      "Sessions need a store that expires them on its own and survives",
      "a deploy. Two fit what this service already runs. Which should it be?"
    ),
    "",
    ` ${BOLD}❯${OFF} 1. Redis — expiry built in, a new service`,
    "   2. Postgres — deployed, needs a sweeper",
    "   3. Type something else",
    "",
    `${DIM} Enter to select · Esc to cancel${OFF}`
  );
}

export const STORE_MENU: AgentAsk = {
  kind: "menu",
  choices: [
    {
      reply: rows(
        "",
        ...said("Redis it is. Adding the client and a compose service for local runs."),
        "",
        working("Writing the Redis session store", "3s")
      ),
      then: "working",
    },
    {
      reply: rows(
        "",
        ...said("Postgres it is. Adding a sessions table and a sweeper job."),
        "",
        working("Writing the Postgres session store", "3s")
      ),
      then: "working",
    },
    { reply: rows("", ...said("Tell me which, and why.")), then: "composer" },
  ],
};

/// The option the demo's activity plays the human choosing AT THE DESK:
/// Postgres.
export const STORE_ANSWERED_AT_DESK = 2;

function atlasStore(): DemoTerminal {
  return agent(
    rows(
      `${DIM}> Pick the session store${OFF}`,
      "",
      ...ran("Read(docs/architecture.md)", "Read 210 lines"),
      ...ran("Read(deploy/compose.yml)", "Read 47 lines"),
      ...ran("Bash(grep -rn \"sessions\" src/ | wc -l)", "38"),
      "",
      ...said(
        "Sessions are kept in memory today, which is why every deploy logs",
        "everyone out. The token refresh work needs them to survive a",
        "restart and to expire on their own after thirty days idle."
      ),
      "",
      ...said(
        "Redis would expire them for free (a TTL per key) but it is a new",
        "service in production. Postgres is already there; expiry would",
        "be a sweeper job every few minutes, and a query per request."
      )
    ) + storeMenu(),
    STORE_MENU
  );
}

function atlasBilling(): DemoTerminal {
  return agent(
    rows(
      `${DIM}> Invoice PDF rendering${OFF}`,
      "",
      ...ran("Read(services/billing/src/invoice.ts)", "Read 176 lines"),
      ...ran("Bash(npm run render-fixtures)", "Rendered 40 invoices"),
      ...ran("Bash(npm test -- invoice)", "Tests: 18 passed"),
      "",
      ...said(
        "The PDF now renders from the same template as the HTML invoice,",
        "and the totals match the HTML to the cent on all 40 fixtures."
      ),
      "",
      ...said(
        "One thing before the last checklist item: should the dates on the",
        "PDF follow the customer's locale, or always be ISO 8601?"
      ),
      ""
    ) + COMPOSER,
    { kind: "composer" },
    "Dates will follow what you said: “{text}”. The last item is done and all 3 are ticked."
  );
}

// ---- field-notes ------------------------------------------------------

function notesSync(): DemoTerminal {
  return agent(
    rows(
      `${DIM}> Offline sync${OFF}`,
      "",
      ...ran("Read(src/sync/journal.ts)", "Read 231 lines"),
      ...ran("Read(src/sync/merge.ts)", "Read 94 lines"),
      "",
      ...said(
        "Two devices editing one note offline each replay their journal on",
        "reconnect, and the second replay overwrites the first. Merging by",
        "paragraph keeps both unless the same paragraph changed on both."
      ),
      "",
      ...ran("Write(src/sync/paragraphs.ts)", "Wrote 118 lines"),
      ...ran("Update(src/sync/merge.ts)", "Updated with 44 additions and 17 removals"),
      "",
      working("Merging conflicting edits by paragraph", "1m 12s")
    ),
    { kind: "working" }
  );
}

/// The permission the offline-sync agent stops to ask for, in the
/// project at `root`.
export function notesPermission(root: string): string {
  return rows(
    "",
    ...ran("Bash(rm -rf .cache/sync-journal)", "Waiting for permission…"),
    "",
    ` ${BOLD}Bash command${OFF}`,
    "",
    "   rm -rf .cache/sync-journal",
    `   ${DIM}Clears the stale journal first${OFF}`,
    "",
    " Do you want to proceed?",
    ` ${BOLD}❯${OFF} 1. Yes`,
    `   2. Yes, and don't ask again for rm commands in ${root}`,
    "   3. No, and tell Claude what to do differently (esc)"
  );
}

const PERMISSION_GRANTED = rows(
  `  ${DIM}⎿  (No output)${OFF}`,
  "",
  working("Running the merge tests", "4s")
);

export const NOTES_PERMISSION: AgentAsk = {
  kind: "menu",
  choices: [
    { reply: PERMISSION_GRANTED, then: "working" },
    { reply: PERMISSION_GRANTED, then: "working" },
    { reply: rows("", ...said("I won't remove it. What should I do instead?")), then: "composer" },
  ],
};

// ---- Scratchpad -------------------------------------------------------

function scratchShell(home: string): DemoTerminal {
  return {
    output:
      rows(
        `${DIM}Last login: Tue Sep 29 18:02:11 on ttys004${OFF}`,
        `${prompt("~")}ls code`,
        "atlas-api    field-notes",
        `${prompt("~")}cd code/atlas-api`,
        `${prompt("atlas-api")}git log --oneline -3`,
        "4f1c2a9 feat(auth): keep the token family",
        "b87e310 test(auth): cover a replayed token",
        "19d0c44 chore: bump the OpenAPI generator",
        `${prompt("atlas-api")}cd`
      ) + prompt("~"),
    program: { kind: "shell", cwd: home, line: "" },
  };
}

/// Every sample session's terminal, as the demo starts. The home folder
/// is handed in rather than imported: the sample data that knows it is
/// also what calls this.
export function sampleTerminals(home: string): Record<string, DemoTerminal> {
  return {
    "s-atlas-main": atlasAgent(),
    "s-atlas-auth": atlasAuth(),
    "s-atlas-store": atlasStore(),
    "s-atlas-billing": atlasBilling(),
    "s-notes-sync": notesSync(),
    "s-scratch": scratchShell(home),
  };
}
