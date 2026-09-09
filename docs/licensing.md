# Licensing — dependency audit and the choice for Gavin

Audit of commit `87cefbf` (`PROTOCOL_VERSION` 34), 2026-09-09, on `main`. Raw census
output is under [`licensing/`](licensing/); this document summarises it and does not
paste it. Nothing in the repository was relicensed by this pass: it is an assessment,
and the LICENSE file it recommends is not yet written.

The question it answers, in the owner's words: make Gavin **free for personal use but
not otherwise, while keeping it open source**; protect the work; and let the code be a
showcase on GitHub. Three parts follow — what the dependencies allow, what that
combination of goals is actually called, and what to change in the tree.

Not legal advice. Everything below is checkable against the census files and the
licence texts they name; the one judgement call (which licence to adopt) is flagged as
such and is the owner's to make.

## Summary

**Nothing in the dependency tree constrains the choice.** Every crate and package
resolves to a permissive licence, and the only copyleft present is file-level MPL-2.0
on unmodified registry crates, which imposes no obligation on Gavin's own code. Any
licence is available, including a restrictive one.

**"Free for personal use" and "open source" cannot both be true**, as those terms are
defined. The Open Source Definition's clause 6 forbids restricting fields of use, so a
licence that bars commercial use is *source-available*, not open source. The goal is
achievable; the label is not. Nothing else about the plan changes.

**Recommendation: PolyForm Noncommercial 1.0.0**, with BUSL-1.1 as the alternative if
an eventual conversion to true open source is wanted. Sole authorship across all 1,043
commits is what keeps that decision reversible, and is the thing most worth protecting.

## 1 — What the dependencies allow

| Tree | Packages | Copyleft |
|------|----------|----------|
| Rust, four crates, `--all-features`, all targets | 567 resolved non-workspace crates | 5 file-level MPL-2.0, unmodified |
| npm, everything installed | 163 packages | none |
| npm, runtime closure that ships in the bundle | 42 packages | 1 dual, Apache option taken |

The Rust figure reconciles with the 571 `[[package]]` entries in `Cargo.lock`: 571
minus the four workspace crates (`protocol`, `gavin-daemon`, `gavin-mcp`, `app`) is
567. Full breakdown in [`licensing/rust-licenses.txt`](licensing/rust-licenses.txt) and
[`licensing/npm-licenses.txt`](licensing/npm-licenses.txt).

### Rust

250 crates are `MIT OR Apache-2.0`, 146 MIT, 52 `Apache-2.0 OR MIT`, 27
`MIT/Apache-2.0`, then Zlib, Unicode-3.0, ISC, BSD-2/3-Clause, BSL-1.0 (the Boost
licence, not Business Source), CC0-1.0, Unlicense and `Apache-2.0 WITH LLVM-exception`.
Every crate declares a licence; none is missing one. No GPL, no LGPL-only, no AGPL, no
SSPL, anywhere in the graph.

Three entries that look like problems and are not:

- **The five MPL-2.0 crates** are `cssparser`, `cssparser-macros`, `selectors`,
  `dtoa-short` and `option-ext`. All five arrive through Tauri: four via
  `tauri-utils 2.9.3` → `dom_query 0.27.0`, one via `tauri 2.11.5` → `dirs 6.0.0` →
  `dirs-sys 0.5.0` (traced with `cargo tree -i --target all`). MPL-2.0 is *file-level*
  copyleft: the obligation attaches to the MPL-covered files themselves, and only on
  modifying and distributing them. Gavin modifies none of them, and their source is
  already published on crates.io, so the obligation is satisfied by the fact of their
  publication. Linking them into a differently-licensed binary is the case MPL-2.0
  §3.3 exists to permit.
- **`r-efi`** offers `MIT OR Apache-2.0 OR LGPL-2.1-or-later`. A disjunction: take MIT
  and the LGPL term never applies.
- **`BSL-1.0`** on `clipboard-win` and `error-code` is the Boost Software License, a
  permissive licence with no source-distribution requirement. It is not the Business
  Source License, which is written `BUSL-1.1`.

