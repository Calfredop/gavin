#!/usr/bin/env python3
"""Backend half of the "Nesting & promotion" smoke section.

The GUI items in that section need a human dragging in the real window. The
*file effects* behind them do not: `protocol::socket_path()` derives from
`$HOME` alone, so this starts a throwaway daemon under a temp HOME, on its own
socket, against a temp fixture workspace. It never touches the daemon the
running app owns, so it is safe to run while the app is up.

    cargo build -p gavin-daemon -p gavin-mcp
    python3 test-fixtures/card-nesting/nesting_smoke.py

Optional: --target DIR (cargo target dir, default ./target).
"""
import argparse, json, os, pathlib, re, shutil, socket, subprocess, sys, tempfile, time

REPO = pathlib.Path(__file__).resolve().parents[2]

ap = argparse.ArgumentParser()
ap.add_argument("--target", default=str(REPO / "target"))
args = ap.parse_args()
BIN = pathlib.Path(args.target) / "debug"
for exe in ("gavin-daemon", "gavin-mcp"):
    if not (BIN / exe).exists():
        sys.exit(f"missing {BIN / exe} — run: cargo build -p gavin-daemon -p gavin-mcp")

# A unix socket path must fit SUN_LEN (104 on macOS), and the daemon appends
# "Library/Application Support/gavin/daemon.sock" to $HOME -- so the temp HOME
# has to be short. mkdtemp under /tmp keeps it well inside the limit.
HOME = tempfile.mkdtemp(prefix="gvn", dir="/tmp")
WS = tempfile.mkdtemp(prefix="gvnws")
SOCK = pathlib.Path(HOME, "Library/Application Support/gavin/daemon.sock")
assert HOME != os.environ.get("HOME"), "refusing to run against the real HOME"
env = dict(os.environ, HOME=HOME)

results = []
def check(name, ok, detail=""):
    results.append((name, ok))
    print(("PASS " if ok else "FAIL ") + name + (("  -- " + str(detail)[:400]) if detail and not ok else ""))

def req(payload):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(10)
    s.connect(str(SOCK))
    s.sendall((json.dumps(payload) + "\n").encode())
    buf = b""
    while b"\n" not in buf:
        chunk = s.recv(65536)
        if not chunk: break
        buf += chunk
    s.close()
    return json.loads(buf.split(b"\n")[0].decode())

def rpc(proc, method, params=None, id=None, notify=False):
    msg = {"jsonrpc": "2.0", "method": method}
    if params is not None: msg["params"] = params
    if not notify: msg["id"] = id
    proc.stdin.write(json.dumps(msg) + "\n"); proc.stdin.flush()
    if notify: return None
    while True:
        line = proc.stdout.readline()
        if not line: return None
        m = json.loads(line)
        if m.get("id") == id: return m

plans = pathlib.Path(WS, ".gavin-root", "plans"); plans.mkdir(parents=True)
pathlib.Path(WS, ".gavin-root", "PRD.md").write_text("# Fixture PRD\n")

PLAN = plans / "demo-plan.md"
PLAN.write_text(
    "---\norder: 100\ntitle: Demo plan\nstatus: In Progress\npriority: high\n---\n"
    "# Demo plan\n\nIntro line.\n\n"
    "- [ ] Ship the thing\n  - [x] Nested done item\n- [ ] Wire the widget\n")
TASK = plans / "free-task.md"
TASK.write_text("---\nkind: task\ntitle: Free task\nstatus: In Progress\n---\nDo the thing.\n")

