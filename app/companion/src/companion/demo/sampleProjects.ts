// The Demo Workstation's two projects as files on disk and as Git
// repositories: what the Files surface browses and the Git surface
// commits.
//
// Chosen, like the boards in sampleData.ts, so each surface has every
// case to draw. atlas-api is mid-task -- the agent on "Rotate refresh
// tokens on use" has a change staged, another not yet, and a new file
// untracked -- with a commit not yet pushed, a finished feature branch
// waiting to be merged, and a branch that exists only on origin.
// field-notes is clean and in step with its remote. Everything is short
// enough to read on a phone.
import type { DemoRepo, Tree } from "$companion/demo/repo";

const AUTHOR = { name: "Demo Human", email: "human@demo.invalid" };

// ---- atlas-api -------------------------------------------------------------

const ATLAS_README = `# atlas-api

The accounts and authentication API behind Atlas.

## Running it

    npm install
    npm run dev

The server listens on port 8080. Tokens are signed with the key in
\`ATLAS_SIGNING_KEY\`.

## Layout

- \`src/auth\` — tokens, sessions and the login flow
- \`src/routes\` — the HTTP routes
- \`services/billing\` — invoices, which will become a service of its own
`;

const ATLAS_PACKAGE = `{
  "name": "atlas-api",
  "version": "0.9.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "test": "vitest run"
  }
}
`;

const ATLAS_GITIGNORE = `node_modules/
dist/
.env
`;

const SERVER_V0 = `import { createServer } from "node:http";
import { accounts } from "./routes/accounts.js";
import { refresh } from "./auth/tokens.js";

const routes = { "/v2/accounts": accounts, "/v2/token/refresh": refresh };

createServer((req, res) => {
  const route = routes[req.url ?? ""];
  if (!route) {
    res.writeHead(404).end();
    return;
  }
  route(req, res);
}).listen(8080);
`;

const SERVER_RATE_LIMITED = `import { createServer } from "node:http";
import { accounts } from "./routes/accounts.js";
import { refresh } from "./auth/tokens.js";
import { limitLogins } from "./auth/rateLimit.js";

const routes = { "/v2/accounts": accounts, "/v2/token/refresh": limitLogins(refresh) };

createServer((req, res) => {
  const route = routes[req.url ?? ""];
  if (!route) {
    res.writeHead(404).end();
    return;
  }
  route(req, res);
}).listen(8080);
`;

const TOKENS_V0 = `import { sign, verify } from "./crypto.js";

export interface TokenPair {
  access: string;
  refresh: string;
}

export function issue(userId: string): TokenPair {
  return {
    access: sign({ sub: userId, kind: "access" }, "15m"),
    refresh: sign({ sub: userId, kind: "refresh" }, "30d"),
  };
}
`;

const TOKENS_V1 = `import { sign, verify } from "./crypto.js";

export interface TokenPair {
  access: string;
  refresh: string;
}

export function issue(userId: string): TokenPair {
  return {
    access: sign({ sub: userId, kind: "access" }, "15m"),
    refresh: sign({ sub: userId, kind: "refresh" }, "30d"),
  };
}

export function refresh(token: string): TokenPair {
  const claims = verify(token);
  if (claims.kind !== "refresh") throw new Error("not a refresh token");
  return issue(claims.sub);
}
`;

// The agent's change in progress: a refresh token is used once.
const TOKENS_ROTATING = `import { sign, verify } from "./crypto.js";
import { markUsed, wasUsed } from "./rotation.js";

export interface TokenPair {
  access: string;
  refresh: string;
}

export function issue(userId: string): TokenPair {
  return {
    access: sign({ sub: userId, kind: "access" }, "15m"),
    refresh: sign({ sub: userId, kind: "refresh" }, "30d"),
  };
}

export function refresh(token: string): TokenPair {
  const claims = verify(token);
  if (claims.kind !== "refresh") throw new Error("not a refresh token");
  if (wasUsed(claims.jti)) throw new Error("refresh token reused");
  markUsed(claims.jti);
  return issue(claims.sub);
}
`;

const ROTATION = `// Refresh tokens are single-use: the first refresh spends one, and a
// second use of the same token means it was stolen.
const used = new Set<string>();

export function wasUsed(jti: string): boolean {
  return used.has(jti);
}

export function markUsed(jti: string): void {
  used.add(jti);
}
`;

const SESSION = `export interface Session {
  id: string;
  userId: string;
  expiresAt: number;
}

export function isExpired(session: Session, now = Date.now()): boolean {
  return session.expiresAt <= now;
}
`;

const ACCOUNTS = `import type { IncomingMessage, ServerResponse } from "node:http";

export function accounts(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ accounts: [] }));
}
`;

const TOKENS_TEST_V0 = `import { describe, expect, it } from "vitest";
import { issue } from "../src/auth/tokens.js";

describe("tokens", () => {
  it("issues an access and a refresh token", () => {
    const pair = issue("u1");
    expect(pair.access).not.toBe(pair.refresh);
  });
});
`;