This agrees with the independent check in
[`security/04-supply-chain.md`](security/04-supply-chain.md) §SC-01, where
`cargo deny check` ran on 2026-09-08 with an allow-list of exactly these permissive
identifiers. Its `licenses FAILED` result was caused solely by the four workspace
crates carrying no `license` field, not by any dependency — the hygiene gap §5 fixes.

### npm

143 of 163 installed packages are MIT, 6 ISC, 5 `MIT OR Apache-2.0`, 4 Apache-2.0, 3
`Apache-2.0 OR MIT`, 1 BSD-3-Clause, 1 dual MPL/Apache.

Only the 42-package runtime closure of `dependencies` is compiled into the bundle;
everything under `devDependencies` (Vite, Vitest, TypeScript, svelte-check, the esbuild
and rollup binaries) is a build tool that never ships and carries no distribution
obligation. What ships is CodeMirror and Lezer, xterm.js with its fit and web-links
addons, `marked`, `style-mod`, `crelt`, `w3c-keyname` and the Svelte runtime (all MIT),
Lucide icons (ISC), the Tauri API and five plugins (`MIT OR Apache-2.0`), and
DOMPurify.

**DOMPurify** is the one dual-copyleft entry: `(MPL-2.0 OR Apache-2.0)`. Elect
Apache-2.0 in the notices file and MPL never enters the frontend at all.

### Assets, vendoring and the agents

- **No third-party fonts.** Every `font-family` in the app resolves to the system
  stack: 221 `monospace`, 25 `inherit`, 3 `var(--font-mono, ui-monospace, monospace)`,
  2 `sans-serif`. No `@font-face`, no bundled `.woff`/`.ttf`/`.otf`. This is the single
  most common licensing trap in a desktop app and Gavin does not have it.
- **The app icons are the owner's own work**, cut on a pixel grid (`app/src-tauri/icons/`).
- **No vendored third-party code.** A grep for copyright headers, SPDX identifiers,
  "licensed under", "adapted from", "ported from" and "taken from" across
  `app/src`, `app/src-tauri/src` and `crates` returned only Gavin's own doc comments
  using those words in prose.
- **No git, path or `file:` dependencies** in either lockfile: every third-party
  component comes from crates.io or the npm registry, pinned with checksums.
- **The agent CLIs are not dependencies.** Claude Code, Codex, Gemini and opencode are
  spawned as separate processes over a PTY and are never linked or redistributed.
  Their terms bind the user who installs them, not Gavin. Shipping *profiles* that
  describe how to invoke them is configuration data, not derivation.

### The one obligation that survives

MIT, ISC, BSD, Apache-2.0 and Zlib all require their notice to travel with a
distributed binary. Nothing requires it of an unbuilt source repository, so this is a
release obligation, not a repository one: it comes due the day a `.app` is handed to
anyone. Satisfy it with a generated `THIRD-PARTY-NOTICES` inside the bundle
(§5), which is a mechanical step, not a constraint on the licence chosen.

## 2 — "Free for personal use, still open source" does not exist

Not as a matter of opinion, but of definition. The Open Source Definition, clause 6,
"No Discrimination Against Fields of Endeavor", requires that a licence not restrict
use in a specific field, and gives commercial use as its worked example. The Free
Software Foundation's freedom 0 says the same thing. A licence reading "free for
personal use, not for commercial use" therefore cannot be OSI-approved, and GitHub will
render it as "View license" rather than a recognised badge.

The category that fits is **source-available** (sometimes "fair source"): the code is
public and readable, the licence grants less than open source. It is a well-populated
category with mainstream examples, and it delivers everything the owner asked for
except the word.

Worth stating plainly, because it is the usual worry: **the label costs nothing here.**
GitHub's own Terms of Service, §D.5, grant every user the right to view and fork any
public repository regardless of its licence. A reader, a recruiter or a hiring manager
sees identical code either way.

## 3 — The options