daemon = subprocess.Popen([str(BIN / "gavin-daemon")], env=env,
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
try:
    for _ in range(100):
        if SOCK.exists(): break
        time.sleep(0.1)
    else:
        sys.exit("daemon failed to start: " + (daemon.stdout.read() or ""))

    head_v = int(re.search(r"PROTOCOL_VERSION: u32 = (\d+)",
                           (REPO / "crates/protocol/src/lib.rs").read_text()).group(1))
    r = req({"type": "GetProtocolVersion"})
    check(f"daemon reports the version it was built at (v{head_v})",
          r.get("type") == "ProtocolVersion" and r.get("version") == head_v, r)

    # checklist-toggle -------------------------------------------------
    before = PLAN.read_text()
    r = req({"type": "SetChecklistItem", "path": str(PLAN), "line_index": 10,
             "expected_text": "Ship the thing", "checked": True})
    check("checklist-toggle: tick succeeds", r.get("type") == "Ok", r)
    check("checklist-toggle: only that line changed",
          PLAN.read_text() == before.replace("- [ ] Ship the thing", "- [x] Ship the thing", 1),
          PLAN.read_text())

    r = req({"type": "SetChecklistItem", "path": str(PLAN), "line_index": 11,
             "expected_text": "Nested done item", "checked": False})
    check("checklist-toggle: untick keeps indentation",
          r.get("type") == "Ok" and "  - [ ] Nested done item\n" in PLAN.read_text(), PLAN.read_text())

    snap = PLAN.read_text()
    r = req({"type": "SetChecklistItem", "path": str(PLAN), "line_index": 12,
             "expected_text": "Text that drifted away", "checked": True})
    check("checklist-toggle: concurrent-edit drift refused", r.get("type") == "Error", r)
    check("checklist-toggle: drift wrote nothing", PLAN.read_text() == snap)

    # promote-ui (file effects) ---------------------------------------
    r = req({"type": "PromoteChecklistItem", "plan_path": str(PLAN), "item": "Wire the widget"})
    check("promote: returns TaskPromoted", r.get("type") == "TaskPromoted", r)
    if r.get("type") == "TaskPromoted":
        child = pathlib.Path(r["path"]); body = child.read_text()
        check("promote: child file name slugged", child.name == "wire-the-widget.md", child.name)
        check("promote: child is a task", "kind: task" in body, body)
        check("promote: child parents the plan", "parent: demo-plan.md" in body, body)
        check("promote: child has no status (so it nests)", "\nstatus:" not in body, body)
        check("promote: line rewritten to a link",
              "- [ ] [Wire the widget](./wire-the-widget.md)" in PLAN.read_text(), PLAN.read_text())

    check("promote: missing item refused",
          req({"type": "PromoteChecklistItem", "plan_path": str(PLAN),
               "item": "No such item here"}).get("type") == "Error")

    AMB = plans / "amb-plan.md"
    AMB.write_text("---\ntitle: Amb\nstatus: In Progress\n---\n# Amb\n\n- [ ] Twice over\n- [ ] Twice over\n")
    check("promote: ambiguous item refused",
          req({"type": "PromoteChecklistItem", "plan_path": str(AMB),
               "item": "Twice over"}).get("type") == "Error")
    check("promote: ambiguous wrote no child", not (plans / "twice-over.md").exists())

    # nest-drag-in / nest-drag-out / unparent (file effects) -----------
    def field(path, key, value):
        r = req({"type": "SetPlanFrontmatterField", "path": str(path), "key": key, "value": value})
        return pathlib.Path(r.get("path", str(path)))

    p = field(field(TASK, "parent", "demo-plan.md"), "status", "")
    check("nest-drag-in: parent written", "parent: demo-plan.md" in p.read_text(), p.read_text())
    check("nest-drag-in: status line removed", "status:" not in p.read_text(), p.read_text())

    p = field(p, "status", "In Progress")
    check("nest-drag-out: status written", "status: In Progress" in p.read_text(), p.read_text())
    check("nest-drag-out: parent retained", "parent: demo-plan.md" in p.read_text(), p.read_text())

    p = field(p, "parent", "")
    check("unparent: parent line removed", "parent:" not in p.read_text(), p.read_text())
    check("unparent: status retained", "status: In Progress" in p.read_text(), p.read_text())

    # promote-mcp: through the real MCP server -------------------------
    MCPPLAN = plans / "mcp-plan.md"
    MCPPLAN.write_text("---\ntitle: MCP plan\nstatus: In Progress\n---\n# MCP plan\n\n- [ ] Promote me from MCP\n")
    mcp = subprocess.Popen([str(BIN / "gavin-mcp")], env=env, cwd=WS, text=True, bufsize=1,
                           stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        rpc(mcp, "initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                "clientInfo": {"name": "smoke", "version": "0"}}, id=1)
        rpc(mcp, "notifications/initialized", {}, notify=True)
        tools = {t["name"]: t for t in rpc(mcp, "tools/list", {}, id=2)["result"]["tools"]}
        check("promote-mcp: /mcp lists gavin_promote_task", "gavin_promote_task" in tools, sorted(tools))
        if "gavin_promote_task" in tools:
            t = tools["gavin_promote_task"]
            check("promote-mcp: description matches the plan's wording",
                  "Promote a plan's checklist item into a nested task card" in t["description"], t["description"])
            check("promote-mcp: takes plan_path + item",
                  set(t["inputSchema"]["properties"]) == {"plan_path", "item"},
                  sorted(t["inputSchema"]["properties"]))
        call = rpc(mcp, "tools/call", {"name": "gavin_promote_task",
                   "arguments": {"plan_path": str(MCPPLAN), "item": "Promote me from MCP"}}, id=3)
        check("promote-mcp: tool call succeeds",
              "error" not in call and not call.get("result", {}).get("isError"), call)
        kid = plans / "promote-me-from-mcp.md"
        check("promote-mcp: real agent call created the nested task", kid.exists(), call)
        if kid.exists():
            b = kid.read_text()
            check("promote-mcp: child is a nested task (kind+parent, no status)",
                  "kind: task" in b and "parent: mcp-plan.md" in b and "\nstatus:" not in b, b)
            check("promote-mcp: plan line rewritten to a link",
                  "- [ ] [Promote me from MCP](./promote-me-from-mcp.md)" in MCPPLAN.read_text(),
                  MCPPLAN.read_text())
    finally:
        mcp.terminate()
        try: mcp.wait(timeout=5)
        except Exception: mcp.kill()
finally:
    daemon.terminate()
    try: daemon.wait(timeout=5)
    except Exception: daemon.kill()
    shutil.rmtree(HOME, ignore_errors=True)
    shutil.rmtree(WS, ignore_errors=True)

bad = [n for n, ok in results if not ok]
print("\n%d/%d checks passed" % (len(results) - len(bad), len(results)))
if bad:
    print("FAILED: " + ", ".join(bad))
sys.exit(1 if bad else 0)
