---
kind: task
title: "[sec] Adopt writes hidden memory-card text the human never saw into gavin's instruction block"
status: To Do
priority: low
complexity: simple
---
Fix a low-severity finding from the 2026-10-15 security audit (run-1). Fingerprint: `app/src/lib/cards/memoryCard.ts:adoptMemory:raw-fact-not-bound-to-rendered-approval`.

Full record: `findings.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

The card modal shows a memory card's body only as HTML rendered by marked and cleaned by DOMPurify. The 'Adopt into CLAUDE.md' button calls adoptMemory. That function re-reads the card file and writes the card's raw first line, plus its Why line, verbatim under '### Learned' inside gavin's '<!-- gavin:start -->' block. parseMemoryCard accepts all of these inside the 300-character fact and the 500-character Why:
- inline HTML comments
- display:none spans
- invisible Unicode tag characters
- the '<!-- gavin:end -->' marker

The rendered preview hides all of them. A memory card the human did not write can therefore show a harmless fact. When the human presses Adopt, it stores text the human never saw in the instructions file that every later agent session in the workspace loads. gavin_search_memories then serves that text as a fact 'the human has adopted'.

The new access is narrower than the hunter stated. These authors gain nothing, because they can already write that file or the same Learned section directly, with no click:
- an agent (AD-4)
- a Device (write_file_for_editor is Allowed)
- a collaborator whose commits the human pulls
- a cloned repository whose root tracks CLAUDE.md, AGENTS.md or GEMINI.md (read_learned serves those files' Learned sections as adopted)

The case that does cross a boundary is a memory card inside a nested .gavin context under the root, such as a vendored subtree or submodule. Its author cannot otherwise write the root's instructions file. One click on content the human did not read lifts that author's hidden text to workspace-wide, durable, 'human-adopted' instructions. AD-3 does not accept this pattern. The first-run review gate, gavin's other control for card content the human has not read, shows raw bytes and binds a digest, but it exempts notes. Adopt has no equivalent.

## Root cause

adoptMemory (memoryCard.ts:264-301) neither shows nor binds the exact bullet it writes.
- The approval surface is rendered HTML (CardDetailModal.svelte:219-221, shown with {@html} at 1566).
- What gets written is parseMemoryCard's raw trimmed line (memoryCard.ts:135-151), re-read when the button is clicked (274). It is never compared with what the modal showed.
- parseMemoryCard never refuses markup, marker strings or invisible code points. Its only refusals are empty, no-fact, multi-fact and too-long (79).
- appendLearned (225-249) then splices the bullet into the marker block. It locates the block by the first indexOf of the start and end markers.

## The invariant to enforce

The human's Adopt click should authorize exactly the bytes that get written:
- The bullet should appear as plain text in a confirmation dialog.
- It should be written only if the card file still matches what was shown.
- A fact or Why containing HTML markup, either gavin marker string, or invisible or bidi format characters should be refused, like the existing one-fact refusals.

## Trace (lines as of 2026-10-16; re-read before editing)

- `app/src/lib/cards/CardDetailModal.svelte:1821` (Adopt button onclick -> handleAdopt): The human presses 'Adopt into <file>' on a note labelled memory. The only view of the body they had was the rendered preview (bodyHtml at 219-221, shown with {@html} at 1566). The modal has no raw view of a note.
- `app/src/lib/cards/CardDetailModal.svelte:947` (handleAdopt): Calls adoptMemory(card, `${adoptRoot}/${instructionsFile}`, done.name) with only the card id. The content the human saw is neither passed nor compared. There is no confirmation step.
- `app/src/lib/cards/memoryCard.ts:274` (adoptMemory): Re-reads the raw card file with readFileForViewer and passes the raw text to parseMemoryCard.
- `app/src/lib/cards/memoryCard.ts:147` (parseMemoryCard): The fact is the raw trimmed first body line, with only a trailing topics suffix removed. HTML comments, spans, marker strings and invisible code points stay in. Only line count and length are checked (143-150).
- `app/src/lib/cards/memoryCard.ts:159` (memoryBullet): Builds '- <fact>', plus '  Why: <why>' when there is one, with no escaping and no record of where the card came from.
- `app/src/lib/cards/memoryCard.ts:245` (appendLearned): Splices the bullet under '### Learned' inside the marker block, which it finds by the first indexOf of the start and end markers (226-227).
- `app/src/lib/cards/memoryCard.ts:294` (adoptMemory): writeFileForEditor replaces the instructions file (CLAUDE.md, AGENTS.md and so on) with the edited content. Two readers carry it on:
- agent_setup.rs learned_section (2183) keeps it byte for byte across every setup merge (2207-2212).
- memory_index.rs learned_in_file (229) and read_learned (263) feed SearchMemories (server.rs:6717) and so gavin_search_memories.

## Fix

Bind the approval to the bytes that get written.
1. Refuse a fact or Why that contains HTML markup, either gavin marker string, or invisible or bidi format characters, as a new MemoryRefusal.
2. In handleAdopt, show memoryBullet(memory) as plain text in an askConfirm block (danger, with the button named for the action). Pass the card content the modal showed into adoptMemory, and refuse if the re-read differs.
3. Optionally, record the card's path in the bullet so its origin survives the move.

Regression tests: a card whose fact or Why holds '<!-- x -->', '<span style="display:none">', '<!-- gavin:end -->' or U+E0041 is refused, and adoptMemory given a stale shown snapshot writes nothing.

`app/src/lib/cards/memoryCard.ts`, as a sketch only:

```
export type MemoryRefusal = "empty" | "no-fact" | "multi-fact" | "too-long" | "markup";
// Text the rendered preview can hide must not reach the instructions file.
const HIDDEN_RE = /<[!/?A-Za-z]|gavin:(?:start|end)|[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]|[\u{E0000}-\u{E007F}]/u;
// in REFUSALS:
  markup: () => "A memory is plain text; this one holds HTML, a gavin marker or invisible characters the card preview does not show.",
// in parseMemoryCard, after fact/why are computed:
  if (HIDDEN_RE.test(fact) || (why !== null && HIDDEN_RE.test(why))) return refuse("markup");

// adoptMemory binds to what the human saw:
export async function adoptMemory(card: Pick<CardView, "id">, instructionsPath: string, doneStatus: string, shownContent: string): Promise<AdoptResult> {
  ...
  const cardFile = await backend.readFileForViewer(card.id);
  if (!cardFile.exists) return { error: "The card's file is gone." };
  if (cardFile.content !== shownContent) return { error: "This card changed since it was shown. Read it again before adopting." };
  ...
```

`app/src/lib/cards/CardDetailModal.svelte`, as a sketch only:

```
async function handleAdopt(): Promise<void> {
  errorMessage = null;
  if (adoptRoot === null || done === null || content === null) return;
  const shown = content;
  const memory = parseMemoryCard(shown);
  if ("refuse" in memory) { errorMessage = memory.error; return; }
  const ok = await askConfirm({
    title: `Adopt into ${instructionsFile}?`,
    lines: ["Every future agent in this workspace will read exactly this text:"],
    block: { label: `Appended under ### Learned:`, text: memoryBullet(memory) },
    confirmLabel: `Adopt into ${instructionsFile}`,
    cancelLabel: "Keep as a card",
    danger: true,
  });
  if (!ok) return;
  adopting = true;
  try {
    const result = await adoptMemory(card, `${adoptRoot}/${instructionsFile}`, done.name, shown);
    ...
```

## Done when

- Adopt shows the exact bullet as plain text and writes only if the card still matches what the modal showed.
- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched, and you commit only your own files.
