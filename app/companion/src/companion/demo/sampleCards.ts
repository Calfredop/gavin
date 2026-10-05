// The Demo Workstation's cards and PRDs, as the files a scan reads them
// from (cardFiles.ts).
//
// Chosen so the board and the card have every case to draw: a plan with
// nested tasks and a checklist part-way done, a task an agent is waiting
// on a human's decision about, a human test to pass or fail, a note, a
// card carrying an attachment, a status no column matches, a second
// context, and a finished plan in `done/`.
import { markerOf, newCardText, type NewCard } from "$companion/demo/cardFiles";

interface SampleCard extends NewCard {
  fileName: string;
}

interface SampleContext {
  folderPath: string;
  kind: "root" | "context";
  cards: SampleCard[];
}

function atlasContexts(root: string): SampleContext[] {
  return [
    {
      folderPath: root,
      kind: "root",
      cards: [
        {
          fileName: "token-refresh.md",
          title: "Token refresh rework",
          kind: "plan",
          status: "In Progress",
          priority: "high",
          order: 1,
          labels: "backend",
          complexity: "complex",
          body: [
            "Refresh tokens are long-lived and never rotate, so one leaked token is a session for as long as the account exists. Rotate on every use and treat a reused token as theft.",
            "",
            "- [x] Write down the threat model",
            "- [x] Add a token family id to the refresh table",
            "- [x] Issue a new refresh token on every refresh",
            "- [ ] Revoke the whole family when a spent token comes back",
            "- [ ] Migrate the sessions already stored",
            "- [ ] Load-test the refresh endpoint",
            "- [ ] Update the client SDK's retry rules",
          ].join("\n"),
        },
        {
          fileName: "rotate-on-use.md",
          title: "Rotate refresh tokens on use",
          kind: "task",
          status: null,
          parent: "token-refresh.md",
          order: 1,
          body: "Issue a fresh refresh token on every call to POST /v2/auth/refresh and retire the one presented.",
        },
        {
          fileName: "revoke-family.md",
          title: "Revoke the token family on reuse",
          kind: "task",
          status: null,
          parent: "token-refresh.md",
          order: 2,
          body: "When a retired refresh token is presented again, revoke every token in its family and log the event.",
        },
        {
          fileName: "migrate-sessions.md",
          title: "Migrate stored sessions",
          kind: "task",
          status: null,
          parent: "token-refresh.md",
          order: 3,
          body: "Give every stored session a family id so the revocation rule covers sessions that predate it.",
        },
        {
          fileName: "session-store.md",
          title: "Pick the session store",
          kind: "task",
          status: "In Progress",
          priority: "medium",
          order: 2,
          labels: "backend",
          body: [
            "Sessions live in process memory today, so every deploy logs everyone out. Compare Redis and Postgres for the session store: latency at p99, what a failover loses, and what we already run in production.",
            "",
            "- [ ] Decision: Redis or Postgres for the session store?",
            "  Options: A) Redis B) Postgres",
          ].join("\n"),
        },
        {
          fileName: "flaky-expiry-test.md",
          title: "Fix the flaky session-expiry test",
          kind: "task",
          status: "To Do",
          priority: "urgent",
          order: 1,
          labels: "bug",
          complexity: "simple",
          body: "`session_expires_after_idle` fails about one run in twenty on CI. It sleeps for the idle window and races the sweeper. Inject the clock instead of sleeping, and make the sweeper run on demand in tests.",
        },
        {
          fileName: "login-rate-limit.md",
          title: "Rate-limit the login endpoint",
          kind: "task",
          status: "To Do",
          priority: "medium",
          order: 2,
          labels: "backend, security",
          complexity: "moderate",
          attachments: "docs/rate-limits.md",
          body: "Apply the limits in the attached note to POST /v2/auth/login, per account and per address, and return 429 with Retry-After.",
        },
        {
          fileName: "empty-state.md",
          title: "Ask design about the empty state",
          kind: "note",
          status: "To Do",
          order: 3,
          body: "What does the accounts page show a brand-new organisation with nobody in it?",
        },
        {
          fileName: "oauth-upgrade.md",
          title: "Upgrade the OAuth library",
          kind: "task",
          status: "Blocked",
          priority: "low",
          labels: "backend",
          body: "Move to the next major version once it supports PKCE for confidential clients. Blocked on the upstream release.",
        },
        {
          fileName: "openapi-accounts.md",
          title: "OpenAPI spec for /v2/accounts",
          kind: "task",
          status: "Review",
          labels: "docs",
          body: [
            "Document every /v2/accounts route in the OpenAPI spec.",
            "",
            "- [x] List, create and read",
            "- [x] Update and delete",
            "- [x] Error responses",
            "- [x] Examples for every route",
          ].join("\n"),
        },
        {
          fileName: "audit-log-export.md",
          title: "Audit log export",
          kind: "plan",
          status: "Done",
          labels: "backend",
          body: [
            "Let an administrator export the audit log as CSV.",
            "",
            "- [x] Query the log by date range",
            "- [x] Stream the CSV",
            "- [x] Redact secrets in event payloads",
            "- [x] Admin-only route",
            "- [x] Link from the settings page",
            "- [x] Document the columns",
          ].join("\n"),
        },
      ],
    },
    {
      folderPath: `${root}/services/billing`,
      kind: "context",
      cards: [
        {
          fileName: "invoice-pdf.md",
          title: "Invoice PDF rendering",
          kind: "task",
          status: "In Progress",
          priority: "medium",
          labels: "billing",
          body: [
            "Render invoices as PDF on the server so every client gets the same file.",
            "",
            "- [x] Render the line items",
            "- [ ] Totals and the tax block",
            "- [ ] Human test: Open a sample invoice PDF on a phone and check the totals are legible",
          ].join("\n"),
        },
        {
          fileName: "proration.md",
          title: "Proration on plan change",
          kind: "task",
          status: "To Do",
          labels: "billing",
          body: "Charge or credit the difference, to the day, when a customer changes plan mid-cycle.",
        },
      ],
    },
  ];
}

