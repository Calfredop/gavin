<script lang="ts">
  /// Everything the wizard step and the Settings row show identically:
  /// the LED and its sentence, the Install button, the paste-able command
  /// where gavin must not run one, the manual "I've installed it", and
  /// the output drawer. One component rather than two so the drawer they
  /// share is literally the same drawer -- the alternative is a copy that
  /// drifts, and the thing most worth not drifting here is which streams
  /// the output carries.
  ///
  /// What stays outside: the wizard's "Not now" and "Continue", which are
  /// about finishing a STEP, and Settings' heading. Those genuinely
  /// differ.
  import { writeText } from "@tauri-apps/plugin-clipboard-manager";
  import * as backend from "./backend";
  import {
    RESTART_NOTE,
    showsAssertButton,
    showsCopyCommand,
    showsInstallButton,
    superpowersLed,
    type SuperpowersMark,
    type SuperpowersStatus,
  } from "./superpowers";

  interface Props {
    rootPath: string | null;
    status: SuperpowersStatus;
    mark: SuperpowersMark | undefined;
    /// Re-reads status and marker in whoever owns them. Both surfaces
    /// derive something from those (a stepper tick, a settings row), so
    /// neither can hold them here.
    onChanged: () => void;
    /// Settings offers a way to take back a claim; the wizard does not --
    /// there, "Not now" already covers changing your mind, and a third
    /// button would crowd a step that is meant to be answered once.
    allowClear?: boolean;
  }
  let { rootPath, status, mark, onChanged, allowClear = false }: Props = $props();

  let running = $state(false);
  let error = $state<string | null>(null);
  let showOutput = $state(false);
  /// The install's own log, held apart from `status.output`: the parent's
  /// refresh replaces that with a fresh detector run, and the run the
  /// human asked to see is the one they should go on seeing.
  let runOutput = $state<string | null>(null);
  let copied = $state(false);

  const led = $derived(superpowersLed(status.state));
  const output = $derived(runOutput ?? status.output);
  const believedPresent = $derived(status.state === "verified" || status.state === "asserted");

  async function install(): Promise<void> {
    if (!rootPath) return;
    running = true;
    error = null;
    try {
      const next = await backend.superpowersInstall(rootPath);
      runOutput = next.output;
      // A failed install leaves something worth reading. Open the drawer
      // rather than making them hunt for it.
      if (next.state !== "verified") showOutput = true;
    } catch (e) {
      error = String(e);
      showOutput = true;
    }
    running = false;
    onChanged();
  }

  async function say(next: SuperpowersMark | null): Promise<void> {
    if (!rootPath) return;
    error = null;
    try {
      await backend.setSuperpowersMark(rootPath, next);
    } catch (e) {
      error = String(e);
      return;
    }
    onChanged();
  }

  async function copy(): Promise<void> {
    if (!status.command) return;
    await writeText(status.command);
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }
</script>

<div class="sp">
  <div class="state">
    <span class="led {led}" aria-hidden="true"></span>
    <span class="detail">{status.detail}</span>
  </div>

  {#if showsCopyCommand(status)}
    <p class="note">gavin can't run this one for you — paste it in yourself:</p>
    <pre class="command">{status.command}</pre>
    <div class="links">
      <button type="button" class="link" onclick={() => void copy()}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  {/if}

  {#if error}
    <p class="warn">{error}</p>
  {/if}

  {#if believedPresent}
    <p class="note">{RESTART_NOTE}</p>
  {/if}

  <div class="row">
    {#if showsInstallButton(status)}
      <button type="button" disabled={running} onclick={() => void install()}>
        {running ? "Installing…" : "Install"}
      </button>
    {/if}
    {#if showsAssertButton(status, mark)}
      <button type="button" class="ghost" onclick={() => void say("installed")}>
        I've installed it
      </button>
    {/if}
    {#if allowClear && mark}
      <button type="button" class="link" onclick={() => void say(null)}>
        {mark === "installed" ? "Take that back" : "Ask me again"}
      </button>
    {/if}
    {#if output}
      <button type="button" class="link" onclick={() => (showOutput = !showOutput)}>
        {showOutput ? "Hide output" : "Show output"}
      </button>
    {/if}
  </div>

  {#if showOutput && output}
    <pre class="output">{output}</pre>
  {/if}
</div>

<style>
  .sp {
    font-family: monospace;
    font-size: 0.8em;
  }
  .state {
    display: flex;
    align-items: baseline;
    gap: 8px;
    color: #ccc;
  }
  .led {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: none;
    align-self: center;
  }
  /* A check that found it: filled. */
  .led.on {
    background: #8bc98b;
  }
  /* The human's word: the same colour, hollow. Believed present, but not
     by gavin — and a hollow ring says so without needing a legend. */
  .led.claimed {
    background: transparent;
    border: 1.5px solid #8bc98b;
  }
  .led.off {
    background: #555;
  }
  .led.unknown {
    background: transparent;
    border: 1.5px solid #777;
  }
  .command,
  .output {
    margin: 8px 0 0;
    padding: 8px 10px;
    background: #1c1c1c;
    border: 1px solid #333;
    border-radius: 4px;
    font-size: 0.9em;
    color: #ccc;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 180px;
    overflow: auto;
  }
  .links {
    margin-top: 4px;
  }
  .note {
    margin: 8px 0 0;
    color: #888;
    font-size: 0.9em;
  }
  .warn {
    margin: 8px 0 0;
    color: #e0b08a;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 10px;
  }
  .row button {
    background: #3a3a3a;
    border: none;
    color: #eee;
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
    font-size: 1em;
  }
  .row button.ghost {
    background: none;
    color: #888;
    padding: 5px 0;
  }
  .row button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .link {
    background: none;
    border: none;
    color: #7aa7d0;
    padding: 0;
    font-family: monospace;
    font-size: 1em;
    cursor: pointer;
  }
</style>