const TOKENS_TEST_ROTATING = `import { describe, expect, it } from "vitest";
import { issue, refresh } from "../src/auth/tokens.js";

describe("tokens", () => {
  it("issues an access and a refresh token", () => {
    const pair = issue("u1");
    expect(pair.access).not.toBe(pair.refresh);
  });

  it("refuses a refresh token used twice", () => {
    const pair = issue("u1");
    refresh(pair.refresh);
    expect(() => refresh(pair.refresh)).toThrow("reused");
  });
});
`;

const SESSION_TEST = `import { describe, expect, it } from "vitest";
import { isExpired } from "../src/auth/session.js";

describe("session expiry", () => {
  it("is expired exactly at its deadline", () => {
    expect(isExpired({ id: "s", userId: "u", expiresAt: 1000 }, 1000)).toBe(true);
  });
});
`;

const RATE_LIMIT = `import type { IncomingMessage, ServerResponse } from "node:http";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;
const attempts = new Map<string, number[]>();

export function limitLogins(next: Handler): Handler {
  return (req, res) => {
    const who = req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    const recent = (attempts.get(who) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= MAX_ATTEMPTS) {
      res.writeHead(429).end();
      return;
    }
    attempts.set(who, [...recent, now]);
    next(req, res);
  };
}
`;

const RATE_LIMITS_DOC = `# Rate limits

| endpoint | limit |
|---|---|
| \`POST /v2/token/refresh\` | 5 a minute per address |
| \`GET /v2/accounts\` | 60 a minute per token |

A client over its limit gets \`429 Too Many Requests\` and should wait
for the window to pass rather than retry at once.
`;

const BILLING_README = `# billing

Invoices for Atlas accounts. Rendering invoices as PDF is in progress.
`;

const INVOICE = `export interface Invoice {
  id: string;
  accountId: string;
  lines: { description: string; cents: number }[];
}

export function total(invoice: Invoice): number {
  return invoice.lines.reduce((sum, line) => sum + line.cents, 0);
}
`;

// Bytes the demo holds as a stand-in: a picture the phone cannot show.
const DIAGRAM = "\u0089PNG\r\n\u001a\n(architecture diagram)";

const ATLAS_START: Tree = {
  ".gitignore": ATLAS_GITIGNORE,
  "README.md": ATLAS_README,
  "package.json": ATLAS_PACKAGE,
  "src/server.ts": SERVER_V0,
  "src/auth/tokens.ts": TOKENS_V0,
  "src/auth/session.ts": SESSION,
  "src/routes/accounts.ts": ACCOUNTS,
  "test/tokens.test.ts": TOKENS_TEST_V0,
  "docs/architecture.png": DIAGRAM,
  "services/billing/README.md": BILLING_README,
  "services/billing/invoice.ts": INVOICE,
};

const ATLAS_REFRESH: Tree = { ...ATLAS_START, "src/auth/tokens.ts": TOKENS_V1 };
const ATLAS_DOCUMENTED: Tree = { ...ATLAS_REFRESH, "docs/rate-limits.md": RATE_LIMITS_DOC };
const ATLAS_RATE_LIMITED: Tree = {
  ...ATLAS_REFRESH,
  "src/server.ts": SERVER_RATE_LIMITED,
  "src/auth/rateLimit.ts": RATE_LIMIT,
};
const ATLAS_EXPIRY_FIX: Tree = { ...ATLAS_REFRESH, "test/session.test.ts": SESSION_TEST };

/// The ids atlas-api's history is written with. Fixed, so a suite can
/// name a commit; the demo's own new commits get ids of the same shape.
export const ATLAS_COMMITS = {
  start: "3f1c2a8e5b7d4c6e9a0b1d2f3e4c5a6b7d8e9f01",
  refresh: "8b2d4f6a1c3e5b7d9f0a2c4e6b8d0f1a3c5e7b92",
  documented: "c47e19ab2d3f5a6b8c9d0e1f2a3b4c5d6e7f8a93",
  rateLimited: "e5a0b3c7d9f1a2b4c6d8e0f1a3b5c7d9e1f2a4b4",
  expiryFix: "1d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d15",
} as const;

