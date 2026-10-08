<script lang="ts">
  // One session's terminal, and the dock a thumb types through (ticket 01:
  // compose by default, raw keys one tap away). The terminal is the desk's
  // own -- TerminalPane over the desk's terminal registry, xterm 6.1 for
  // touch scrolling -- and every decision the dock makes is a pure module:
  // what a line or a key sends (terminalInput.ts), which answers to offer
  // (quickReplies.ts). This file wires them to the screen.
  //
  // `sessionId` is fixed for the life of the component, as TerminalPane's
  // is: the page rebuilds this for another session.
  import { flushSync, onMount } from "svelte";
  import { ArrowDownToLine, Globe, Keyboard, Power, Send, Type } from "@lucide/svelte";
  import { turnVerdictById } from "$lib/agents/turnVerdictState";
  import { verdictAttentionStatusById } from "$lib/agents/verdictAttention";
  import { askConfirm, showAlert } from "$lib/core/dialog";
  import { layoutState } from "$lib/core/layoutState";
  import { sessionLabel } from "$lib/core/paths";
  import TerminalPane from "$lib/terminal/TerminalPane.svelte";
  import { DEFAULT_TERMINAL_FONT_SIZE } from "$lib/terminal/terminalFont";
  import { destroyTerminal, getTerminal, setInputTransform } from "$lib/terminal/terminalRegistry";
  import IconButton from "$lib/ui/IconButton.svelte";
  import { tabAgentIndicator } from "$lib/ui/indicators";
  import StatusBadge from "$lib/ui/StatusBadge.svelte";
  import { browserShown, browserViews, hideBrowser, showBrowser } from "$companion/state/browser";
  import { endSession } from "$companion/state/sessions";
  import { watchTurn } from "$companion/state/turn";
  import { sendKey, sendLine, sendReply, sendTyped } from "$companion/state/typing";
  import { closeTerminal } from "$companion/state/workstation";
  import PhoneBrowser from "$companion/surfaces/PhoneBrowser.svelte";
  import { browserButton } from "$companion/surfaces/phoneBrowser";
  import PhoneHeader from "$companion/surfaces/PhoneHeader.svelte";
  import { press, tap } from "$companion/surfaces/press";
  import { logicalRows, quickReplies, type QuickReply } from "$companion/surfaces/quickReplies";
  import {
    ARROW_KEYS,
    LEAD_KEYS,
    MORE_KEYS,
    MORE_SYMBOLS,
    PINNED_KEYS,
    PLAIN_MODES,
    typedThrough,
    type InputModes,
    type KeyId,
  } from "$companion/surfaces/terminalInput";
  import { terminalFontSize, textScale } from "$companion/surfaces/textScale";

  interface Props {
    sessionId: string;
  }
  let { sessionId }: Props = $props();

  /// Rows of the screen the quick replies read: the same tail the turn
  /// verdict is given.
  const SCREEN_ROWS = 40;
  /// A thumb's worth of quiet before the PTY is told its new size: the
  /// keyboard animates open over several frames, and each would be a
  /// resize the program repaints for.
  const REFIT_AFTER_MS = 120;
  /// How long a sent quick reply hides the rest, when nothing the
  /// Workstation says ends the wait sooner.
  const REPLIED_FOR_MS = 4000;

  let dock = $state<"compose" | "raw">("compose");
  let more = $state(false);
  let ctrlArmed = $state(false);
  let draft = $state("");
  let screen = $state<string[]>([]);
  /// Scrolled up from the latest output.
  let behind = $state(false);
  /// A quick reply went; its effect is not on screen yet.
  let replied = $state(false);

  let pane = $state<TerminalPane | undefined>();
  let frame = $state<HTMLDivElement | undefined>();
  let field = $state<HTMLTextAreaElement | undefined>();

  const name = $derived(sessionLabel($layoutState.sessionNames, $layoutState.cwdBySessionId, sessionId));
  const sessionStatus = $derived($layoutState.sessionStatusById[sessionId]);
  const badge = $derived(
    tabAgentIndicator($verdictAttentionStatusById[sessionId], $layoutState.failureReasonById[sessionId])
  );
  const quick = $derived(quickReplies({ status: sessionStatus, verdict: $turnVerdictById[sessionId], screen }));
  /// The agent's browser, beside the terminal only once the human asks
  /// for it (state/browser.ts): never on a frame of its own accord.
  const browserUp = $derived($browserShown === sessionId);
  const browser = $derived(browserButton($browserViews[sessionId], browserUp));

  function toggleBrowser(): void {
    if (browserUp) hideBrowser(sessionId);
    else void showBrowser(sessionId);
  }

  // Whatever the Workstation says next about the session is the answer
  // to a reply sent, or the end of waiting for one.
  $effect(() => {
    void sessionStatus;
    replied = false;
  });

  function modes(): InputModes {
    const m = getTerminal(sessionId)?.modes;
    return m
      ? { bracketedPasteMode: m.bracketedPasteMode, applicationCursorKeysMode: m.applicationCursorKeysMode }
      : PLAIN_MODES;
  }

  // A write the Workstation refused has nothing to tell the human that
  // the terminal does not already show: what was typed did not appear.
  const ignore = (): void => {};

  function submit(): void {
    void sendLine(sessionId, draft, modes()).catch(ignore);
    draft = "";
  }

  let repliedTimer: ReturnType<typeof setTimeout> | undefined;
  function reply(answer: QuickReply): void {
    if (replied) return;
    replied = true;
    clearTimeout(repliedTimer);
    repliedTimer = setTimeout(() => (replied = false), REPLIED_FOR_MS);
    void sendReply(sessionId, answer, modes()).catch(ignore);
  }

  function key(id: KeyId): void {
    ctrlArmed = false;
    void sendKey(sessionId, id, modes()).catch(ignore);
  }

  function symbol(ch: string): void {
    const typed = sendTyped(sessionId, ch, ctrlArmed);
    ctrlArmed = typed.ctrlArmed;
    void typed.sent.catch(ignore);
  }

  /// The terminal's own input: taken by the soft keyboard in raw mode,
  /// and nothing a keyboard can reach in compose mode -- a tap on the
  /// terminal there is for scrolling, and must not raise one.
  function settleInput(): void {
    const input = getTerminal(sessionId)?.textarea;
    if (!input) return;
    input.readOnly = dock !== "raw";
    input.setAttribute("inputmode", dock === "raw" ? "text" : "none");
  }

  // Called from the tap itself, not from an effect: iOS raises the
  // keyboard only for a focus made inside the gesture.
  function toRaw(): void {
    dock = "raw";
    settleInput();
    getTerminal(sessionId)?.focus();
  }

  function toCompose(): void {
    const keyboardUp = document.documentElement.hasAttribute("data-keyboard");
    // Drawn now, not at the next tick: the field has to exist to take
    // the focus while the tap is still the gesture iOS will raise a
    // keyboard for.
    flushSync(() => {
      dock = "compose";
      more = false;
      ctrlArmed = false;
    });
    settleInput();
    getTerminal(sessionId)?.blur();
    if (keyboardUp) field?.focus();
  }

  function onFieldKey(e: KeyboardEvent): void {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    submit();
  }

  // A tap on the terminal while composing puts the keyboard away, so the
  // screen it covered can be read; in raw mode it gives the terminal the
  // keyboard. xterm's own mousedown did the second under 6.0, and 6.1
  // sends none for a touch: it takes the touch for scrolling.
  function onFrameTap(e: PointerEvent): void {
    // The Latest pill is a press of its own, and keeps the keyboard up.
    if (e.target instanceof Element && e.target.closest("button")) return;
    if (dock === "raw") getTerminal(sessionId)?.focus();
    else if (document.activeElement === field) field?.blur();
  }

  function latest(): void {
    getTerminal(sessionId)?.scrollToBottom();
    behind = false;
  }

  async function end(): Promise<void> {
    const confirmed = await askConfirm({
      title: `End “${name}”?`,
      lines: [
        "It stops at the Workstation, and whatever it is running stops with it.",
        "Its tab closes at the desk.",
      ],
      confirmLabel: "End session",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await endSession(sessionId);
    } catch (e) {
      await showAlert({ title: "The session could not be ended", lines: [String(e)] });
    }
  }

  onMount(() => {
    // TerminalPane, a child, has built the terminal by now.
    const term = getTerminal(sessionId);
    settleInput();

    let reading: ReturnType<typeof setTimeout> | undefined;
    const readScreen = (): void => {
      if (!term) return;
      const buffer = term.buffer.active;
      const rows: { text: string; wrapped: boolean }[] = [];
      for (let y = Math.max(0, buffer.length - SCREEN_ROWS); y < buffer.length; y++) {
        const line = buffer.getLine(y);
        rows.push({ text: line?.translateToString(false) ?? "", wrapped: line?.isWrapped ?? false });
      }
      screen = logicalRows(rows);
      behind = buffer.viewportY < buffer.baseY;
    };
    readScreen();
    const parsed = term?.onWriteParsed(() => {
      clearTimeout(reading);
      reading = setTimeout(readScreen, 60);
    });
    const scrolled = term?.onScroll(() => {
      if (term) behind = term.buffer.active.viewportY < term.buffer.active.baseY;
    });

    const releaseTransform = setInputTransform((id, data) => {
      if (id !== sessionId) return data;
      const typed = typedThrough(data, ctrlArmed);
      ctrlArmed = typed.ctrlArmed;
      return typed.bytes;
    });

    let refit: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(refit);
      refit = setTimeout(() => void pane?.fit(), REFIT_AFTER_MS);
    });
    if (frame) observer.observe(frame);

    const stopWatching = watchTurn(sessionId);
    return () => {
      stopWatching();
      // The next time this terminal opens, it opens alone.
      hideBrowser(sessionId);
      observer.disconnect();
      clearTimeout(refit);
      clearTimeout(reading);
      clearTimeout(repliedTimer);
      parsed?.dispose();
      scrolled?.dispose();
      releaseTransform();
      // Let go, unlike the desk, which keeps every terminal it has shown.
      // Each one kept is a listener for every session's output, and on a
      // phone that is traffic over the Relay for screens nobody is
      // looking at. Opening it again repaints it from the Workstation,
      // history included.
      destroyTerminal(sessionId);
    };
  });