| Option | Personal use free | Commercial use | OSI open source | Reversible later |
|--------|-------------------|----------------|-----------------|------------------|
| **PolyForm Noncommercial 1.0.0** | yes | forbidden | no | yes, sole author |
| **BUSL-1.1** + personal-use grant | yes | forbidden until the change date | not yet, then yes | yes |
| **AGPL-3.0 + commercial dual** | yes | *allowed*, but forks must open | yes | harder, needs a CLA |
| Permissive (MIT/Apache) | yes | allowed | yes | no, irrevocable |

**PolyForm Noncommercial 1.0.0 — the recommendation.** It is the exact fit, written in
plain language by lawyers for this purpose, and carries the SPDX identifier
`PolyForm-Noncommercial-1.0.0`. Its permitted-purpose clause covers "personal study,
private entertainment, hobby projects, amateur pursuits", research, experiment and
testing, plus any charity, educational institution, public research body or government
institution regardless of funding. It includes a patent grant and a notices
requirement. It has no trademark clause, which §4 addresses separately.

**BUSL-1.1 — the alternative if a conversion is wanted.** Set the Additional Use Grant
to personal, non-commercial use and a Change Date at most four years out, after which
the licence converts automatically to Apache-2.0 or GPL. It offers the best story for a
portfolio piece ("source-available now, open source in 2030") at the cost of a more
complex header and a promise that binds a future self.

**AGPL-3.0 plus a commercial licence — the only genuinely open-source route**, and it
does not do what was asked. AGPL permits commercial use; a company may run Gavin
internally for free forever. What it prevents is a proprietary fork or a closed hosted
service. In practice many organisations treat AGPL as "buy the commercial licence",
which is why the dual model works commercially, but it is a different bargain from the
one described. It also requires a contributor licence agreement the moment anyone else
contributes, since dual-licensing needs undivided ownership.

**Avoid three things.** CC BY-NC, because Creative Commons states in its own FAQ that
its licences are not designed for software and address neither source code nor patents.
The Commons Clause, because bolting it onto a permissive licence produces a
contradictory text of contested meaning. And any licence text written from scratch: a
bespoke restriction is unenforceable in the places it is vague and off-putting
everywhere else.

## 4 — Protecting the work, and the showcase

- **Copyright already exists.** Under the Berne Convention it arises on fixation, with
  no registration required in Italy or the EU. The LICENSE file, a copyright line and
  the git history are the evidence that matters. US registration is worth considering
  only if litigation there is ever contemplated.
- **Sole authorship is the asset.** All 1,043 commits are by one author. That is what
  makes relicensing, dual-licensing or selling commercial exceptions possible, and it
  ends the first time someone else's pull request is merged without a contributor
  agreement. Either keep external contributions to issues and bug reports, or adopt a
  CLA (the Apache ICLA is the usual template) before accepting code. This is the single
  most consequential thing to get right.
- **The licence does not cover the name or the icon.** PolyForm Noncommercial has no
  trademark clause, so add one line to a NOTICE file reserving the Gavin name and the
  app icon. "Gavin" is a common given name and therefore a weak mark on its own; the
  distinctive icon carries more weight than the word.
- **Agent-written code.** The US Copyright Office's guidance holds that purely
  machine-generated output is not copyrightable, while human selection, arrangement and
  modification are. The strongest part of the claim is therefore the design record:
  the PRD, the specs and plans under `docs/superpowers/`, and the decisions they
  document. Keeping that history in the repository is both good practice and good
  evidence.
- **Enforcement, realistically.** A noncommercial licence deters organisations that run
  licence-compliance scanning, and does essentially nothing against an individual who
  ignores it. That asymmetry is precisely the split requested: hobbyists were going to
  be allowed anyway.

## 5 — What to change in the tree

Nothing here is done yet. Three of these are live contradictions of the stated intent
and should land together with whichever licence is chosen.

