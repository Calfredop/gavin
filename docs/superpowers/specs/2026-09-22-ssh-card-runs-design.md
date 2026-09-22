# Card runs on ssh workspaces

Follow-up to `2026-09-22-ssh-workspaces-design.md` §7, for the card-runs
card. Over `aeed732`, `PROTOCOL_VERSION` 38.

## 1. What a run needs from the workspace's disk

A board Run, a Resume, a Develop, a rail's card step and "send to main
agent" all compose their prompt in the frontend (`cardRunActions.ts`,
`orchestrationState.ts`) from three things read off the desktop's disk
through the Tauri host:

1. the card file itself (`read_file_for_viewer`), for the body and the
   first-Run review;
2. the card's attachments, classified and stat'd against the workspace root
   (`attachment_status`), so the prompt names what the agent may read and
   the review sheet says how big it is;
3. nothing else at launch -- but the agent that is launched needs
   `gavin-mcp` configured in the checkout it runs in, which
   `setup_agent_integration` writes (MCP config, skill files, the
   instructions block) the same way, onto the desktop's disk.

On an ssh workspace all three files are on the host. The daemon there can
read and write them; the desktop cannot.

## 2. Decision: three workspace-file requests, and the host's commands route

Three requests, one bump (v39), confined to a root the daemon already
knows:

| request | reply | what for |
|---|---|---|
| `ReadWorkspaceFile { root_path, path }` | `WorkspaceFile { content: Option<String>, truncated }` | the card, the existing MCP config / instructions file the integration merges into, `.gavin-root/config.toml` |
| `WriteWorkspaceFile { root_path, path, content }` | `Ok` | the files the integration writes |
| `StatWorkspacePaths { root_path, paths }` | `WorkspacePathStats { stats }` | attachments: exists, size, and where each resolved (`root` / `extraContext` / `outside` / `refused`) |

`path` is absolute or root-relative. A read or write outside the root and
its `extra_contexts` is refused; a stat reports `outside` rather than
refusing, because that is what the attachment classification means. The
sensitive-home refusal (`~/.ssh`, `~/.aws`, …) is applied by the daemon
against **its** home, which is the right one: the agent that would be
handed the file runs there. Reads are capped at 1 MiB like the viewer.

What routes is the **Tauri host's own file commands**, not the frontend:
`read_file_for_viewer`, `write_file_for_editor` and `attachment_status`
send the request to the workspace's link when the path or root belongs to
an ssh workspace, and answer in the shape they always did. So every
frontend reader -- the card modal, the launch, the rail step, the file
editor -- works unchanged, and the ssh gate the frontend card put on card
bodies comes off.

`setup_agent_integration` routes the same way, one level down: the
integration's file access goes through a `WorkspaceFiles` trait with a
local implementation (`std::fs`, byte-for-byte what it did) and a remote
one that speaks the three requests over the link. The merge logic --
foreign MCP servers, the `### Learned` section, the `.replaced` backup --
stays exactly where it is and runs once, for both. The `gavin-mcp` the
config names is the host's: the bridge's banner now carries `mcpPath`
(the binary beside the daemon it started, when present), and a host with
none says so instead of writing a path that is not there.

**Rejected.** Moving prompt composition into the daemon: the templates,
the per-workspace action-prompt overrides and the agent profiles are the
frontend's, and moving them would be a rewrite of the run for a problem
that is three file reads. A generic "exec on the host" request: a remote
shell in the protocol, which `05-remote-access.md` refuses to put on the
wire; these three name a file under a root the daemon already watches and
nothing else. Sending the file contents in the banner or the tree: the
tree is pushed on every change and a card body in it would push every
body on every edit.

## 3. Gate

`FEATURE_MIN_VERSION.sshCardRuns = 39`, and the consumer is the Run pill
on an ssh workspace's board: `remote-link-ready` now carries the host
daemon's `daemonVersion`, the link store keeps it, and `sshRunBlocked`
answers "Needs daemon v39 on `<host>`" when the host's daemon is older --
against the *host's* version, never the local daemon's, because the local
verdict says nothing about the machine the run happens on. A link that is
not up blocks with "not connected". The launch seam checks the same
function, so a queued intent and a rail step refuse on the same evidence
as the pill.

`authorize`: `app` allows all three; `agent` and `remote` deny them (an
agent has its own filesystem; a remote must never name a path);
`WriteWorkspaceFile` is privileged for an untokened `local`, because it
can write the MCP config that decides what an agent runs.

## 4. Still not over ssh after this

Best-of-N (forks worktrees with this machine's git), the setup wizard's
PRD and git steps, Superpowers install, the Git and Files tabs -- each
keeps its notice. The rail bind dialog keeps its (worktree and branch are
git). Resume's "does the conversation log exist" check runs on this
machine and fails open (`unknown`) for an ssh workspace, so the CLI on the
host answers instead.
