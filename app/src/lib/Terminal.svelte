<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import "@xterm/xterm/css/xterm.css";

  let container: HTMLDivElement;
  let status: "connecting" | "ready" | "exited" | "error" = "connecting";
  let errorMessage = "";
  let exitCode: number | null = null;

  let term: Terminal;
  let fitAddon: FitAddon;
  let currentSessionId: string | null = null;
  const unlisteners: UnlistenFn[] = [];

  function sendResize() {
    if (!fitAddon) return;
    fitAddon.fit();
    const { cols, rows } = term;
    invoke("resize_session", { cols, rows }).catch(() => {});
  }

  onMount(async () => {
    term = new Terminal({ convertEol: true });
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();

    term.onData((data) => {
      invoke("write_input", { data }).catch((e) => {
        status = "error";
        errorMessage = String(e);
      });
    });

    window.addEventListener("resize", sendResize);

    function handleSessionReady(id: string) {
      if (status !== "connecting") return; // already handled — see below
      currentSessionId = id;
      status = "ready";
      sendResize();
    }

    // Register the listener BEFORE polling for already-established state.
    // bootstrap() runs on a background thread and can finish — including
    // emitting session-ready — before this component ever mounts,
    // especially when reattaching to an already-running daemon (the common
    // case). An event emitted before any listener exists is simply not
    // delivered, not buffered. The status guard in handleSessionReady
    // means it doesn't matter which of the poll or the event fires first,
    // or if both do.
    unlisteners.push(
      await listen<string>("session-ready", (event) => {
        handleSessionReady(event.payload);
      })
    );

    invoke<string | null>("get_current_session")
      .then((id) => {
        if (id) handleSessionReady(id);
      })
      .catch(() => {});

    unlisteners.push(
      await listen<[string, string]>("pty-output", (event) => {
        const [id, data] = event.payload;
        if (currentSessionId && id !== currentSessionId) return;
        term.write(data);
      })
    );

    unlisteners.push(
      await listen<[string, number]>("session-exited", (event) => {
        const [id, code] = event.payload;
        if (currentSessionId && id !== currentSessionId) return;
        status = "exited";
        exitCode = code;
      })
    );

    unlisteners.push(
      await listen<string>("daemon-error", (event) => {
        status = "error";
        errorMessage = event.payload;
      })
    );
  });

  onDestroy(() => {
    window.removeEventListener("resize", sendResize);
    unlisteners.forEach((unlisten) => unlisten());
    term?.dispose();
  });
</script>

<div class="terminal-page">
  {#if status === "error"}
    <div class="overlay">
      <p>Couldn't connect to the daemon.</p>
      <p class="detail">{errorMessage}</p>
    </div>
  {:else if status === "exited"}
    <div class="overlay">
      <p>Session exited (code {exitCode}).</p>
    </div>
  {/if}
  <div class="terminal-container" bind:this={container}></div>
</div>

<style>
  .terminal-page {
    width: 100vw;
    height: 100vh;
    margin: 0;
    background: #1e1e1e;
    position: relative;
  }
  .terminal-container {
    width: 100%;
    height: 100%;
  }
  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: #eee;
    background: rgba(0, 0, 0, 0.6);
    z-index: 10;
    font-family: monospace;
  }
  .detail {
    opacity: 0.7;
    font-size: 0.85em;
  }
</style>
