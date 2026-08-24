# Card nesting & promotion — smoke fixture

The **"Nesting & promotion"** section of the in-app smoke checklist
(`app/src/lib/smokeChecklist.ts`) has two halves:

- the **pointer half** — the drags themselves, auto-expand, drop-hold,
  Escape-cancel, and the detail-modal surfaces. A human has to do these in the
  real window; the app is a native WKWebView, not a driveable browser.
- the **file half** — what each interaction is supposed to write to disk.
  `nesting_smoke.py` does these, and does them against a real daemon.

## Running it

```sh
cargo build -p gavin-daemon -p gavin-mcp
python3 test-fixtures/card-nesting/nesting_smoke.py
```

**It is safe to run while the app is up.** `protocol::socket_path()` derives
from `$HOME` alone, so the script starts its own daemon under a temp `HOME` on
its own socket, against a temp fixture workspace, and removes both afterwards.
It never speaks to the daemon the running app owns — which matters in this
repo, where several agent sessions share one worktree and one daemon.

Pass `--target DIR` to point at a non-default cargo target directory (useful
when verifying a detached worktree without disturbing the main tree's build).

## What it covers

| Smoke item | Covered here | Still needs a human |
|---|---|---|
| `checklist-toggle` | tick, untick, indentation preserved; a drifted `expected_text` is refused and **writes nothing** | the modal showing the retry message |
| `promote-ui` | child written (`kind: task`, `parent:`, no `status:`), line rewritten to a link, slugged name; missing and ambiguous items refused with no child created | the Promote button |
| `promote-mcp` | **fully covered** — `tools/list` carries `gavin_promote_task` with the specified description and `{plan_path, item}` schema, and a real `tools/call` performs the promotion | — |
| `nest-drag-in` | `parent:` written, `status:` line removed | the drag, auto-expand, placeholder |
| `nest-drag-out` | `status:` written, `parent:` retained | the drag, chip persistence |
| `unparent` | `parent:` removed, `status:` retained | the card landing in column one |
| `nest-autoexpand`, `nest-note-refuses` | — (logic is unit-covered in `pointerDrag.test.ts`) | the visible behaviour |

The script asserts the daemon reports the `PROTOCOL_VERSION` of the tree it is
run from, so a stale binary fails loudly instead of quietly testing old code.

## The human half

`GUI-PASS.md` is the pointer half written out as an ordered ~10-minute pass,
and `seed_gui_fixture.py` builds a throwaway workspace with exactly the card
shapes it needs, so the pass runs on fixture cards instead of real ones:

```sh
python3 test-fixtures/card-nesting/seed_gui_fixture.py          # seed
python3 test-fixtures/card-nesting/seed_gui_fixture.py --show   # what hit disk
python3 test-fixtures/card-nesting/seed_gui_fixture.py --reset  # start over
```

`--show` prints each card's kind and whether it is nested or free-standing, so
every step's file effect can be confirmed without reading frontmatter by hand.
It writes only inside its own `--dir` and never speaks to a daemon.

## Worked walkthrough

The shape `seed_gui_fixture.py` lays down, and what each card is for:

```
<ws>/.gavin-root/plans/demo-plan.md      # plan; one item to tick, one to promote
<ws>/.gavin-root/plans/nested-child.md   # task, parent + no status -> starts nested
<ws>/.gavin-root/plans/free-task.md      # task with a status -> free-standing
<ws>/.gavin-root/plans/plain-note.md     # note   -> must refuse to nest
<ws>/.gavin-root/plans/other-plan.md     # plan   -> must refuse to nest
```

Drag `free-task` onto `demo-plan`'s middle band → it nests (`parent:` appears,
`status:` disappears). Drag it back out to a column → `status:` returns,
`parent:` stays. Open `demo-plan`'s detail and promote "Promote me from the
detail modal" → a nested `promote-me-from-the-detail-modal.md` appears and the
line becomes a link. `GUI-PASS.md` walks all of it in order.
