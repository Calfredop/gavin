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
    term.focus();
  }

  // Repeatedly polls for either a ready session or a bootstrap failure,
  // since bootstrap() can fail before any listener exists to catch its
  // daemon-error emit — the same class of startup race the event listeners
  // below are hardened against. Gives up after ~7.5s with a clear timeout
  // message rather than leaving "Connecting…" up forever.
  async function pollForStartupState() {
    const maxAttempts = 15;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (status !== "connecting") return; // resolved via an event meanwhile
      const [id, bootstrapError] = await Promise.all([
        invoke<string | null>("get_current_session").catch(() => null),
        invoke<string | null>("get_bootstrap_error").catch(() => null),
      ]);
      if (bootstrapError) {
        status = "error";
        errorMessage = bootstrapError;
        return;
      }
      if (id) {
        handleSessionReady(id);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (status === "connecting") {
      status = "error";
      errorMessage = "Timed out waiting for the daemon to become reachable.";
    }
  }

  onMount(async () => {
    term = new Terminal({ convertEol: false });
    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();

    window.addEventListener("resize", sendResize);

    // Register every listener before anything else async (all four in one
    // Promise.all, not sequential awaits), so none of them can miss an
    // event bootstrap() emits from its background thread before this
    // component finishes mounting. The signal in `finally` fires even if
    // listener registration itself fails, so the backend's reader thread
    // (which waits on this signal, bounded — see session.rs) is never left
    // waiting on a signal that silently never comes.
    try {
      const [unlistenReady, unlistenOutput, unlistenExited, unlistenError] =
        await Promise.all([
          listen<string>("session-ready", (event) => {
            handleSessionReady(event.payload);
          }),
          listen<[string, string]>("pty-output", (event) => {
            const [id, data] = event.payload;
            // Deliberately falsy-tolerant (not `if (id !== currentSessionId) return;`):
            // currentSessionId is null until handleSessionReady runs, and this
            // guard must not drop output just because status is still
            // "connecting" — that's exactly the bug this whole fix wave exists
            // to prevent. Don't "simplify" this comparison.
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
    } finally {
      invoke("signal_frontend_ready").catch(() => {});
    }

    pollForStartupState();
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
