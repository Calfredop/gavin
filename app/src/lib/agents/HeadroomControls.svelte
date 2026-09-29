<script lang="ts">
  /// What Settings' Headroom section and the wizard's Headroom step show
  /// identically: the state and its reason, the version against the pin,
  /// the process and its port, the lifetime total, the actions, the
  /// command where gavin has no uv to run it with, and the install's
  /// progress and output. One component so the two cannot drift; every
  /// decision in it is `headroomSectionView`'s.
  ///
  /// What stays outside: the switches, which differ -- the app-wide
  /// default in Settings, the workspace's own in the wizard.
  import { writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { tooltip } from "$lib/core/tooltip";
  import {
    NO_UV_NOTE,
    headroomActionLabel,
    headroomSectionView,
    type HeadroomAction,
    type HeadroomReading,
  } from "$lib/agents/headroomSetup";
  import {
    checkHeadroomAgain,
    installHeadroom,
    locateHeadroom,
    updateHeadroom,
  } from "$lib/agents/headroomState";

  interface Props {
    reading: HeadroomReading | undefined;
  }
  let { reading }: Props = $props();

  const view = $derived(headroomSectionView(reading));
  const status = $derived(reading?.kind === "status" ? reading.status : null);

  let busy = $state<HeadroomAction | null>(null);
  let error = $state<string | null>(null);
  let copied = $state(false);
  /// The human's own choice about the output drawer, null until they
  /// make one. Until then a failed install shows it: the reason it failed
  /// is in there, and making the human hunt for it is the worse default.
  let outputChosen = $state<boolean | null>(null);
  const showOutput = $derived(outputChosen ?? view.install?.failed ?? false);

  async function run(action: HeadroomAction): Promise<void> {
    if (!status || busy) return;
    busy = action;
    error = null;
    try {
      switch (action) {
        case "install":
          error = await installHeadroom();
          break;
        case "update":
          error = await updateHeadroom(status);
          break;
        case "locate":
          error = await locateHeadroom();
          break;
        case "check-again":
          error = await checkHeadroomAgain();
          break;
      }
    } finally {
      busy = null;
    }
  }

  async function copy(command: string): Promise<void> {
    await writeText(command);
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }
</script>

<div class="hr">
  <div class="state">
    <span class="led {view.tone}" aria-hidden="true"></span>
    <span class="label">{view.label}</span>
    {#if view.versionLine}
      <span class="version">{view.versionLine}</span>
    {/if}
  </div>

  {#if view.reason}
    <p class="note" class:warn={view.tone === "warn" || reading?.kind === "error"}>{view.reason}</p>
  {/if}
  {#if view.updateLine}
    <p class="note">{view.updateLine}</p>
  {/if}
  {#if view.process}
    <p class="process {view.process.word}">{view.process.line}</p>
  {/if}
  {#if view.saved}
    <p class="note"><span use:tooltip={view.saved.exact}>{view.saved.line}</span></p>
  {/if}

  {#if view.installCommand}
    <p class="note">{NO_UV_NOTE}</p>
    <pre class="command">{view.installCommand}</pre>
    <button type="button" class="link" onclick={() => void copy(view.installCommand ?? "")}>
      {copied ? "Copied" : "Copy"}
    </button>
  {/if}

  {#if view.install}
    <p class="note" class:warn={view.install.failed}>{view.install.line}</p>
  {/if}

  {#if error}
    <p class="note warn">{error}</p>
  {/if}

  {#if status && (view.actions.length > 0 || view.install?.output)}
    <div class="row">
      {#each view.actions as action, i (action)}
        <button
          type="button"
          class:primary={i === 0 && (action === "install" || action === "update")}
          disabled={busy !== null}
          onclick={() => void run(action)}
        >
          {headroomActionLabel(action, status, busy === action)}
        </button>
      {/each}
      {#if view.install?.output}
        <button type="button" class="link" onclick={() => (outputChosen = !showOutput)}>
          {showOutput ? "Hide output" : "Show output"}
        </button>
      {/if}
    </div>
  {/if}

  {#if showOutput && view.install?.output}
    <pre class="output">{view.install.output}</pre>
  {/if}
</div>

<style>
  /* The size is the host's: Settings sets its own, the wizard its own. */
  .hr {
    font-family: monospace;
    color: var(--text, #ddd);
  }
  .state {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 8px;
  }
  .label {
    color: var(--text, #eee);
  }
  .version {
    color: var(--text-muted, #999);
  }
  .led {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: none;
    align-self: center;
  }
  .led.on {
    background: var(--success, #8bc98b);
  }
  .led.warn {
    background: var(--warning, #e0b08a);
  }
  .led.off {
    background: var(--text-subtle, #555);
  }
  .led.unknown {
    background: transparent;
    border: 1.5px solid var(--text-subtle, #777);
  }
  .note,
  .process {
    margin: 6px 0 0;
    color: var(--text-subtle, #888);
  }
  .process.running {
    color: var(--success-text, #8bc98b);
  }
  .process.failed,
  .warn {
    color: var(--warning-text, #e0b08a);
  }
  .command,
  .output {
    margin: 8px 0 0;
    padding: 8px 10px;
    background: var(--surface-sunken, #1c1c1c);
    border: 1px solid var(--border, #333);
    border-radius: 4px;
    font-size: 0.9em;
    color: var(--text, #ccc);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 180px;
    overflow: auto;
  }
  .row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;
  }
  .row button:not(.link) {
    background: var(--surface-base, #2a2a2a);
    border: 1px solid var(--border, #3a3a3a);
    color: var(--text, #eee);
    padding: 3px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
    font-size: 1em;
  }
  .row button.primary {
    border-color: var(--accent, #7aa7d0);
  }
  .row button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .link {
    background: none;
    border: none;
    color: var(--accent-text, #7aa7d0);
    padding: 0;
    margin-top: 4px;
    font-family: monospace;
    font-size: 1em;
    cursor: pointer;
  }
</style>
