# 06 — The Companion: a phone that drives a Workstation

Design pass, 2026-09-28, written against branch `companion/desk-prep` at `a665d640`
(`PROTOCOL_VERSION` 43). It reads the spec
(`docs/superpowers/specs/2026-09-27-companion-design.md`), ADRs 0001–0006 (0001, 0004
and 0005 as the device-keys spike amended them), the store research
(`docs/research/2026-09-27-app-store-downloaded-code.md`), the spike's findings
(`docs/research/2026-09-28-companion-device-keys.md`), `CONTEXT.md`,
`00-threat-model.md` and `05-remote-access.md`. The vocabulary is `CONTEXT.md`'s
(Workstation, Companion, Device, Unlock, Remote role, Relay, Push gateway, Demo
Workstation). Two more words: **the desk** is a Workstation's own desktop app, and
**the shell** is the Companion's native app together with its own web layer (the hub,
the keys, the WASM core), as opposed to a **bundle**, which is a Workstation's UI.

Like 05 this pass makes no findings; it cites them. It cites adversaries A1–A3,
surfaces S1–S12, accepted-by-design AD-1..AD-7 (`00`), and DP-01..DP-06, AS-01..AS-09,
AG-01..AG-09, SC-01..SC-11 and R1..R10 (`01`–`04`, `README`). It supersedes four
sections of 05 (§1's composition claim, §6, §8's key custody, §10) and amends the rest
where the ADRs did; §1 below is the full map. Nothing in it is a protocol bump. The
message shapes are the spec's, and the version numbers are the implementers'.

Where this pass goes beyond the spec or an ADR, the text says **06 adds**, and §5.8
collects every such item so the owner can accept or strike each one.

**Threat ids.** The six threats the card names, and three more the reading turned up,
are `CT-1`..`CT-9` (§4). **Sub-surfaces.** `00`'s S12 was "does not exist yet". It does
now, so this pass cuts it into six for its own citations. `00` is pinned to the audit
commit and is not edited.

| id | Sub-surface | Where it lives |
|----|-------------|----------------|
| **S12.a** | The Relay | `crates/gavin-relay` (a Docker image) |
| **S12.b** | The Device connection: `XXpsk3` pairing, `IK`, the hardware signature, `devices.sqlite` | `remote.rs`, `pairing.rs`, `trust.rs`, the Companion core |
| **S12.c** | Forwarding: the forwarding connection, the command table, the event table, the desk's dispatcher | the protocol crate, `server.rs`, the Tauri host |
| **S12.d** | The shell and the served bundles: the keys plugin, the channel, the bundle webview, the signature check | `app/companion-shell/`, `app/companion/` |
| **S12.e** | Notifications: daemon, Push gateway, Apple and Google, the Notification Service Extension | the push-gateway crate |
| **S12.f** | The local dev stack, the dev key and the dev-Relay guard | the compose stack, debug builds |

---

## 1. What this supersedes, and what stands

| 05 | Verdict | What changed | Now read |
|----|---------|--------------|----------|
| §1 Context and the two facts | **Superseded in part** | The claim that card-run composition happens in the Tauri host is wrong: it happens in the desktop webview (§2 fact 2). The "gift" argument built on it falls with it. Fact 2's closing "the remote role cannot spawn" is dropped by ADR 0004. Fact 1 (the daemon has no client identity) stands. | §2 |
| §2 Goals and non-goals | Stands, except goal 3 | Goal 3, "nothing in the remote surface can start a process, change what a process will run, or reach a path", is ADR 0004's exact opposite. | §2, §5.3 |
| §3 Pairing: the ceremony and the trust store, "as phase 2 built it" | **Stands** | Six amendments: a hardware public key, Android attestation, cap five, a QR that carries the Relay's address and admission token, a notification key per pairing, and a key-kind column. The one that relaxes a stated rule (the QR and the Relay's credentials) says why. | §5.1 |
| §4 Identity, roles, authorization | Stands for `app`, `local`, `agent`; the `remote` row and the grants paragraph are superseded | A Device's vocabulary is three message kinds plus the command table, not 62 `Request` variants (ADR 0003). "Capability tokens per session" and the desk-issued grants go with ADR 0004. | §5.3 |
| §5 Transport | **Stands** | Amended: an admission token, a public Relay run by the publisher, signed images, the hub's many connections. | §5.4 |
| §6 The capability table | **Superseded** | Replaced by the command table (ADR 0003) and its policy. | §5.3 |
| §7 Protocol sketch | Stands | "Phase 2 additions" is shipped wire and stays as written. `GrantInput` and `RevokeInputGrant` were already dropped there and stay dropped. | — |
| §8 The proxy's threat model | **Split** | "A compromised relay", "the remote channel gets its own caps" and "the rogue-daemon case" stand. **Key custody** ("a stolen key with no device", and "the key never leaves the Secure Enclave") is superseded by ADR 0001. "A stolen unlocked phone" and "should `WriteInput` need a desktop grant?" are superseded by ADR 0004. | CT-1..CT-3, §5.1, §5.2 |
| §9 Shared with ssh workspaces | Stands, except one line | "The table has three columns" is stale: the phone's column is now the command table, and the ssh path still exercises the daemon's own `app` column. | §5.3 |
| §10 Phased plan | **Superseded** | Phases 1 and 2 are history (they landed at v35 and v42). Phases 3 to 5 are replaced by the spec's build order. | §6 |
| §11 Open questions | Answered | Below. | — |

**05 §11, as the spec answered it.** 1: unchanged. 2: a public Relay plus self-hosting.
3: five Devices. 4: ninety days unseen, then re-pair. 5 to 7: superseded by ADR 0004
(kill, `status` moves and typing are all inside the Remote role). 8: hardware keys are
mandatory on both platforms. 9: not applicable. 10: unchanged (a `0600` file). 11:
256-byte padding kept. 12: relaxed to a dev build that may dial only a Relay on
loopback or the LAN (§5.7).

---

## 2. What changed underneath

Five things moved between 05 and the ADRs. Each one changes a security argument, and
none of them is visible from the wire alone.

**1. A Device talks to the desk, not to the daemon (ADR 0003).** Most of Gavin lives in
the desktop app: git, the file viewer, `config.json`, agent profiles, the rail
scheduler, card-run launching. A Device's requests travel Device → Relay → daemon →
desk and run as the same Tauri command the desk's webview would have invoked. Three
consequences:

- The daemon's 62-variant vocabulary stops being a Device's vocabulary. `authorize`
  for a Device shrinks from an exhaustive walk over `Request` to three message kinds,
  and the gate that matters moves to the command table.
- The daemon sees only the desk. Everything a Device does reaches the daemon as the
  desk's `app` role, so the daemon's role checks (05 §4) cannot tell a Device's
  `create_session` from the human's. Attribution has to be carried, not inferred (§5.3).
- The dispatcher calls handler functions directly. Tauri's capability ACL sits in front
  of the webview's `invoke`, not in front of the dispatcher, so for forwarded calls the
  command table is the only ACL there is (§5.3).