function notesContexts(root: string): SampleContext[] {
  return [
    {
      folderPath: root,
      kind: "root",
      cards: [
        {
          fileName: "offline-sync.md",
          title: "Offline sync",
          kind: "plan",
          status: "In Progress",
          priority: "high",
          complexity: "intricate",
          body: [
            "Notes written without a connection sync when one comes back, and two devices editing the same note never lose a paragraph.",
            "",
            "- [x] Queue edits locally",
            "- [x] Replay the queue on reconnect",
            "- [ ] Merge conflicting edits by paragraph",
            "- [ ] Show what was merged",
            "- [ ] Survive an app kill mid-sync",
          ].join("\n"),
        },
        {
          fileName: "conflict-merge.md",
          title: "Merge conflicting edits by paragraph",
          kind: "task",
          status: null,
          parent: "offline-sync.md",
          order: 1,
          body: "Three-way merge each paragraph against the last synced version; keep both when both changed.",
        },
        {
          fileName: "photo-attachments.md",
          title: "Photo attachments",
          kind: "task",
          status: "To Do",
          labels: "ui",
          body: "Attach photos to a note from the camera or the library, stored beside the note.",
        },
        {
          fileName: "markdown-export.md",
          title: "Export a notebook to Markdown",
          kind: "task",
          status: "Done",
          body: ["Export a whole notebook as a folder of Markdown files.", "", "- [x] One file per note", "- [x] Photos alongside"].join(
            "\n"
          ),
        },
      ],
    },
  ];
}

function cardPath(context: SampleContext, card: SampleCard): string {
  const plans = `${context.folderPath}/${markerOf(context.kind)}/plans`;
  return card.status === "Done" ? `${plans}/done/${card.fileName}` : `${plans}/${card.fileName}`;
}

/// The two projects' PRDs, at the path a workspace that never chose one
/// reads (`DEFAULT_PRD_PATH`).
function prds(roots: { atlas: string; notes: string }): Record<string, string> {
  return {
    [`${roots.atlas}/.gavin-root/PRD.md`]: [
      "# atlas-api",
      "",
      "The accounts and authentication API behind every Atlas client.",
      "",
      "## Priorities",
      "",
      "1. **Sessions that survive a deploy.** Nobody is logged out by a release.",
      "2. **Tokens that cannot be replayed.** A stolen refresh token is caught on its first reuse.",
      "3. **Billing that explains itself.** Every invoice line traces back to a plan and a date.",
      "",
      "## Out of scope",
      "",
      "- Single sign-on for customers' own identity providers (next half).",
      "",
    ].join("\n"),
    [`${roots.notes}/.gavin-root/PRD.md`]: [
      "# field-notes",
      "",
      "A notebook for work away from a desk: written offline, synced later, never lost.",
      "",
      "## Priorities",
      "",
      "1. **Offline first.** Every action works with no connection.",
      "2. **No lost paragraphs.** Two devices editing one note both keep their words.",
      "",
    ].join("\n"),
  };
}

/// Every file the demo's boards are read from: the cards and each
/// project's PRD. What a card points an agent at (`docs/rate-limits.md`)
/// is a project file, tracked in its repository (sampleProjects.ts).
export function sampleCardFiles(roots: { atlas: string; notes: string }): Record<string, string> {
  const files: Record<string, string> = { ...prds(roots) };
  for (const context of [...atlasContexts(roots.atlas), ...notesContexts(roots.notes)]) {
    for (const card of context.cards) files[cardPath(context, card)] = newCardText(card);
  }
  return files;
}
