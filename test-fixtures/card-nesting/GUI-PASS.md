# Nesting & promotion — the human half

Everything in the "Nesting & promotion" smoke section that can be checked
without a person is checked by `nesting_smoke.py` (**28/28**, incl.
`promote-mcp` end to end). What is left is the pointer half — the drags,
auto-expand, the drop-hold, Escape-cancel — and the three detail-modal
surfaces. Those need a human in the real window: every board call goes through
Tauri `invoke`, so the app cannot be driven from a browser, and WKWebView
pointer capture is the one thing a synthetic harness must not be trusted with.

This is that pass, on throwaway cards, in the order that needs the fewest
re-seeds. **~10 minutes.**

## Setup

```sh
python3 test-fixtures/card-nesting/seed_gui_fixture.py        # or --reset
```

Open the printed directory in gavin. Board should show:

| Column | Cards |
|---|---|
| first column (`To Do`) | **Free task**, **Plain note**, **Other plan** |
| `In Progress` | **Demo plan** — with **Nested child** already nested inside |

After any step, `seed_gui_fixture.py --show` prints what actually hit disk —
each card's kind, and whether it is nested or free-standing. Run it whenever a
step's ✅ mentions a file effect. If a step goes wrong, `--reset` and carry on;
the steps below are independent apart from 6 → 7.

---

### 1. `nest-drag-in` — drag, auto-expand, placeholder

Drag **Free task** slowly onto the **middle** of the **Demo plan** card (the
band between 25% and 75% of its height) and *hold before releasing*.

✅ Demo plan **auto-expands** while targeted (this is `nest-autoexpand`)
✅ a **placeholder appears inside** its nested area
✅ **no placeholder in any column** — the card has left column flow
✅ release: the placeholder **holds through the write, no flash or jump**
✅ `--show` → `free-task.md … NESTED inside demo-plan.md`

### 2. Escape mid-nest-drag

Drag **Free task** (now nested) over Demo plan's middle band again, and press
**Escape before releasing**.

✅ drag cancels cleanly — card snaps back, no placeholder left behind
✅ Demo plan does not stay stuck expanded
✅ `--show` → unchanged from step 1

### 3. `nest-note-refuses` — notes and plans refuse

Drag **Plain note** onto Demo plan's middle band. Then the same with
**Other plan**.

✅ **no auto-expand**, **no nested placeholder** for either
✅ the middle band behaves as a **plain column slot** — the placeholder appears
   before/after Demo plan in the column
✅ `--show` → both still free-standing, neither gained a `parent`

### 4. `nest-drag-out` — free a nested child

Expand **Demo plan** and drag **Nested child** out into the first column.

✅ it lands as a free-standing card
✅ its **parent chip persists** on the card
✅ `--show` → `nested-child.md … free-standing in 'To Do' (still parented to demo-plan.md)`

Now drag it back onto Demo plan's middle band to re-nest it (needed by step 7).

✅ `--show` → `NESTED inside demo-plan.md` again

### 5. `checklist-toggle` — live tick, then the retry path

Open **Demo plan**'s detail modal.

Tick **"Tick me from the detail modal"**.

✅ the checkbox sticks and the modal's progress count moves
✅ `--show` → that line is `- [x]`, the nested `- [x] Nested done item` untouched

Now the drift path — the concurrent-agent case. **Note:** a single terminal
edit is *not* enough. The modal watches its own file (`file-changed` →
`read()`), so one `sed` is re-read and repaired well before you can click, and
the tick then succeeds against the fresh text. To land inside that window,
keep the file changing. **Leave the modal open** and run:

```sh
f=~/gavin-nesting-gui-fixture/.gavin-root/plans/demo-plan.md
for i in $(seq 60); do
  sed -i '' 's/Promote me from the detail modal/Promote me from the detail MODAL/' "$f"
  sleep 0.12
  sed -i '' 's/Promote me from the detail MODAL/Promote me from the detail modal/' "$f"
  sleep 0.12
done
```

While that runs, click the **"Promote me…"** checkbox a few times. The rescan
debounce is 150ms (`gavin.rs:1289 RESCAN_DEBOUNCE`), so roughly every other
click lands on text the modal has not caught up to yet.

✅ an inline **"File changed — checklist re-read, try again."** message
   appears (not a silent failure, and *not* the wrong line rewritten)
✅ the modal **re-reads** — the item's text updates under the message
✅ a click that lands outside the window just ticks normally; that is correct,
   not a flake
✅ after the loop ends, `--show` → the item is ticked *or* not, but its text is
   intact and no other line moved

Let the loop finish (or Ctrl-C it) and make sure the text is back to
`Promote me from the detail modal` before step 6:

```sh
python3 test-fixtures/card-nesting/seed_gui_fixture.py --show
```

### 6. `promote-ui` — the Promote button

Still in Demo plan's detail, click **Promote** on
**"Promote me from the detail modal"**.

✅ the item becomes a **link**, and a **nested child appears** under Demo plan
   without a manual refresh
✅ `--show` → `promote-me-from-the-detail-modal.md … NESTED inside demo-plan.md`

### 7. `unparent` — the children list

In the detail's children list, click **Un-parent** on **Nested child**.

✅ the card **lands in the first column**
✅ `--show` → `nested-child.md … free-standing in the first column` (no
   `parent`, no `status`)

### 8. `promote-mcp` — nothing to do

Already verified end to end by `nesting_smoke.py`: `tools/list` carries
`gavin_promote_task` with this plan's exact description and a
`{plan_path, item}` schema, and a real `tools/call` created the nested task and
rewrote the line. Confirm `/mcp` lists it if you want the belt-and-braces check.

---

## Cleanup

```sh
rm -rf ~/gavin-nesting-gui-fixture
```

and close the fixture workspace in gavin.

## If something fails

The logic under each pointer item is unit-covered, so a failure here is a
wiring bug, not a rules bug — start at the glue:

| Symptom | Look at |
|---|---|
| no auto-expand | `BoardCard.svelte:93` `nestTargeted` (off `slotDrag` = `$dragState ?? $dropHold`) |
| nests when it should refuse | `kanbanDragGlue.ts:151` `nestCtx` (kind `task` + matching `data-kb-ctx`) |
| placeholder in the column during a nest drag | `kanbanDrag.ts` `buildDisplaySlots` |
| wrong slot inside the nested area | `pointerDrag.ts` middle-band / child-midpoint rules |
| flash on drop | drop-hold not held across the write (`kanbanDrag.ts`) |
| right visuals, wrong file | `planDrop.ts` — but `nesting_smoke.py` covers this half |