</script>

<PhoneHeader title={name} back="Sessions" onBack={closeTerminal}>
  {#snippet status()}
    {#if badge}
      <StatusBadge indicator={badge} size={16} />
    {/if}
  {/snippet}
  {#snippet actions()}
    {#if browser}
      <span class="browser-button">
        <IconButton
          icon={Globe}
          label={browser.label}
          active={browser.pressed}
          aria-pressed={browser.pressed}
          size={18}
          onclick={toggleBrowser}
        />
      </span>
    {/if}
    <span class="end">
      <IconButton icon={Power} label="End this session" tone="danger" size={18} onclick={() => void end()} />
    </span>
  {/snippet}
</PhoneHeader>

<div class="work">
  {#if browserUp}
    <PhoneBrowser {sessionId} onClose={() => hideBrowser(sessionId)} />
  {/if}
  <div class="frame" bind:this={frame} use:tap={onFrameTap}>
    <TerminalPane bind:this={pane} {sessionId} visible={true} focused={false} fontSize={terminalFontSize(DEFAULT_TERMINAL_FONT_SIZE, $textScale)} />
    {#if behind}
      <button type="button" class="latest" use:press={{ onPress: latest }}>
        <ArrowDownToLine size={14} />
        <span>Latest</span>
      </button>
    {/if}
  </div>
</div>

<div class="dock">
  {#if dock === "compose"}
    <div class="replies-row">
      <div class="replies" role="group" aria-label="Quick replies">
        {#if !replied}
          {#each quick.replies as answer (answer.label)}
            <button
              type="button"
              class="chip"
              class:primary={answer.primary}
              class:canned={answer.canned}
              use:press={{ onPress: () => reply(answer) }}
            >
              {#if answer.key}<span class="chip-key">{answer.key}</span>{/if}
              <span class="chip-label">{answer.label}</span>
            </button>
          {/each}
        {/if}
      </div>
      <div class="pinned">
        {#each PINNED_KEYS as pinned (pinned.id)}
          <button type="button" class="chip key-chip" aria-label={pinned.name} use:press={{ onPress: () => key(pinned.id) }}>
            {pinned.label}
          </button>
        {/each}
      </div>
    </div>
    <form
      class="compose"
      onsubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <button type="button" class="swap" aria-label="Type straight into the terminal" use:press={{ onPress: toRaw }}>
        <Keyboard size={20} />
      </button>
      <textarea
        bind:this={field}
        bind:value={draft}
        rows="1"
        placeholder="Reply, or type a command"
        autocapitalize="off"
        autocomplete="off"
        spellcheck="false"
        enterkeyhint="send"
        aria-label="Line to send"
        onkeydown={onFieldKey}
      ></textarea>
      <IconButton
        icon={Send}
        label="Send the line"
        variant="filled"
        tone="accent"
        size={18}
        class="send"
        onpointerdown={(e: PointerEvent) => e.preventDefault()}
        onclick={submit}
      />
    </form>
  {:else}
    <div class="keys" role="group" aria-label="Keys">
      {#each LEAD_KEYS as k (k.id)}
        <button type="button" class="key" aria-label={k.name} use:press={{ onPress: () => key(k.id) }}>{k.label}</button>
      {/each}
      <button
        type="button"
        class="key"
        class:on={ctrlArmed}
        aria-label="Control, for the next key"
        aria-pressed={ctrlArmed}
        use:press={{ onPress: () => (ctrlArmed = !ctrlArmed) }}
      >
        Ctrl
      </button>
      {#each ARROW_KEYS as k (k.id)}
        <button type="button" class="key" aria-label={k.name} use:press={{ onPress: () => key(k.id), repeats: k.repeats }}>
          {k.label}
        </button>
      {/each}
      <button
        type="button"
        class="key"
        class:on={more}
        aria-label="More keys"
        aria-expanded={more}
        use:press={{ onPress: () => (more = !more) }}
      >
        ⋯
      </button>
      <button type="button" class="key" aria-label="Back to the compose field" use:press={{ onPress: toCompose }}>
        <Type size={16} />
      </button>
    </div>
    {#if more}
      <div class="keys" role="group" aria-label="More keys">
        {#each MORE_KEYS as k (k.id)}
          <button type="button" class="key" aria-label={k.name} use:press={{ onPress: () => key(k.id) }}>{k.label}</button>
        {/each}
      </div>
      <div class="keys" role="group" aria-label="Symbols">
        {#each MORE_SYMBOLS as ch (ch)}
          <button type="button" class="key" use:press={{ onPress: () => symbol(ch) }}>{ch}</button>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  /* The terminal, and the agent's browser above it or, on its side,
     beside it (PhoneBrowser.svelte). */
  .work {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-height: 0;
  }
  /* Halves: the terminal's own width is whatever xterm last fitted to,
     which would otherwise decide the split. */
  @media (orientation: landscape) {
    .work {
      flex-direction: row;
    }
    .work .frame {
      flex-basis: 0;
    }
  }
  .frame {
    position: relative;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    background: var(--surface-base);
  }
  .latest {
    position: absolute;
    right: 12px;
    bottom: 12px;
    z-index: 2;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 44px;
    padding: 0 12px;
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: 0.8125rem;
  }

  .dock {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px 8px calc(6px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--border);
    background: var(--surface-sunken);
  }
  /* With the keyboard up the home indicator is under it. */
  :global(:root[data-keyboard]) .dock {
    padding-bottom: 6px;
  }

  .replies-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 44px;
  }
  /* The answers scroll sideways when they outgrow the width; Esc and ^C
     stay where the thumb expects them (ticket 01, amendment 7). */
  .replies {
    display: flex;
    flex: 1 1 auto;
    gap: 6px;
    min-width: 0;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
  }
  .pinned {
    display: flex;
    flex: 0 0 auto;
    gap: 6px;
    padding-left: 6px;
    border-left: 1px solid var(--border);
  }
  .chip {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 6px;
    max-width: 14em;
    min-height: 44px;
    padding: 0 12px;
    border: 1px solid var(--border-strong);
    border-radius: 999px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: 0.875rem;
    touch-action: pan-x;
  }
  .chip-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip-key {
    color: var(--text-subtle);
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  /* What Enter alone would choose. */
  .chip.primary {
    border-color: var(--border-accent);
    color: var(--accent-text);
  }
  .chip.primary .chip-key {
    color: var(--accent-text);
  }
  /* A guess at what to say, not an option the agent offered. */
  .chip.canned {
    border-style: dashed;
    color: var(--text-muted);
  }
  .key-chip {
    justify-content: center;
    min-width: 44px;
    padding: 0 10px;
    color: var(--text-muted);
    font-size: 0.8125rem;
  }

  .compose {
    display: flex;
    align-items: flex-end;
    gap: 6px;
  }
  .compose textarea {
    flex: 1 1 auto;
    box-sizing: border-box;
    min-width: 0;
    min-height: 44px;
    max-height: 7.5em;
    padding: 11px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-base);
    color: var(--text);
    /* Sized by the page's floor for fields, 16px (phone.css): iOS zooms
       the page into a smaller one. `1rem` was 13px here. */
    font: inherit;
    line-height: 1.25;
    resize: none;
  }
  .compose textarea:focus {
    border-color: var(--border-focus);
    outline: none;
  }
  .swap {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-raised);
    color: var(--text-muted);
  }
  .compose :global(.send) {
    flex: 0 0 auto;
    width: 44px;
    height: 44px;
    border-radius: 8px;
  }

  .keys {
    display: flex;
    gap: 4px;
  }
  .key {
    display: inline-flex;
    flex: 1 1 0;
    align-items: center;
    justify-content: center;
    min-width: 0;
    height: 44px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: 0.875rem;
    touch-action: manipulation;
  }
  .key.on {
    border-color: var(--border-accent);
    background: var(--surface-selected);
    color: var(--accent-text);
  }

  .chip:global(.pressed),
  .key:global(.pressed),
  .swap:global(.pressed),
  .latest:global(.pressed) {
    background: var(--surface-hover);
  }
  .chip:focus-visible,
  .key:focus-visible,
  .swap:focus-visible,
  .latest:focus-visible {
    outline: 2px solid var(--border-focus);
    outline-offset: 1px;
  }
  /* A thumb's worth, around the desk's own button. */
  .browser-button :global(.icon-button),
  .end :global(.icon-button) {
    min-width: 44px;
    min-height: 44px;
  }
</style>