**2. Card-run composition happens in the desktop webview, not the host (correcting 05
§1).** 05 said the prompt "is composed in the Tauri host
(`agent_setup.rs::compose_agent_prompt`) and launched as `CreateSession { command }`",
and drew a conclusion: "Run this card from my phone" can only ever be a request to the
desktop, "where the human's screen is", so the most dangerous capability "lands
naturally behind a desktop confirmation". Both halves are wrong. Card prompts are
composed in TypeScript (`composeTaskPrompt` and `composePlanPrompt` in
`app/src/lib/cards/cardRun.ts`) and launched by `cardRunActions.ts` through
`backend.createSession(cwd, command, root)`. The host's `compose_agent_prompt` composes
the setup and wizard prompts and nothing that Run launches. Under ADR 0005 the
Companion's bundle *is* that webview code, running on the phone. A Device's Run
composes on the phone and calls `create_session` with a finished command line. No
desktop screen sits in that path. What stands between a tap and a running agent is the
Unlock (§5.2) and the first-run review gate (AG-01's fix), which the bundle draws
on the phone. The "gift" is retired: nothing in 06 relies on a desktop confirmation
for a Device's action.

**3. The Remote role is nearly the whole desk (ADR 0004).** One Unlock gives full
control, and only Trust stays at the desk. A Device can therefore open a shell
(`create_session`, DP-01 by design), read and write any file the user can (AS-04), run
cards and rails against unsandboxed agents (AD-4), change any workspace setting (AD-6),
and push. So this pass cannot promise that the Remote role is unable to do something
dangerous. What it has to guarantee instead is:

- only an unlocked, paired, key-holding Device gets the role (§5.1, §5.2);
- Trust stays at the desk (§5.3);
- nothing on the Workstation side can turn round and attack the Device or its other
  Workstations (CT-4, CT-5, §5.5);
- the infrastructure in between, the Relay and the Push gateway, is untrusted for
  confidentiality and integrity (CT-3, CT-6).

**4. The trust direction flips.** 05 protected a Workstation from a phone. A Device now
holds keys for several Workstations, and from its point of view each Workstation is a
stranger to the others, possibly compromised, possibly a stranger's. The threats in §4
that face the phone (CT-4, CT-5) have no counterpart in 05.

**5. Publisher-run services and shipped UI code.** The publisher now runs two
services (Relay, Push gateway), holds three keys that matter (the updater key, the
bundle-signing key, the push credentials) and ships UI code inside desktop builds that
a phone will execute. That is S11 (`04`) growing. `docs/RELEASING.md`'s key-custody
rules extend to all three (§5.5, §5.6).

### What ADR 0004 does to `00`'s accepted-by-design list

| Entry | Before | Now |
|-------|--------|-----|
| **AD-1** same-user process has the whole protocol | A1 only | Unchanged for the local socket. A Device is not a same-uid process, but with the Remote role it holds a same-uid process's *reach* (a shell, the files), behind authentication. |
| **AD-2** agents are first-class | agents act through `gavin_*` | Unchanged. A Device is not an agent and never holds the `agent` role. |
| **AD-3** a card's body is the prompt and Run is the human's click | a click at the desk | The click may be a tap on a phone. The content the human has *not* read (a cloned repo's cards, R2) is caught by the first-run review, which travels with the UI code and is drawn by the bundle. |
| **AD-4** agents run unsandboxed | — | Unchanged, and now reachable from a phone. |
| **AD-5** the daemon persists session state | on disk at `0700` | A Device reads live screens and queued input, the same as the desk. |
| **AD-6** the human's own configuration is trusted | the human at the desk | Whoever holds an Unlock. `[agent] command`, tools, profiles and the review gate are writable by a Device (Q14). |
| **AD-7** dev-only surfaces are dev-only | vite, HMR | Extended by §5.7: a dev build never meets a real Device. |

And to the fixes for `01`–`04`: R4's path confinement (DP-03, AS-04) is **not a boundary
against a Device**. A Device can add `/` as a workspace through the remote folder
browser (spec, "Workspace state split") and read anything the user can. 05 §4's
"a remote never introduces a filesystem path" is gone by ADR 0004, not by oversight.
R1's client identity still gates the daemon's own protocol against local processes.

---

## 3. Threats at a glance

| id | Threat | 00 adversary | 00 surfaces | Related 00 entries | Mechanism |
|----|--------|--------------|-------------|--------------------|-----------|
| **CT-1** | A stolen phone while unlocked | A3 (the far end) | S12.b, S12.c, S6, S2 | AD-1, AD-3, AD-4, AD-5, AD-6; DP-01, DP-04, AS-04, AS-05 | §5.2, §5.3 |
| **CT-2** | A stolen key without the device | A3 | S12.b, S3 | DP-02 | §5.1, §5.2 |
| **CT-3** | A malicious Relay | A3 ("possibly the proxy itself") | S12.a | DP-05, DP-06, SC-10 | §5.4 |
| **CT-4** | A compromised Workstation attacking the Device's other Workstations | A1 or A2 succeeded, seen from the phone | S12.d, S8, S6 | AD-4; AS-01, AS-07 | §5.5 |
| **CT-5** | A malicious or unsigned bundle | A1/A2 on a Workstation; S11 for the publisher | S12.d, S11, S8 | SC-04, SC-05, SC-06 | §5.5 |
| **CT-6** | A compromised Push gateway | A3 (a service) | S12.e, S11 | SC-06 | §5.6 |
| **CT-7** | A script in the desk's own page pairing a Device | A2 via S8 | S6, S12.b | AS-01, AS-05, R5 | §5.3 |
| **CT-8** | A hostile process taking the forwarding seat | A1, A2 | S12.c, S1 | AD-1, AD-4; DP-06 | §5.3 |
| **CT-9** | A dev build meeting a real Device | A1 (the developer's own tree) | S12.f, S11 | AD-7; SC-09 | §5.7 |

`00` has no row for a thief or for a hostile Workstation. Both are A3 exercised from
the far end, and this pass names them by threat rather than by a new adversary number.

---

## 4. The threats

Each threat says what the attacker holds, what they want, which mechanism stops which
step, what they still get, and what the human does about it.

### CT-1 — A stolen phone while unlocked

**Who.** Someone holding the phone with the Companion able to reach an Unlock. Three
cases, in falling order of what they get.

- **(a)** The phone is unlocked and the Companion is in front. Full control of **every**
  paired Workstation until the phone locks or the Companion is backgrounded (ADR 0004;
  one Unlock covers every Workstation, spec story 15).
- **(b)** The phone is unlocked, the Companion is not in front. The thief must Unlock:
  a biometric, or the phone's passcode as the fallback. A thief who knows the passcode
  gets in (ADR 0004, consequence 2). This is the realistic form of the threat, because
  a passcode is what a shoulder-surfer takes before taking the phone.
- **(c)** The phone is locked. No control. Notification text may be visible on the lock
  screen (§5.6).

**What "full control" is.** A shell as the user (`create_session`); every file the user
can read or write; git, including pushing with the Workstation's credentials; running
cards and rails against agents that hold shells; workspace settings including the
review gate and `[agent] command`; live screens and queued input. **Not** Trust: the
Device cannot pair another Device, revoke one (the owner's included), or touch the
remote-access switch and Relay settings; nor can it save the desk's layout, manage
windows, run the updater, or open things on the desk (§5.3).

**What the thief also gets, and 05 did not count.** The Remote role can read the
Workstation's own data directory, because it can read any path and can open a shell,
and while it holds both, neither can be fenced off. That directory holds the daemon's
static private key, the notification keys, the Relay's admission token and
`daemon.token`. **A copied daemon key lets its holder impersonate the Workstation to
every Device, from a Relay's position.** So revoking the stolen Device is not enough.
The response is Revoke all, which rotates that key (05 §3). Persistence is wider still:
a shell plants an authorised ssh key or a launch agent, and no Revoke undoes that.

**What bounds it.**

- The Unlock's end: the shell drops every connection on background or lock (§5.2).
- A fresh hardware signature for every *new* connection, so a thief who loses the
  foreground loses the ability to open more (§5.2).
- Trust at the desk: the thief cannot extend their own access by pairing, and cannot
  lock the owner out.
- Visibility: connected Devices and what they are doing show at the desk (the Devices
  panel, its badge, the menu-bar icon), and a session started from a phone is a tab
  labelled with the Device (spec stories 58 to 64). These are aids if the human looks,
  not controls.

**Response, all of it at the desk.** Revoke all. Treat the Workstation as one a
stranger had a shell on: review the sessions labelled with the Device, and rotate what
that shell could read (git credentials, agent tokens). Erase the phone through the
platform's own find-my. There is no away-from-desk answer in the design (Q1).

**Residual.** Everything in "what full control is" for as long as the Unlock lasts. ADR
0004 accepts it; the laptop model is the reason. The doc does not soften it.

### CT-2 — A stolen key without the device

**Who.** Someone with a copy of the Device's **Noise private key**: from a backup, a
forensic image, a filesystem bug, or code running inside the shell's own web layer,
which holds the key in memory for the WASM core (ADR 0002). They do **not** hold the
phone.

**What the design says.** The Noise key is exportable by necessity: the WASM core does
the X25519 itself (spike §3). It authenticates the channel and nothing more. The
Device's identity to the daemon is the **hardware key** (ADR 0001), which is
non-exportable and signs only after user presence, and never while the phone is
locked.

**What the thief gets.** A completed `IK` handshake, then no answered request. The
daemon accepts nothing on a connection until the hardware signature over that
connection's handshake verifies against the Device's row (§5.2). The copied key alone
opens no door.

**What still needs handling.**

- **Slot squatting.** 05 §8 caps a Device at two concurrent connections. A thief with
  the Noise key can complete two handshakes and never sign, and lock the real Device
  out of its own slots. **06 adds:** a connection counts against the cap only after its
  signature verifies, and one that has not signed within a short deadline is dropped.
- **A tripwire.** A handshake that completes and never signs is exactly what a copied
  Noise key looks like. **06 adds:** the daemon counts handshake-without-signature per
  Device, rate-limits it, and past a threshold surfaces it at the desk. It cannot fire
  on the first event, because an honest shell that has done the handshake and then
  had its user cancel the biometric prompt looks the same.
- **Weaker custody for the notification key.** The Notification Service Extension needs
  it while the phone is locked, so it is `AfterFirstUnlockThisDeviceOnly` in a shared
  access group (spike §3). A thief who gets it can read that Workstation's
  notification ciphertext *if* they can also capture it, which only Apple, Google, the
  gateway or the Relay path can. It cannot be used to connect.

**Residual: iOS attestation.** On Android the daemon verifies the hardware key's
attestation chain at pairing, and a release daemon refuses anything that is not TEE or
StrongBox. iOS has no equivalent for an arbitrary Secure Enclave key (App Attest
attests its own key, not ours), so there the daemon relies on the shell's claim. A
software P-256 key posing as hardware is therefore undetectable to the daemon on iOS.
It matters only if the human pairs a modified Companion at the desk, which is the human
acting against themself (`00`, out of scope), because pairing needs the desk's
confirmation.

### CT-3 — A malicious Relay

**Who.** The Relay's operator, or a network observer that has taken its TLS. The
publisher's public Relay is the default, so "the operator" includes the publisher.

**What 05 §8 already says, and stands.** It sees that a daemon with rendezvous id R is
online, when a Device connects, from which IP, for how long, and frame sizes and
timing. It cannot read or alter a request (AEAD under keys it never held), forge a
daemon (the Device pinned the daemon's static key at pairing and `IK` proves it in the
first message), forge a Device (the daemon looks the static key up, then demands the
hardware signature), downgrade (one fixed suite), or replay (per-direction counters
bound to a handshake with fresh ephemerals). It can deny, delay and drop, and it can
pair the wrong two parties, which fails at the handshake. The spec's seam 1 tests each
of these.

**What is new.**

- **The Relay now sees a human's Workstations together.** 05 had one phone and one
  daemon. A Device connects to every paired Workstation when it Unlocks, so a Relay
  that sees one IP open several rendezvous ids in a burst learns those Workstations
  belong to one person. Nothing in the design hides this, and hiding it would cost the
  hub its live state. It is the reason to self-host, and the docs should say so.
  Padding stays at 256 bytes, which blunts sizes and does not erase them.
- **The admission token.** It keeps strangers off the operator's infrastructure. It is
  a ticket to the Relay, and authenticates nothing about a Workstation or a Device:
  admission is the first frame, and `IK` plus the hardware signature are the real
  gate. The QR now carries the token (05 §3 said it must not carry "the relay's own
  credentials"). This is safe *because* of that division, and it is why the QR
  must never carry the pairing secret to the Relay: the secret is mixed into
  `XXpsk3` only, so a Relay that sits in the pairing handshake cannot complete it. The
  six-digit code is the second line.
- **A lost response is an unknown outcome, not a failure.** A Relay that drops the
  reply to "run this card" leaves the human unable to tell whether it ran. **06 adds:**
  the shell never automatically re-sends a forwarded command after a reconnect (spec
  story 18's silent reconnect covers the *connection*, not the *command*); it re-reads
  state. Forwarded calls carry a per-connection request id, and a result for an unknown
  id is dropped.
- **"Asleep" is a guess.** The spec has the shell infer "Mac asleep" from the Relay. A
  malicious Relay can make a Workstation look asleep or absent. It cannot make one look
  ready, because ready needs an authenticated `IK`. The inference must never gate a
  security decision or reassure.
- **The caps.** 05 §8's 64 KiB channel line, per-connection request rate and per-Device
  connection ceiling stand (DP-05, SC-10). They now apply on the daemon's side of the
  Relay, and the Relay carries its own per-Workstation bandwidth limit.

**Residual.** Denial, delay, selective censorship, and the metadata above.

### CT-4 — A compromised Workstation attacking the Device's other Workstations

**Premise.** Workstation W is compromised: an A1 or A2 succeeded there, or W is a
stranger's, or a community-built desktop. From the phone, W is hostile. W controls:
the bytes of the UI it serves; every reply on the channel; the attention request's
answer; what it pushes; its availability; and what it learns from the Device (its
public keys, its name, every request it sends W). W wants: the keys, the other
Workstations, the phone's native APIs, the human's attention.

ADR 0005 exists for this threat. Its original wording ("a compromised Workstation
cannot run code in the webview that also holds the Device's keys") assumed one
webview; the store research and the spike's measurements changed the mechanism to a
separate bridge-less webview. **Signing** and **containment** now answer different
questions (§5.5). Path by path:

| # | W's move | What closes it |
|---|----------|----------------|
| 1 | Run code next to the keys | The bundle runs in its own webview with no Capacitor bridge, never an iframe in the shell's, and on Android in its own app process (ADR 0005, spike §4). Only signed bundles run at all. |
| 2 | Talk to another Workstation through the Device | The channel is bound to one Workstation. The shell resolves origin → Workstation from its **own** records, and no message names a Workstation the bundle chose. |
| 3 | Get the hardware key to sign for another Workstation | The shell plugin signs only a domain-separated handshake hash of the shell's own connection (§5.2). That hash covers both static keys and fresh ephemerals, so a signature made for W cannot be replayed to another Workstation. |
| 4 | Exploit the shell through what the hub renders (attention items, Workstation names) | The shell parses only what ADR 0005 keeps small: a version, a state, and items with an id, workspace, kind, short text and target. **06 adds:** hard caps (item count, text length), plain text only, control characters stripped (05 §3's device-name rule, in the other direction), unknown optional fields ignored, no markup and no `{@html}` in the hub, and the shell page's `frame-src 'none'`. The hub is inside the key boundary, so it is the most sensitive UI in the app. |
| 5 | Exploit the renderer with hostile *data* inside a signed bundle (a card body carrying a WebKit bug) | Containment: a separate WebContent process on iOS, `:bundle` on Android, and a webview that holds nothing. A renderer 0-day plus a sandbox escape is the OS and WebKit, out of scope (`00`). |
| 6 | Spoof the shell's UI, for instance a fake "enter your passcode" (the bundle is full-screen) | **06 adds:** native chrome the bundle cannot draw over, naming the Workstation and offering return-to-hub. The shell never asks for a secret inside a bundle, and prompts are drawn by the OS. |
| 7 | Spoof a notification from another Workstation | The notification is decrypted with W's own key, and its Workstation label comes from the shell's record of *which key decrypted it*, not from the payload (§5.6). |
| 8 | Abuse "open an external link" | Web links only, `https`, from a user gesture, host shown. |
| 9 | Serve an old, signed, vulnerable bundle | A signed serial floor (§5.5). |
| 10 | Put text on the clipboard for the human to paste into another Workstation's terminal | **Accepted.** The human pastes what they copied; the same holds at the desk (AD-4). |
| 11 | Learn the Device's identity, or recognise it on another Workstation | **Accepted.** One install holds one key pair for every Workstation (ADR 0001), so each sees the same public keys. A Relay does not (the initiator's static key is encrypted in `IK`). Multi-user is out of scope. |

**Residual.** W can lie to the human about W's own state, exactly as an agent's text can
at the desk (S8). A hostile W can also feed the shell's parser; hence row 4.

### CT-5 — A malicious or unsigned bundle

| Case | Outcome |
|------|---------|
| Unsigned, or self-built (gavin's source is public) | A store shell refuses. Otherwise it becomes a runtime for arbitrary code, which is what DPLA 3.3.1(B)'s "primary purpose" limit targets (research §4). |
| Signed with the dev key | A store shell refuses. Only a debug shell trusts it (§5.7). |
| Altered after signing (A1 replacing files on the Workstation; a Relay cannot, the channel is AEAD) | The manifest hash check fails. |
| An older, validly signed bundle | Refused below the signed serial floor (§5.5). |
| **The publisher's signing key is stolen** | The forged bundle verifies. Containment still holds: no bridge, one Workstation, no keys. The forged code can act as the Device only against the Workstation that served it, and a Workstation that can be made to serve it is already compromised. The real damage is to the store promise ("signed by us") and to un-updated shells that keep trusting the key. Rotation is a store release (§5.5). |
| A signed bundle asks for a capability it was not reviewed for | The message set is closed and versioned; an unknown type is dropped; the `capabilities` query is answered by the **shell**. A new native capability, a new permission or a change of purpose ships as a store release (ADR 0005). |
| A poisoned cache | The cache is keyed by content hash, and an entry is verified before it is inserted and again when loaded. |
| A compromised build pipeline | It ships the desktop, the bundle and the shell together, so the bundle adds nothing beyond what a compromised release already gives. This is S11's problem (`04`, `RELEASING.md`), and the bundle-signing key is protected the same way (§5.5). |

**What signing is for.** It is provenance (the store's "content owned by the app
developer") and a guard on the channel: unsigned code never gets even the channel. It is
**not** what protects the keys or the other Workstations. Containment does.

### CT-6 — A compromised Push gateway

**What it holds.** The publisher's APNs and FCM credentials and its send-permission
signing key. **What it sees.** Device push tokens; which permission is used and when;
ciphertext sizes and timing; the source addresses of daemons.

| Move | Outcome |
|------|---------|
| Read a notification | No. The payload is AEAD under a per-Workstation key the gateway never held. |
| Forge one | No authentic payload without that key. |
| **Send arbitrary pushes to any registered token** (it holds the credentials) | **The real exposure.** On iOS a mutable-content push shows its own alert text if the extension fails or times out (Apple's documented behaviour; the step-6 device test confirms it), and the sender picks that text. A hostile gateway can put phishing text under Gavin's name on a lock screen. **06 adds:** the visible alert is a fixed generic string that no payload can change, an undecryptable push shows nothing more than that, and tapping it opens the hub, never a target. Targets come only from a decrypted payload. |
| Replay an old notification | **06 adds:** the plaintext carries a per-Workstation counter and issue time, authenticated by the AEAD. The extension keeps the highest counter seen and drops lower ones. |
| Drop or delay | The inbox is authoritative, not the push: the shell asks each Workstation's attention request on open (spec story 24). A notification is a hint. |
| Correlate | It learns when an agent is waiting on a human, per Device. **06 adds:** ciphertext padded to fixed buckets, and permission ids unlinkable to the Workstation's rendezvous id. |
| Reach a Workstation | No. It holds no Noise key and no hardware key. |

**Residual.** Spam and generic-text phishing until the fallback is fixed as above, and
the timing metadata. Permissions expire (90 days, per the gateway card) and are rate
limited per Device.

### CT-7 — A script in the desk's own page pairing a Device

**Who.** A2 via S8 (AS-01: any script in the app's origin can `invoke` every command).
This is the threat companion card 31 found. Now that the Relay carries a transport, the
six-digit code protects a *human's comparison*, not a script's confirmation. A script
can call `set_remote_access` with a Relay it chose, `begin_pairing` (which returns the
QR string, secret and admission token included), hand the string to its own Device, and
call `confirm_pairing`. After step 2 of the build order that row is full control of the
Workstation.

**What stops it.** Since companion card 31, `confirm_pairing` is a gated command: the
host refuses it without a token minted for that `device_id` and those six digits
(`confirm_gate::pairing_subject`). `begin_pairing` and `set_remote_access` stay ordinary,
with the reasons recorded in `commandGate.test.ts`. What remains is the page-drawn
prompt, below.

**06 requires, before the Remote role has any reach (§6, the gate before step 2):**

- `confirm_pairing` behind the confirmation gate, bound to the `device_id` **and** the
  six digits, so a token for one pairing cannot confirm another;
- an explicit, recorded classification of `begin_pairing` and `set_remote_access` in
  `commandGate.test.ts`;
- and it says what remains, which is what `confirm_gate.rs` itself says: a page-drawn
  confirmation can be asserted by a script that knows gavin. Closing that takes a
  confirmation drawn by the host in a surface the page cannot script (Q15).

A Device cannot mount this attack, because Trust commands are refused to it (§5.3). It
is a threat from the desk's page only.

### CT-8 — A hostile process taking the forwarding seat

**Who.** A1, or an agent (A2 with a shell reads `daemon.token`, AD-4).

**Why it is new.** The desk opens a forwarding connection to the daemon, over which
Devices' commands travel and results and events return. Whoever holds that seat sees
every forwarded call (file contents, terminal I/O) and can answer with fabricated
results and events. It is the DP-06 squatting problem, moved.

**What stops it.** Only a token-proven `app` connection may declare itself the
forwarding connection (the `Hello` connection-kind field that ticket 05 added, which
ticket 12 gives a forwarding value; `agent`, `local` and `remote` cannot). **06 adds:** exactly one seat, and a second claimant is *refused*, not
allowed to displace a live holder; the desk shows that it holds the seat. When the seat
is empty the daemon answers "desktop app not running", so a Device is never left
waiting on nobody.

**Residual.** A1 or A2 that can read `daemon.token` can take an *empty* seat, and show a
Device fabricated state. That is AD-1 and AD-4 (same-uid means the whole protocol) and
stays accepted. The refusal rule removes only displacement of a live desktop.

### CT-9 — A dev build meeting a real Device

Four ways, each closed in §5.7: a debug shell in the wild trusting the dev key; a dev
daemon dialing the publisher's Relay because the trust store is shared; a
`software-debug` Device row paired through a dev daemon and later honoured by a release
one; and a dev bundle offered to a store shell.

---

## 5. The mechanisms

### 5.1 Keys, pairing, and the trust store (replaces 05 §8's key custody; 05 §3 stands)

**Two keys per Device (ADR 0001, as amended).** One pair per install, shared across
every Workstation.

| | Noise static key | Hardware key |
|--|------------------|--------------|
| Algorithm | X25519 | P-256 |
| Where | iOS: a generic-password keychain item, `WhenPasscodeSetThisDeviceOnly`, not synchronizable. Android: 32 random bytes sealed by a Keystore AES-256-GCM key (`setUnlockedDeviceRequired(true)`) in `noBackupFilesDir`, backup and device transfer excluded. | iOS: the Secure Enclave, `.privateKeyUsage` + `.userPresence`. Android: StrongBox, else the TEE. |
| Exportable | Yes, by necessity: the WASM core does the Diffie-Hellman | No |
| It is | the channel's identity and lookup key | the Device's proof of presence and its non-copyability |
| Stolen alone it gets | a handshake and no answered request | nothing: it cannot be extracted |

05 §8 said the key "never leaves the Secure Enclave". That was wrong for the Noise key
(the Secure Enclave holds only P-256) and ADR 0001 corrects it: what holds is that a
copied Noise key is worthless without the hardware signature.

**Where the Noise key is used (ADR 0002).** The Companion is a Capacitor app with no
Rust host, so the Noise handshake, framing and the SAS run as the Companion core
compiled to WASM inside the shell's web layer. That is why the Noise key must be
exportable, and why the shell's web layer is inside the key boundary. It is also why
the SAS cannot drift from the daemon's: it is the protocol crate's own code, not a
reimplementation (ADR 0002's cross-implementation worry is closed by sharing the
source, not by test vectors alone).

**What the pairing ceremony keeps (05 §3).** The `XXpsk3` handshake, the published SAS
(reused byte for byte from `protocol::pairing_sas`), the Reject button, one offer at a
time, the desk's confirmation, the 64-character sanitised name, `devices.sqlite` at
`0600` beside the socket, one trust store per machine and not per build, ninety days
unseen then re-pair, and Revoke dropping live connections.

**The six amendments.**

1. The pairing payload carries the Device's **hardware public key**, and the trust
   store gains a column for it: an `ALTER TABLE … ADD COLUMN` beside the `CREATE TABLE`,
   its duplicate-column error swallowed, proven against a database built by hand with
   the phase-2 schema (the `pre_v*` pattern in `CLAUDE.md`).
2. **On Android the payload carries the attestation chain.** A release daemon checks it
   against Google's hardware roots and requires TEE or StrongBox, the authorisation
   list (user auth, the window, unlocked-device-required) and the challenge. Do not
   read `FEATURE_HARDWARE_KEYSTORE`; it is `true` on the emulator, whose keys are
   software (spike §2). iOS has none (CT-2).
3. **The device cap rises from three to five.** The ninety-day expiry stays.
4. **The QR carries the Relay URL and the admission token.** This relaxes 05 §3's "must
   not carry the relay's own credentials", for the reason in CT-3: the token is a
   ticket to the Relay and the pairing secret never touches it. The token outlives the
   two-minute window, so a photograph of a QR keeps it (Q3).
5. **Each pairing agrees a per-Workstation notification key** (§5.6).
6. **06 adds:** the row records a **key kind** (`hardware`, `software-debug`). A release
   daemon refuses a `software-debug` row **on every connection**, not only at pairing
   (§5.7). Without this the shared trust store turns a dev pairing into a release
   Device.

**Pairing is refused without a hardware keystore and a set passcode.** Both keys are
`WhenPasscodeSetThisDeviceOnly` on iOS. Removing the passcode deletes both, and
Android's `KeyPermanentlyInvalidatedException` does the same, so the Device pairs again
(spike §1).

**A reinstall is a new Device.** Android's uninstall deletes the keys. **iOS keychain
items survive an uninstall** (measured), so the shell wipes every item it owns on first
launch, gated by a marker an uninstall does remove. Without that a reinstall would
silently revive the old Device, and spec story 7 would be false on iOS.

**What lives where on the Workstation, unchanged.** The daemon's static private key, the
notification keys and the admission token sit in a `0600` file behind a `0700`
directory (05 §3, §11 Q10). Under ADR 0004 the Remote role can read them (CT-1). Keychain
custody would not change that, because the Remote role has a shell as the same uid, so
it stays a later hardening.

### 5.2 The Unlock (ADR 0004, ADR 0001, spike §1)

**Two halves, enforced by different parties.**

| | Enforced by | What it guarantees |
|--|-------------|--------------------|
| **The hardware half** | the phone's hardware; the daemon verifies the signature | Every *new* connection followed a recent authentication, and the phone was unlocked. iOS: the authentication held in the context the shell keeps from its Unlock. Android: any authentication on the phone within the key's window T, **including unlocking the lock screen**. |
| **The shell's half** | the shell, honestly | "Since the Companion last came to the foreground". Neither platform's hardware can know it. The shell drops the held context or forgets the window on background and on lock, and drops every connection. |

**What the daemon can and cannot know.** It enforces *a connection began with a
hardware-attested presence, bound to this handshake*. It cannot observe foreground, and
it cannot end a live connection when the Unlock ends. Code running inside the shell on
an unlocked phone could skip the shell's half, and not the hardware's. That is the
line ADR 0001 draws, and 06 states its edge:

- **A tampered or compromised shell keeps live connections open** past the Unlock's
  end. Only new ones need the hardware. Q2 asks whether to cap a connection's age.
- **On Android, for T after any phone unlock**, code in the shell can sign a new
  connection without the app's prompt. T is 1 hour by the spike's recommendation and
  awaits the owner (Q7).
- **On iOS**, whether the Secure Enclave honours the held context for repeated signs
  with no hidden expiry, and refuses while the phone is locked, is a device test, not a
  measurement.

**What ends it.** Shell: iOS `didEnterBackground` and `protectedDataWillBecomeUnavailable`;
Android `ProcessLifecycleOwner` `ON_STOP` and `ACTION_SCREEN_OFF`; never
`willResignActive`, `onPause` or focus loss (Control Center, the call banner and the
Unlock's own prompt must not end it). Hardware: T elapsing, the phone locking, the
passcode being removed. Not a new biometric enrolment (`.userPresence`, not
`.biometryCurrentSet`, which would destroy the Device on every enrolment).

**The signature (ADR 0001).** After `IK`, the Device sends one message: the hardware
signature over the handshake hash. **06 adds:** it signs `"gavin-device-unlock-v1" ‖ h`
and nothing else, where `h` is the final handshake hash. The hash covers both static
keys and both ephemerals, so a signature is bound to one connection to one Workstation
and cannot be replayed to another, which is what closes CT-4 row 3. The context string
means the hardware key never signs a value that could be meaningful in another
protocol. The plugin refuses any other length and builds the context itself, so the
shell's web layer cannot ask the key for a signature over bytes of its choosing.

**Per-connection accounting (CT-2).** A connection counts against a Device's cap only
after its signature verifies; an unsigned one is dropped after a short deadline;
handshake-without-signature is counted per Device.

**The passcode fallback (ADR 0004).** Anyone who knows the passcode can Unlock. It is
accepted, and CT-1 case (b) says what it costs.

**Rejected: one hardware signature per Unlock certifying an in-memory session key.**
Code in the app could copy that key and connect from anywhere until it expired. A
per-connection hardware signature can only ever be made on the phone. (ADR 0001.)

**Rejected: an Android key that requires authentication per use.** It prompts once per
signature, and the Unlock exists to avoid exactly that. (Spike, measured.)

### 5.3 The Remote role and the command table's policy (replaces 05 §6)

**What a Device can send (ADR 0003).** Exactly three things: forwarded desktop commands
and event subscriptions, gated by the command table; the attention request; removing its
own Device. Anything else is refused *before any handler runs*. The daemon's own
`Request` variants (`CreateSession`, `WriteInput`, `Shutdown` and the rest) are not in a
Device's vocabulary at all. `authorize` for `remote` is therefore a short exhaustive
`match` over message kinds, and the daemon's 62-arm walk remains the gate for `app`,
`local` and `agent`.

**The table.** It lives in the protocol crate, so the daemon that enforces it and the
desk that tests it read the same one. It maps every desktop command name to allowed or
refused for the Remote role.

| Refused class | Why |
|---------------|-----|
| **Trust**: `begin_pairing`, `confirm_pairing`, `reject_pairing`, `revoke_device`, `revoke_all_devices`, `set_remote_access`, and the Relay and push configuration | ADR 0004's one exception. Managing Devices stays at the desk. A Device may remove **itself** (the daemon message, not a command). `list_devices` is the one Trust-adjacent read: `DeviceInfo` carries no key material (05 §7) and spec story 58 wants every client to show who is connected, so it is allowed, and the completeness test forces the decision to be written down. |
| **Layout-saving**: `set_workspaces_state` and the rest of the desk's layout (ADR 0006) | A Device must never rearrange the desk, and a desk window's next layout save would undo a phone's change. `set_workspace_settings` is allowed, and refuses a patch naming a layout key whole. |
| **Window management** | Meaningless away from the desk. |
| **The updater**, `download_and_install` above all | It installs and executes new code on the Workstation. `RELEASING.md` already keeps the page out of it. |
| **Opening things on the desk**, `open_path` and the opener plugin (AS-09) | Meaningless remotely, and it launches apps and files on the desk. |
| Anything else meaningless away from the desk (the desk's clipboard, its OS notifications) | Nothing to do remotely. |
| **Allowed:** everything else | ADR 0004. |

**Two directions of failure, both closed.**

- **Build time: no default.** Adding a desktop command without deciding the Remote
  role's answer fails a test: the table's keys must equal the host's registered command
  set, in both directions. `commandGate.test.ts` is the precedent (an exhaustive
  classification, "there is no default"), and ADR 0006's three parity tests are the
  model for the shape.
- **Run time: default deny.** A command name the daemon's table does not contain is
  refused. That covers a newer desk against an older daemon (an old daemon has an old
  table and fails closed) and any name a bundle invents. The desk's dispatcher **checks
  the same table again** (**06 adds**): the table is the only ACL for forwarded calls,
  so it is worth reading it from both ends.

**The dispatcher must not route through Tauri's IPC.** (**06 adds**, and it is the
requirement most likely to be broken by accident.) A Tauri command name also reaches
`plugin:*` commands: `plugin:opener|open_path`, `plugin:updater|download_and_install`,
the clipboard and dialog plugins. The dispatcher maps a name to *the same handler
functions the webview's `invoke` reaches* (spec, "Forwarding to the desktop app"), and
those are the app's own commands. It must resolve names only against the table's
allowed, app-owned entries, so a plugin name is unknown and refused. If it resolved
names through Tauri's router, the capability ACL (which is narrow on purpose, AS-01)
would be replaced by the table's "allowed: everything else" and the plugin commands
would be reachable.

**The table gates names, not arguments.** A Device can pass any path to the file viewer
and add any folder as a workspace. That is ADR 0004 (§2, and the R4 note above), and it
is stated here so that nobody later files it as a finding.

**Events need a table too.** **06 adds.** The spec gates *commands*. But the desk
offers **every event it emits to its webview** to the forwarding connection, and the
daemon relays them to subscribed Devices. Some events belong to Trust
(`device-pairing-requested`, with its SAS, and the connect and disconnect pushes) or to
surfaces a Device may not use. **A second table, keyed by event name, same completeness
test, default deny.** Presence events are allowed, because every client shows who is
connected (spec story 58).

**Attribution.** The daemon sees the desk. **06 adds:** every forwarded call carries the
originating `device_id` (the spec already does this for phone-started sessions), and
the daemon keeps a bounded **journal per Device**: the command name, a timestamp and
the Device, with no argument values. It answers "what did my phone do while I was away"
(spec story 60) and it is the forensic record after CT-1 (Q5).

**The confirmation gate is not a second human.** Forwarded destructive commands pass
through the same `confirm_gate` state as the desk's. The confirmation is drawn by the
Device's own bundle, so it has the property `confirm_gate.rs` records for the desk: it
stops accident and generic payloads, not a script that knows gavin (AS-05). For a Device
it adds no independent check, and ADR 0004 accepts that.

**Integrity invariants.**

- **The Companion never starts the rail scheduler.** It would launch every rail twice.
  The desk window is the only place rails tick (S10, ADR 0003).
- **A Device's view state stays on the Device** and never calls a layout-saving command.
- **Settings a Device can weaken are recorded, not restricted:** the review gate
  (AG-01's fix), auto commit, git tracking and `[agent] command`. AD-6 now means "whoever
  holds an Unlock" (Q14).

**Caps.** 05 §8's 64 KiB channel line stands, with chunking for larger payloads (files,
snapshots); a per-connection request rate; two concurrent connections per Device *per
Workstation*, one streaming and one request/reply (05 §8); five Devices per Workstation.

### 5.4 The transport and the Relay (05 §5 stands)

Unchanged: the daemon dials out and holds a WebSocket over TLS; Noise `IK`
(`Noise_IK_25519_ChaChaPoly_BLAKE2s`); AEAD frames with per-direction counters, padded
to 256 bytes, rekeyed hourly or at 2^16 frames; the plaintext is the daemon's JSON.
Direct LAN and Tailscale are out of scope for this work (spec).

**Amendments.**

- **The admission token** is required of daemons and Devices and is the first frame. It
  authenticates nothing about a Workstation (CT-3).
- **The Relay is untrusted** for confidentiality and integrity, and trusted for
  availability only. Its operator sees the metadata in CT-3, including the
  cross-Workstation correlation.
- **The public Relay** is run by the publisher, free, with per-Workstation bandwidth
  limits. **Self-hosters** run a signed image pinned by digest (`RELEASING.md`).
- **In release builds the Relay URL must be `wss://`.** A plain `ws://` is allowed only
  where §5.7 allows a dev Relay.
- **Reconnect** resumes the *connection*, never a command (CT-3).
- **The QR's secrets have different audiences.** The pairing secret is for the
  Workstation and the Device only, single use, two minutes. The admission token is for
  the Relay. The Relay must never see the first.

### 5.5 Bundle signing and the bridge-less webview (ADR 0005; the store research)

**Four layers, each answering a different question.**

| Layer | Answers | Does *not* answer |
|-------|---------|-------------------|
| **Containment**: a separate bridge-less webview, one shell-owned channel | What can any bundle, signed or not, reach? (Not the keys, not other Workstations, not a native API.) | Whether the code is the publisher's. |
| **Signature**: a signed manifest of content hashes | Is this code the publisher's? (Store compliance: "content owned by the app developer"; and unsigned code never gets even the channel.) | What the code does with the channel. |
| **The channel's closed message set** | What may a bundle say? | Whether what it says is wise. |
| **A shell-set CSP and a native chrome** | Can a bundle load, or impersonate, anything else? | — |

**Containment, as measured (spike §4).** These are conditions, not features:

1. **A bundle is never loaded in the shell's Capacitor webview, not even in an iframe.**
   Choosing Capacitor (ADR 0002) means choosing its bridge, which hands every plugin to
   any script in its webview: iOS's `bridge` handler answers every frame, and a
   cross-origin iframe invoked a plugin natively. The shell page carries
   `frame-src 'none'` and never navigates to remote content.
2. **The channel checks natively:** `WKScriptMessageHandlerWithReply` accepting only
   `isMainFrame` with the bundle's scheme and host (iOS); `addWebMessageListener` with
   the origin, plus an `isMainFrame` check (Android). No `addJavascriptInterface`.
3. **An app-local origin per Workstation**, with its own data store: a
   `WKURLSchemeHandler` scheme on iOS, an intercepted host on Android. Every other
   navigation and sub-resource is refused. **06 adds:** the *shell's* scheme handler
   sets the CSP, so a signed bundle cannot loosen its own.
4. **On Android the bundle's webview runs in its own app process** (`:bundle`, with
   `setDataDirectorySuffix`). Otherwise it shares one renderer with the shell's webview,
   which holds the Noise key and every live connection.
5. **Only the shell's own web layer** sees the Noise private key. The hardware key
   never leaves native code.

**The channel (ADR 0005).** A closed, versioned set of typed messages: invoke and
result, listen, event and unlisten, a capabilities query, open an external link, and
return to the hub. It accepts messages only from the bundle's origin, reaches only that
Workstation, and carries no plugin, crypto, file or keychain call. The shell answers the
capabilities query itself. **06 adds** message size and rate caps.

**Signing.**

- A detached signature over a **manifest** listing every file's content hash, a bundle
  serial, the desktop commit and the channel's message-set version. The shell verifies
  the signature against its pinned key set, then each file against the manifest, then
  serves only listed paths. It verifies at fetch and again when loading from the cache.
- **Key custody follows `RELEASING.md`:** a separate GitHub Actions secret (never the
  updater's `TAURI_SIGNING_PRIVATE_KEY`), a required passphrase, generated on a machine
  that does not run agents, `preflight` failing a release with no key and refusing an
  empty pinned public key.
- **The public key is pinned in every store shell**, and, like the updater's, there is
  nothing to revoke: a leaked key can sign for every shell that has ever shipped until
  each is updated. **06 adds:** pin a **set** of keys (current and next) from the first
  release, so rotation is a store release that adds one and retires another without
  stranding installs.
- **Rollback (CT-4 row 9, CT-5).** **06 adds:** a monotonic serial in the manifest, and
  a floor compiled into each shell release; a lower serial is refused with "update this
  Workstation". Whether a shell also remembers a per-Workstation high-water mark is Q6.
  A Workstation whose owner *legitimately* downgrades the desktop meets the same message.

**The Demo Workstation** is embedded in the binary and speaks the same channel. Its
origin is reserved: a served bundle cannot claim it.

**External links** open in the system browser: web links only, from a user gesture, with
the host shown first. Nothing else navigates.

**What the store review sees (ADR 0005).** The UI served by the user's own Workstation,
signed by the publisher; new native capabilities ship as store releases. The residual
review risk (2.5.2, the 2020 HTML5 notice) is the spec's and the research's, not a
security control.

### 5.6 End-to-end encrypted notifications

**The path.** The desk decides what to notify; the daemon encrypts each payload with the
Workstation's notification key **for that Device**, and posts the ciphertext with the
Device's **send permission** to the Push gateway over outbound HTTPS; the gateway checks
the permission, rate-limits per Device, and forwards the ciphertext untouched to Apple
or Google; the phone decrypts before display (a Notification Service Extension on iOS,
a data message on Android). Pushes also carry "resolved", so an item handled at the desk
leaves the phone.

**Custody.**

| Party | Holds | Never holds |
|-------|-------|-------------|
| The Workstation's daemon | the notification key, the send permission | the push credentials |
| The Push gateway | the push credentials, its permission-signing key | any plaintext, any notification key |
| Apple, Google, the Relay | ciphertext | any key |
| The Device | the notification keys; its push token | — |

**06 adds, the payload rules** (CT-6):

- The AEAD plaintext carries a version, a per-Workstation **counter** and an issue
  time, the item id, kind, text and target. The extension keeps the highest counter per
  Workstation and drops replays.
- The extension tries each Workstation's key and takes the label from **the key that
  decrypted it**, not from the payload.
- The visible alert is a **fixed generic string**. A failed decrypt shows only that and
  a tap opens the hub. A target comes only from a decrypted payload.
- Ciphertext is padded to fixed buckets, and the send permission's id is unlinkable to
  the daemon's rendezvous id.

**Revocation.** Revoking a Device deletes its notification key and permission on the
Workstation, so the Workstation stops sending. The permission itself lives at the
gateway until it expires or the Device cancels it (a lost phone cannot). Expiry
(90 days) and per-Device rate limits bound a leaked permission. "Revoke all" rotates the
Workstation's keys.

**Lock-screen text is readable by design** (spec story 28). Anyone who can see the lock
screen reads it. The platform's own preview setting governs; whether the Companion adds a
"hide contents" mode is Q9.

**Open, from the gateway card:** "resolved" on iOS. Every push is a visible
mutable-content alert today, so a background push type or the filtering entitlement has to
be chosen without weakening the generic-fallback rule above.

### 5.7 The dev key and the dev-Relay guard (relaxes 05 §11 Q12)

**Why they are one mechanism.** 05's Q12 refused remote access in a `tauri dev` build,
because a dev build has a live vite server and an HMR socket (AD-7, SC-09) and "a paired
phone should never meet either". The spec relaxes that to a dev build that may enable
remote access only against a Relay on loopback or the LAN. The dev key does the same for
bundles. Both exist so that development does not require a public service, and neither
may be the way a dev build reaches a real Device.

**The dev key.**

- Debug builds of the Companion trust a dev signing key **generated on the developer's
  machine**. The desktop's dev build signs its bundle with it.
- **Store builds compile the dev trust path out.** It must be absent from the release
  configuration, not disabled by a runtime flag a bundle or a config could flip. A build
  check on the release artifact and the existing test (a store build refuses a dev-key
  bundle) both run.
- The dev key can sign only for debug shells. If it leaks, the loss is the developer's
  own debug shells (A1 on a developer machine, `00`).

**The `software-debug` key kind.** Simulators and emulators cannot hold a presence-gated
hardware key (spike §2), so debug builds use a software key marked as such. The mark is
**self-declared**, so it guards against accident, not against an adversary. **06 adds:**

- the trust-store row records the kind (§5.1);
- a **release daemon refuses a `software-debug` row on every connection**, and may purge
  it, because `devices.sqlite` is shared between a dev daemon and a release daemon on
  one machine (05 §3: one trust store per machine, so one daemon key, one set of Device
  rows, one remote-access switch);
- a debug daemon accepts them, and only a debug daemon.

**The dev-Relay guard.** A dev desktop build may enable remote access only against a
Relay on loopback or the LAN.

- **It lives in the dialing process.** The daemon dials, so the daemon enforces it, keyed
  on **its own build profile**, not on a flag the app sends. The app's UI refusal is a
  courtesy; a script's `set_remote_access` (CT-7) or a hand-written request would
  bypass it.
- **It checks the address it connects to.** **06 adds:** it resolves the host, requires a
  private address, connects to *that* address, and checks the connected peer before
  sending a byte. A name that resolves to a LAN address at check time and a public one at
  dial time (rebinding, or a service like nip.io) fails. Redirects are not followed.
- **"Loopback or LAN" means:** `localhost` and `127.0.0.0/8` and `::1`; RFC 1918;
  link-local (`169.254.0.0/16`, `fe80::/10`); unique-local (`fc00::/7`); and `.local`. An
  IPv4-mapped IPv6 address is unmapped first. Whether the carrier-grade range
  `100.64.0.0/10` (where Tailscale lives) counts is Q11.
- **`TAURI_DEV_HOST`** (SC-09) publishes the dev server to the LAN. It is the developer's
  choice, and is worth a line in the dev-setup docs next to the guard.

**The local dev stack.** The compose file starts a Relay and a sandboxed Push gateway
(`GAVIN_PUSH_DELIVERY=dry-run`), which never contacts Apple or Google. **06 adds:** the
stack ships no push credentials, and dry-run refuses to start if any are present, so
the sandbox cannot be turned live by accident. The dev Relay's admission token is a
known constant; it is safe because the guard confines it to loopback and the LAN.

### 5.8 What this pass adds to the spec and the ADRs

Everything marked **06 adds**, for the owner to accept or strike. None contradicts an
ADR.

| # | Addition | Section |
|---|----------|---------|
| 1 | A second table for **events**, same completeness test, default deny | §5.3 |
| 2 | The hardware key signs `"gavin-device-unlock-v1" ‖ h` only; the plugin builds the context and refuses other lengths | §5.2 |
| 3 | A connection counts against the Device cap only once signed; unsigned ones dropped after a deadline; handshake-without-signature counted per Device | §5.2, CT-2 |
| 4 | A **key-kind** column; release daemons refuse `software-debug` rows on every connection | §5.1, §5.7 |
| 5 | The dispatcher resolves names only against the table's app-owned entries (never through Tauri's router, so `plugin:*` is unreachable), and re-checks the table itself | §5.3 |
| 6 | Exactly one forwarding seat; a second claimant is refused | CT-8 |
| 7 | The shell never auto-re-sends a forwarded command after a reconnect; per-connection request ids | CT-3 |
| 8 | A signed **bundle serial** with a floor per shell release; a **set** of pinned bundle keys | §5.5 |
| 9 | Native chrome the bundle cannot cover; the shell sets the CSP, not the bundle | CT-4, §5.5 |
| 10 | Notification payload rules: counter, generic fallback text, label from the decrypting key, padding, unlinkable permission ids | §5.6 |
| 11 | Dev-Relay guard specifics: enforced in the daemon, checks the connected peer, no redirects, `wss://` only in release, a stack with no push credentials | §5.7 |
| 12 | A per-Device **journal** of forwarded commands at the daemon (names, times, no arguments) | §5.3 |
| 13 | Hard caps and sanitisation on everything the shell parses from a Workstation | CT-4 |

---

## 6. The build order (replaces 05 §10)

The spec's order stands. This section adds what each step must prove, and the one
ordering constraint the security work needs. The typing prototype and the spikes run
first in parallel. The typing prototype is done, and the device-keys spike answered its
questions (with device tests outstanding, §5.2).

| Step | Lands | Security exit (what it must prove) | Must not yet |
|------|-------|------------------------------------|--------------|
| **1. The Relay, the daemon transport, the test Device** | the Relay crate and its admission token; `remote.rs` dialing; `XXpsk3` pairing through the Relay; `IK` and the hardware signature; the trust-store column and migration; five Devices; revocation dropping live connections | seam 1: a store row only after the desk confirms; a missing or wrong signature answers nothing; a signature from another handshake is refused; `IK` fails after "Revoke all" (**the proof 05 still owes**); a missing admission token is refused; a Relay that replays or tampers gets a failed handshake or dropped frame; a daemon token over the remote path is ignored; nothing dials with remote access off; a sixth Device is refused; unsigned connections do not consume slots | give the Remote role any reach beyond refusing every request; point a store build at a public Relay before the signed image and the self-hosting docs exist |
| **Gate before step 2** | **card 31: `confirm_pairing` behind the confirmation gate** | CT-7 closed as far as a page-drawn confirmation can close it | — |
| **2. Forwarding, the command table, the desk's dispatcher** | the table in the protocol crate; the forwarding connection; the dispatcher; the event table; the attention request's route | table keys equal the host's registered commands, both directions; an unknown name, a Trust command and a layout command are refused before forwarding; a plugin name is refused; events reach only subscribed Devices; "desktop app not running" when the seat is empty; a second seat claimant is refused; the rail scheduler never starts | forward anything the table has not decided; let a Device reach a Trust command |
| **3. The shell: pairing, the Unlock, the hub, the Demo Workstation** | Device keys (spike parameters); pairing through the Relay; the Unlock lifecycle; the hub and the attention inbox | keys created with the spike's parameters; pairing refused with no hardware keystore or no passcode; the iOS first-launch wipe; the Unlock ends on background and lock and not on Control Center; the hub renders Workstation text as plain, capped text; Android attestation verified by the daemon | run any served bundle |
| **4. The served-bundle channel** | signing; the bundle webview; the channel; the cache | a bad signature refused; a store build refuses a dev-key bundle; a bundle below the serial floor refused; a plugin call from the bundle webview fails (probe); a message from another origin is dropped (probe); navigation outside the app-local origin blocked; the bundle's own process on Android; native chrome present | ship the dev trust path in a store configuration |
| **5. The first end-to-end build, submitted for full store review, manual release** | — | a check on the release artifact: no dev key, no `software-debug` acceptance, no `ws://` | release without a human |
| **6. Notifications and the Push gateway** | encryption, the gateway registration and permissions, the extension | round trip; an undecryptable push shows only the generic string; a replay is dropped; the label follows the decrypting key; cancelling one Workstation's permission leaves the others working; no plaintext in any log | send a plaintext payload, ever |
| **7. The surfaces, made responsive** | terminals, board, rails, git, files, settings | every command a surface adds has a table entry (the completeness test); no surface calls a layout-saving command; destructive actions pass the confirmation gate | — |

**Device tests owed before step 3 can be called done** (they cannot be settled in a
simulator): the Secure Enclave honouring a held context with no hidden expiry; the phone
locking ending signing even with the context held; Control Center and the call banner
leaving the Unlock intact on iOS; StrongBox or TEE security levels and attestation on
real Android hardware; and whether Capacitor 8.5.2 hits the iOS 27 prompt hang on a
physical phone.

---

## 7. Open questions for the human

1. **Can a stolen phone's Device be revoked away from the desk?** ADR 0004 keeps Trust
   at the desk, so today it cannot. The phone can be erased, the human can wait until
   the desk, and CT-1's response is at the desk. — Default: none in the first release;
   the docs say "Revoke all at the desk and erase the phone". A later option is a
   Device revoking *other* Devices behind a fresh Unlock.
2. **Should the daemon cap a Device connection's age**, forcing a new handshake and
   signature, so a tampered shell cannot hold a connection past the Unlock? — Default:
   no cap beyond Noise's hourly rekey (ADR 0004's laptop model), with the journal as the
   record.
3. **What does the admission token authorise, and how long does a photographed QR
   keep it?** One shared token per self-hosted Relay, or one per Workstation on the
   public one? Rotated on each `BeginPairing`? — Default: per-Workstation on the public
   Relay, per-Relay when self-hosted, rotated on each pairing.
4. **Adopt the event table (§5.3, addition 1)?** — Default: yes. Without it the
   command table has a side door.
5. **Adopt the per-Device journal of forwarded commands (addition 12), and how long
   does it keep?** — Default: yes, bounded, names and times only.
6. **Does the shell also remember a per-Workstation bundle serial high-water mark**, in
   addition to the floor compiled into each shell? — Default: no. A legitimate downgrade
   of a desktop should not be refused by history, only by the floor.
7. **The Android auth window T.** The spike recommends one hour, and the owner's
   decision is pending on ticket 02. — Default: one hour.
8. **Accept that the daemon cannot verify iOS hardware binding**, and rely on the desk's
   confirmation? — Default: accept, and record it in the pairing prompt's copy.
9. **Should the Companion offer a "hide notification contents" mode** (generic text on
   the lock screen, real text on open)? — Default: no in the first release; the OS's
   preview setting decides.
10. **Native chrome around the bundle (§4 CT-4 row 6).** Required, or a hardening for
    later? — Default: required before step 4 ships.
11. **Is `100.64.0.0/10` "the LAN" for the dev-Relay guard?** — Default: no. A Tailscale
    Relay is a real Relay.
12. **Who holds the bundle-signing key, and where is the master copy kept?** —
    Default: `RELEASING.md`'s rule for the updater key: one named human, off any machine
    that runs agents, and a copy in a GitHub Actions secret.
13. **Should the Remote role be refused file access inside gavin's own data directory?**
    It would stop a casual read of the daemon key and would be defeated by the shell the
    same role holds. — Default: no. State the limit; don't build a fence with a gap.
14. **Should the review gate (AG-01's fix), `[agent] command` and tool bodies be
    desk-only settings**, refused to the Remote role, so that a stolen unlocked phone
    cannot switch the review off? — Default: no (ADR 0004 says a Device may configure).
    It is the cheapest place to narrow ADR 0004 if the owner wants to.
15. **Is pairing the case that justifies a host-drawn confirmation** (a surface the page
    cannot script)? It would also serve Revoke all. — Default: yes, and file it once
    card 31 lands.
16. **Where does the per-Device failure threshold (CT-2) surface at the desk?** A
    badge on the Devices footer row, a line in the panel, or an OS notification? —
    Default: the panel and a badge; nothing that can be mistaken for a pairing prompt.
