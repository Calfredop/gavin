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

  function handleSessionReady(id: string) {
    if (status !== "connecting") return; // already handled — see below
    currentSessionId = id;
    status = "ready";
    // Input is only wired up once a session actually exists. Attaching
    // onData unconditionally at mount time, before any session exists, is
    // exactly the bug this restructuring exists to avoid: a keystroke that
    // arrives before the session is ready would fail server-side ("no
    // active session"), and naively treating that failure as a fatal error
    // would permanently mask a perfectly working terminal — the "error"
    // status leaving "connecting" would block this very function's own
    // guard above from ever running once the session genuinely becomes
    // ready.
    term.onData((data) => {
      invoke("write_input", { data }).catch((e) => {
        status = "error";
        errorMessage = String(e);
      });
    });
    sendResize();
  }

  onMount(async () => {
    term = new Terminal({ convertEol: true });
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();

    window.addEventListener("resize", sendResize);

    // Register every listener before anything else async (all four in one
    // Promise.all, not sequential awaits), so none of them can miss an
    // event bootstrap() emits from its background thread before this
    // component finishes mounting — the same race class Task 5's fix round
    // closed for session-ready specifically, now closed as tightly as
    // practical for the other three too.
    const [unlistenReady, unlistenOutput, unlistenExited, unlistenError] =
      await Promise.all([
        listen<string>("session-ready", (event) => {
          handleSessionReady(event.payload);
        }),
        listen<[string, string]>("pty-output", (event) => {
          const [id, data] = event.payload;
          if (currentSessionId && id !== currentSessionId) return;
          term.write(data);
        }),
        listen<[string, number]>("session-exited", (event) => {
          const [id, code] = event.payload;
          if (currentSessionId && id !== currentSessionId) return;
          status = "exited";
          exitCode = code;
        }),
        listen<string>("daemon-error", (event) => {
          status = "error";
          errorMessage = event.payload;
        }),
      ]);
    unlisteners.push(unlistenReady, unlistenOutput, unlistenExited, unlistenError);

    // bootstrap() may have already finished — e.g. reattaching to an
    // already-running daemon, the common case — before the listeners above
    // went live. Catch that case too. Order-independent with the
    // session-ready listener thanks to handleSessionReady's own guard.
    invoke<string | null>("get_current_session")
      .then((id) => {
        if (id) handleSessionReady(id);
      })
      .catch(() => {});
  });

  onDestroy(() => {
    window.removeEventListener("resize", sendResize);
    unlisteners.forEach((unlisten) => unlisten());
    term?.dispose();
  });
</script>

<div class="terminal-page">
  {#if status === "connecting"}
    <div class="overlay">
      <p>Connecting…</p>
    </div>
  {:else if status === "error"}
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
