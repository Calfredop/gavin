---
order: 45056
kind: task
title: "[sec] Repository markdown in the card preview and the file viewer can restyle the first-run review sheet with a <style> block, and a plain link click in it navigates the gavin window away"
status: To Do
priority: medium
complexity: moderate
labels: security, ready-for-agent
---
Fix two needs-validation leads from the 2026-10-15 security audit (run-1), merged here because they share the two sinks and the fix. They are not confirmed: the audit traced them in source but could not observe DOMPurify keeping the `<style>` element or the window actually navigating, because no DOM implementation or WKWebView could run where it worked. The failing regression tests below are the proof — write them first and watch them fail. If they already pass before any change, the leads are wrong: record why under a dated "## Comments" heading and move the card to Done with no code change. Fingerprints: `app/src/lib/cards/CardDetailModal.svelte:DOMPurify.sanitize:default-config-keeps-style` and `app/src/lib/files/markdown.ts:renderMarkdown:no-anchor-interception-desktop`.

Full record: `NEEDS-VALIDATION.md` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

The desktop renders markdown in two places: the card detail modal's body preview and the file viewer's Formatted mode, which is the default mode for a `.md` file tab. Both pass `renderMarkdown` output through `DOMPurify.sanitize` with no config and insert it with `{@html}`. The content is often repository-authored: a cloned repo's `.gavin-root` card, a README, or card text an agent wrote.

**Style.** marked passes a raw `<style>` block through verbatim, and DOMPurify 3.4.16's default allowlist keeps `style` elements and `style` attributes. Its SAFE_FOR_XML probes remove a `<style>` only when the text contains `<` or `</style`, which plain CSS does not. The bundle CSP keeps `style-src 'self' 'unsafe-inline'`, and no nonce neutralises it because the served HTML has no inline `<style>`. So a card body such as `# Tidy the README\nFix the typo.\n\n<style>pre.block{display:none!important}</style>` adds a document-wide stylesheet while the modal is open. The modal's Review… button raises the first-run review sheet in the same document with that stylesheet still mounted. For a task or direct-prompt card the sheet shows the verbatim composed prompt in ConfirmPrompt's `<pre class="block">`. Svelte's scoping only adds a class, so a global `pre.block` rule with `!important` still matches and can hide or replace the text. The human then approves "Run this" on text they never saw, the digest is stamped, and the body later runs as an unsandboxed agent. For a plan card the review rests on the modal's own preview, which the same stylesheet controls. A cloned README open in a Formatted tab can likewise restyle any `askConfirm` prompt in that window. `img-src` and `default-src 'self'` block `url()` beacons, so the effect is UI redress of consent prompts, not exfiltration.

**Navigation.** The sanitized anchors keep `href` and lose `target`, and nothing intercepts a plain click. The Companion's sibling sink, PhoneMarkdown, does: it preventDefaults every `a[href]` and hands only http(s) to the system browser (ADR 0005). On the desktop, the opener plugin's injected script acts only for `target=_blank` or a ctrl/shift click. SvelteKit's router marks an external URL as `external` and returns without preventDefault, and the app registers no `beforeNavigate`. No window or webview builder in `app/src-tauri` sets `on_navigation`, none of the six registered plugins implements one, tauri 2.11.5's manager allows by default, and wry answers `WKNavigationActionPolicy::Allow`. A plain click on `[the style guide](https://attacker.example/guide)` should therefore replace the bundle in the main or `ws-*` window with the attacker's page. The window is undecorated, so there is no URL bar, no back control and no gavin title bar. The capabilities grant no `remote` URLs, so that page gets no IPC: the impact is a convincing fake gavin screen (asking for a token or a password, say) and loss of the app UI until a relaunch. The PTYs live in the daemon and survive.

## Root cause

Both desktop `{@html}` sinks call `DOMPurify.sanitize(renderMarkdown(...))` with the default config: no `FORBID_TAGS: ["style"]`, no `FORBID_ATTR: ["style"]`, no hook. The CSP's `'unsafe-inline'` is needed by the app's own component styles, so the CSP is not where this can be closed. Separately, the sinks attach no click handler, and no layer of the host refuses a top-level navigation to a non-local origin, so a sanitized anchor is a navigation primitive for repository content.

## The invariant to enforce

Repository-authored markdown rendered in a gavin window adds no stylesheet and no inline style to the document, and never navigates the window. Every sanitized markdown sink goes through one helper, every link click inside it is handled by gavin (only http(s) leaves, through the system browser), and the host refuses any top-level navigation off the app's own origin whatever the frontend does.

## Trace (lines as of 2026-10-16; re-read before editing)

