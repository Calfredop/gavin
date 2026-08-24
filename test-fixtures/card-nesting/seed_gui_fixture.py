#!/usr/bin/env python3
"""Seed a throwaway gavin workspace for the *pointer half* of the nesting smoke.

`nesting_smoke.py` covers every file effect in the "Nesting & promotion" smoke
section against its own temp daemon. What it cannot cover is the half that
needs a human in the real window: the drags, auto-expand, the drop-hold, the
Escape-cancel, and the three detail-modal surfaces. The app is a native
WKWebView (every board call goes through Tauri `invoke`), so those cannot be
driven from a browser or a synthetic pointer harness.

This builds a durable workspace with exactly the card shapes that pass needs,
so it can be done on fixture cards instead of on real ones:

    python3 test-fixtures/card-nesting/seed_gui_fixture.py          # seed
    python3 test-fixtures/card-nesting/seed_gui_fixture.py --show   # inspect
    python3 test-fixtures/card-nesting/seed_gui_fixture.py --reset  # re-seed

Then File > Open the printed directory in gavin and follow GUI-PASS.md.

It writes only inside its own --dir and never speaks to a daemon, so it is safe
to run while the app is up.
"""
import argparse, pathlib, shutil, sys

ap = argparse.ArgumentParser()
ap.add_argument("--dir", default=str(pathlib.Path.home() / "gavin-nesting-gui-fixture"))
ap.add_argument("--show", action="store_true", help="print each card's current shape and exit")
ap.add_argument("--reset", action="store_true", help="delete and re-seed")
args = ap.parse_args()

WS = pathlib.Path(args.dir).expanduser().resolve()
PLANS = WS / ".gavin-root" / "plans"

# Frontmatter shapes, straight from the spec's nesting rule: a task with a
# `parent:` and NO `status:` nests inside that plan's card; give it a status
# and it becomes free-standing in that column (the parent link survives).
CARDS = {
    "demo-plan.md": (
        "---\norder: 100\ntitle: Demo plan\nstatus: In Progress\npriority: high\n---\n"
        "# Demo plan\n\nFixture plan for the nesting GUI pass.\n\n"
        "- [ ] Tick me from the detail modal\n"
        "  - [x] Nested done item\n"
        "- [ ] Promote me from the detail modal\n"
    ),
    "nested-child.md": (
        "---\nkind: task\ntitle: Nested child\nparent: demo-plan.md\n---\n"
        "Starts nested. Drag me out to a column, then un-parent me.\n"
    ),
    "free-task.md": (
        "---\nkind: task\ntitle: Free task\nstatus: To Do\n---\n"
        "Starts free-standing. Drag me onto Demo plan's middle band.\n"
    ),
    "plain-note.md": (
        "---\nkind: note\ntitle: Plain note\nstatus: To Do\n---\n"
        "A note must REFUSE to nest -- a plan's middle band is a plain slot for me.\n"
    ),
    # The smoke item is "notes *and plans* refuse to nest", so the pass needs a
    # second plan to drag as well as a note.
    "other-plan.md": (
        "---\norder: 200\ntitle: Other plan\nstatus: To Do\n---\n"
        "# Other plan\n\nA plan must REFUSE to nest into another plan.\n\n"
        "- [ ] Nothing to do here\n"
    ),
}


def show():
    if not PLANS.is_dir():
        sys.exit(f"not seeded: {WS}\nrun without --show first")
    print(f"# {WS}\n")
    for path in sorted(PLANS.glob("*.md")) + sorted(PLANS.glob("done/*.md")):
        body = path.read_text()
        fm = body.split("---")[1] if body.startswith("---") else ""
        fields = {}
        for line in fm.strip().splitlines():
            if ":" in line:
                k, _, v = line.partition(":")
                fields[k.strip()] = v.strip()
        rel = path.relative_to(PLANS)
        kind = fields.get("kind", "plan")
        status = fields.get("status")
        parent = fields.get("parent")
        # The nesting rule, restated as what the board will actually show.
        if parent and not status:
            where = f"NESTED inside {parent}"
        elif parent:
            where = f"free-standing in {status!r} (still parented to {parent})"
        else:
            where = f"free-standing in {status!r}" if status else "free-standing in the first column"
        print(f"{str(rel):22} kind={kind:5} -> {where}")
        for line in body.splitlines():
            if line.strip().startswith("- ["):
                print(f"{'':22}   {line}")
    print()


if args.show:
    show()
    raise SystemExit(0)

if WS.exists():
    if not args.reset:
        sys.exit(
            f"{WS} already exists.\n"
            "  --show   inspect the current card shapes\n"
            "  --reset  delete it and seed a clean copy"
        )
    # Only ever remove a directory this script created the marker for.
    if not (WS / ".gavin-root" / "PRD.md").is_file():
        sys.exit(f"refusing to --reset {WS}: it is not a fixture this script seeded")
    shutil.rmtree(WS)

PLANS.mkdir(parents=True)
(WS / ".gavin-root" / "PRD.md").write_text(
    "# Nesting GUI fixture\n\nThrowaway workspace for the pointer half of the\n"
    "\"Nesting & promotion\" smoke section. Not real work -- drag freely.\n"
)
for name, body in CARDS.items():
    (PLANS / name).write_text(body)

print(f"seeded {WS}\n")
show()
print("Next: open that directory in gavin, then follow")
print("  test-fixtures/card-nesting/GUI-PASS.md")
print("Re-run with --show after each step to see what hit disk.")