| # | Change | Why |
|---|--------|-----|
| 1 | Add `LICENSE` at the root | There is none today. Absent a licence, default copyright reserves all rights, which is *more* restrictive than intended and gives a reader nothing to rely on. |
| 2 | Fix `app/package.json:15`, `"license": "MIT"` | Left by the SvelteKit template. It is a public MIT grant over the frontend the moment the repo goes public, contradicting any restrictive LICENSE beside it. **The most urgent item.** |
| 3 | Add `license` and `publish = false` to all four crate manifests | `cargo deny check licenses` fails on their absence today (SC-01). `publish = false` prevents an accidental crates.io release, which crates.io does not allow unpublishing. |
| 4 | Replace `authors = ["you"]` in `app/src-tauri/Cargo.toml:5` | Template placeholder. |
| 5 | Fill `bundle.copyright` and `bundle.licenseFile` in `tauri.conf.json` | Puts the notice in the built app's metadata. |
| 6 | Generate `THIRD-PARTY-NOTICES` into the bundle | The one real obligation from §1, due at distribution. `cargo about` plus a short script over the 42-package runtime closure. |
| 7 | Add `NOTICE` reserving the name and icon | §4; the licence does not do this. |
| 8 | Write a `README.md` | There is none. For a showcase repo it is the whole first impression: what Gavin is, screenshots, and a two-line licence summary pointing at commercial contact. |
| 9 | Delete `app/static/{svelte,tauri,vite}.svg` | Unreferenced template leftovers; three third-party marks sitting in the tree for no reason. |

Item 2 is worth restating: publishing the repository while that line stands grants MIT
over the frontend to everyone who clones it, and a grant already made cannot be
withdrawn from copies already taken.

## Method and limits

- The Rust census is `cargo metadata --format-version 1 --all-features` filtered to
  `resolve.nodes`, so it covers every optional feature and every target, not just the
  macOS build. Windows and Linux crates are included and counted.
- The npm census walks `app/node_modules` and computes the runtime closure by resolving
  `dependencies` the way Node does, nearest-`node_modules` first. Packages reachable
  only through `devDependencies` are reported but marked as not shipping.
- Both censuses were run twice, on 2026-09-07 and again on 2026-09-09 at `87cefbf`,
  with identical results. Neither lockfile was modified; no dependency was added,
  removed or upgraded by this pass.
- Licence *identifiers* are read from crate and package metadata, not from the licence
  files on disk. Metadata is authoritative for the standard registries and is what
  `cargo deny` and every scanner uses, but a crate whose declared identifier disagrees
  with its bundled text would not be caught here. No such disagreement is known.
- Only the direct claim about Gavin's own code was verified by reading: the
  vendored-code grep, the font sweep and the asset inventory. The judgement in §2 and
  §3 rests on the licence texts and definitions named below, each quoted from its
  primary source rather than from memory.

## Sources

- Open Source Definition, clause 6 — <https://opensource.org/osd>. Verbatim: "The
  license must not restrict anyone from making use of the program in a specific field
  of endeavor. For example, it may not restrict the program from being used in a
  business, or from being used for genetic research."
- PolyForm Noncommercial 1.0.0 — <https://polyformproject.org/licenses/noncommercial/1.0.0>,
  text also at <https://spdx.org/licenses/PolyForm-Noncommercial-1.0.0.html>. Its
  "Personal Uses" clause verbatim: "Personal use for research, experiment, and testing
  for the benefit of public knowledge, personal study, private entertainment, hobby
  projects, amateur pursuits, or religious observance, without any anticipated
  commercial application, is use for a permitted purpose."
- Business Source License 1.1 — <https://mariadb.com/bsl11/>.
- GitHub Terms of Service §D.5, "License Grant to Other Users" —
  <https://docs.github.com/en/site-policy/github-terms/github-terms-of-service>.
  Verbatim: "By setting your repositories to be viewed publicly, you agree to allow
  others to view and 'fork' your repositories."
- Mozilla Public License 2.0, §3.3 on larger works —
  <https://www.mozilla.org/en-US/MPL/2.0/>.
- Creative Commons on software — <https://creativecommons.org/faq/#can-i-apply-a-creative-commons-license-to-software>.
- US Copyright Office, *Copyright and Artificial Intelligence, Part 2: Copyrightability*
  (2025) — <https://www.copyright.gov/ai/>.