- `app/src/lib/cards/CardDetailModal.svelte:207` (card detail `$effect`, `read = () => void readContent(path)`): the card file, which a cloned `.gavin-root` supplies, is read when the human opens the card and re-read on file change.
- `app/src/lib/files/markdown.ts:16` (renderMarkdown): `marked.parse(..., { breaks: true })` emits a raw `<style>` block verbatim and an ordinary `<a href>`; the module leaves sanitizing to callers on purpose (its header, lines 4-6).
- `app/src/lib/cards/CardDetailModal.svelte:220` (bodyHtml `$derived`): `DOMPurify.sanitize(renderMarkdown(content))`, default config. `style` elements and attributes are kept; `target` is not in the default attribute list.
- `app/src/lib/cards/CardDetailModal.svelte:1566` (`<div class="body-preview">{@html bodyHtml}</div>`): the `<style>` enters the live document while the modal is mounted; the container has no click handler.
- `app/src/lib/cards/CardDetailModal.svelte:1551` and `:1117`/`:1126` (Review… -> handleReview -> ensureCardReviewed): the review sheet is raised while the modal and its stylesheet stay mounted.
- `app/src/lib/cards/cardReviewActions.ts:55` (ensureCardReviewed, `askConfirm`): the composed prompt is the dialog's block text; confirming stamps the review at line 69.
- `app/src/lib/core/ConfirmPrompt.svelte:169` (`<pre class="block">{block.text}</pre>`): the one place the human reads what the agent receives, matched by a global `pre.block{display:none!important}`.
- `app/src/lib/files/FileEditor.svelte:109` and `:421` (rendered / `<div class="prose">{@html rendered}</div>`): the sibling sink, same default-config sanitize, same missing click handler. `app/src/lib/files/fileEditing.ts:14` (defaultMode) makes Formatted the default for a markdown tab.
- `app/companion/src/companion/surfaces/PhoneMarkdown.svelte:14` and `:18` (html / follow): the Companion's sink, also default-config sanitize, but with the click interception the desktop lacks. Its header says it sanitizes "as the desk's card detail sanitizes it".
- `app/src-tauri/tauri.conf.json:26` (CSP): `style-src 'self' 'unsafe-inline'`; line 20 sets `decorations: false` on the config-built main window.
- `app/src-tauri/src/lib.rs:74` (plugin list, 74-80): opener, dialog, clipboard-manager, os, notification and updater; none sets `on_navigation`.
- `app/src-tauri/src/workspace_window.rs:122` (WebviewWindowBuilder for `ws-*`): no `on_navigation`; the main window is built from `tauri.conf.json` and has none either.

## What the audit could not observe

- DOMPurify 3.4.16 was not executed: no jsdom, happy-dom or WebKit harness could run. That the output keeps `<style>` rests on the shipped default allowlist and the SAFE_FOR_XML predicates read in source.
- The app could not be launched, so neither the CSP actually served for the bundled document nor the rendered effect on `pre.block` was seen, and it is not observed that a plain click performs a top-level navigation under wry 0.55.1 rather than being cancelled or handed to the OS. Every source-visible layer (app, SvelteKit 2.70.2, the opener's script, the six plugins, tauri 2.11.5, wry's delegate) allows it.

## Fix

Three parts, one change.

1. **One sanitizer.** Add `app/src/lib/files/sanitizeMarkdown.ts` exporting `sanitizeMarkdown(content: string): string`, which returns `DOMPurify.sanitize(renderMarkdown(content), { FORBID_TAGS: ["style"], FORBID_ATTR: ["style"] })`. Use it at `CardDetailModal.svelte:220`, `FileEditor.svelte:109` and `PhoneMarkdown.svelte:14` (the last keeps its promise to sanitize as the desk does). Keep `markdown.ts` DOM-free as its header requires. Confirm that marked's table alignment still renders without `style` (check which attribute the installed marked emits).
2. **Link interception.** Put the decision in a pure module (for example `app/src/lib/files/markdownLinks.ts`): given an anchor's `href`, preventDefault always, and return the URL to open only when it is http(s). Attach it as `onclick` (and `onauxclick`) on the body-preview and `.prose` containers, calling `openUrl` from `@tauri-apps/plugin-opener` the way PhoneMarkdown's `follow()` does. PhoneMarkdown can then use the same module.
3. **Host backstop.** Register a small plugin in `lib.rs`, `tauri::plugin::Builder::new("navigation-guard").on_navigation(|_, url| navigation_allowed(url)).build()`. A plugin's handler covers every webview, including the config-built main window. `navigation_allowed` is a pure function allowing only the app's own origin: `tauri://localhost`, `http(s)://tauri.localhost`, and in debug builds only, the `devUrl` `http://localhost:1420`. An edit under `app/src-tauri` relaunches the owner's dev window, so batch the Rust edits.

Regression tests, written first:

- A source-grep test in `app/src/lib/files/` (the app already has tests that grep component source): `DOMPurify.sanitize(` appears in `sanitizeMarkdown.ts` and nowhere else under `app/src` and `app/companion/src`, and the helper's config forbids the `style` tag and attribute. It fails today on the three default-config call sites.
- If adding a DOM environment as a devDependency is acceptable (the app has none today), a `// @vitest-environment happy-dom` test: `sanitizeMarkdown("# T\nx\n\n<style>pre.block{display:none!important}</style>\n\n<p style=\"color:red\">y</p>")` contains no `<style` and no `style=`.
- `markdownLinks` unit tests: `https://example.invalid/` is opened; `file:///etc/passwd`, a relative `docs/a.md` and a `#fragment` are prevented and not opened.
- A source-grep test that both desktop sink containers carry the click handler.
- A Rust unit test of `navigation_allowed`: it accepts `tauri://localhost/index.html` and `http://tauri.localhost/`, refuses `https://example.invalid/`, and accepts `http://localhost:1420/` only under `cfg(debug_assertions)`.

## Done when

- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests in the touched crate or module, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched.
- The regression test fails before the change and passes after it.
- Follow the CLAUDE.md traps that apply: a new SQLite column needs its own `ALTER TABLE`, a widened request needs a compat-gate entry, and you commit only your own files.
- Once the fix is in, file this check with `gavin_request_human(<this card>, "test", …)` using exactly this text: "In a release bundle (not tauri dev), a throwaway task card whose body ends in `<style>pre.block{display:none!important}</style>` still shows 'The prompt the agent receives:' block when Review… is pressed (dismiss, do not run), and a plain left click on `[x](https://example.invalid/)` in that card's preview and in a README's Formatted view opens the system browser while the gavin window stays on the app."