function atlasRepo(root: string): DemoRepo {
  const c = ATLAS_COMMITS;
  return {
    root,
    author: AUTHOR,
    commits: {
      [c.start]: { sha: c.start, parents: [], message: "Start the accounts API", tree: ATLAS_START },
      [c.refresh]: {
        sha: c.refresh,
        parents: [c.start],
        message: "Add the token refresh endpoint",
        tree: ATLAS_REFRESH,
      },
      [c.documented]: {
        sha: c.documented,
        parents: [c.refresh],
        message: "Document the rate limits\n\nClients were retrying at once on a 429; say what to do instead.",
        tree: ATLAS_DOCUMENTED,
      },
      [c.rateLimited]: {
        sha: c.rateLimited,
        parents: [c.refresh],
        message: "Rate-limit the login endpoint",
        tree: ATLAS_RATE_LIMITED,
      },
      [c.expiryFix]: {
        sha: c.expiryFix,
        parents: [c.refresh],
        message: "Pin the session-expiry test to a fixed clock",
        tree: ATLAS_EXPIRY_FIX,
      },
    },
    branches: { main: c.documented, "feat/login-rate-limit": c.rateLimited },
    upstreams: { main: "origin/main", "feat/login-rate-limit": "origin/feat/login-rate-limit" },
    head: "main",
    // The test is staged; the change it tests is not, yet.
    index: { ...ATLAS_DOCUMENTED, "test/tokens.test.ts": TOKENS_TEST_ROTATING },
    remote: {
      name: "origin",
      url: "git@github.com:demo/atlas-api.git",
      // main is one commit ahead of origin: "Document the rate limits"
      // has not been pushed.
      branches: {
        main: c.refresh,
        "feat/login-rate-limit": c.rateLimited,
        "fix/session-expiry": c.expiryFix,
      },
    },
  };
}

function atlasWorkingTree(): Tree {
  return {
    ...ATLAS_DOCUMENTED,
    "src/auth/tokens.ts": TOKENS_ROTATING,
    "src/auth/rotation.ts": ROTATION,
    "test/tokens.test.ts": TOKENS_TEST_ROTATING,
  };
}

// ---- field-notes -------------------------------------------------------------

const NOTES_README = `# field-notes

A notebook that works without a signal and catches up when it has one.
`;

const NOTES_PACKAGE = `{
  "name": "field-notes",
  "version": "0.3.1",
  "private": true,
  "type": "module"
}
`;

const QUEUE = `export interface Edit {
  notebookId: string;
  paragraph: number;
  text: string;
  at: number;
}

const pending: Edit[] = [];

export function enqueue(edit: Edit): void {
  pending.push(edit);
}

export function drain(): Edit[] {
  return pending.splice(0);
}
`;

const MERGE = `import type { Edit } from "./queue.js";

// Two devices edited the same notebook while apart: the later edit to a
// paragraph wins, paragraph by paragraph.
export function mergeEdits(mine: Edit[], theirs: Edit[]): Edit[] {
  const latest = new Map<string, Edit>();
  for (const edit of [...mine, ...theirs]) {
    const key = \`\${edit.notebookId}:\${edit.paragraph}\`;
    const seen = latest.get(key);
    if (!seen || seen.at < edit.at) latest.set(key, edit);
  }
  return [...latest.values()];
}
`;

const OFFLINE_NOTE = `# Offline, 2026-09

- Edits queue locally and drain on reconnect.
- Two phones editing one paragraph: last writer wins, for now.
- Photos wait for wifi.
`;

const NOTES_START: Tree = {
  "README.md": NOTES_README,
  "package.json": NOTES_PACKAGE,
  "src/sync/queue.ts": QUEUE,
};
const NOTES_SYNCED: Tree = {
  ...NOTES_START,
  "src/sync/merge.ts": MERGE,
  "notes/2026-09-offline.md": OFFLINE_NOTE,
};

export const NOTES_COMMITS = {
  start: "5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a36",
  synced: "9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f47",
} as const;

function notesRepo(root: string): DemoRepo {
  const c = NOTES_COMMITS;
  return {
    root,
    author: AUTHOR,
    commits: {
      [c.start]: { sha: c.start, parents: [], message: "Start the notebook", tree: NOTES_START },
      [c.synced]: {
        sha: c.synced,
        parents: [c.start],
        message: "Queue edits while offline and merge them by paragraph",
        tree: NOTES_SYNCED,
      },
    },
    branches: { main: c.synced },
    upstreams: { main: "origin/main" },
    head: "main",
    index: { ...NOTES_SYNCED },
    remote: { name: "origin", url: "git@github.com:demo/field-notes.git", branches: { main: c.synced } },
  };
}

// ---- Both ---------------------------------------------------------------------

function underRoot(root: string, tree: Tree): Record<string, string> {
  return Object.fromEntries(Object.entries(tree).map(([path, content]) => [`${root}/${path}`, content]));
}

/// Where the two projects live. Handed in by sampleData.ts, which owns
/// the demo's paths.
export interface ProjectRoots {
  atlas: string;
  notes: string;
}

/// Every project file by absolute path: the demo's disk.
export function projectFiles(roots: ProjectRoots): Record<string, string> {
  return {
    ...underRoot(roots.atlas, atlasWorkingTree()),
    ...underRoot(roots.notes, NOTES_SYNCED),
  };
}

/// The repositories, by root.
export function sampleRepos(roots: ProjectRoots): Record<string, DemoRepo> {
  return { [roots.atlas]: atlasRepo(roots.atlas), [roots.notes]: notesRepo(roots.notes) };
}
