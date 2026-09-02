<script lang="ts">
  import { Monitor, Sun, Moon } from "@lucide/svelte";
  import {
    agentProfilesStore,
    agentModelDefaultsStore,
    setAgentModelDefault,
    terminalFontSizeDefault,
    setTerminalFontSizeDefault,
    autoCommitDefault,
    setAutoCommitDefault,
  } from "./layoutState";
  import { modelOptions, CUSTOM_MODEL } from "./agentModel";
  import { DEFAULT_TERMINAL_FONT_SIZE, fontSizeOptions } from "./terminalFont";
  import {
    DEFAULT_AUTO_COMMIT,
    autoCommitFromSelect,
    autoCommitOptions,
    autoCommitToSelect,
  } from "./autoCommit";
  import { themeState } from "./ui/themeState.svelte";
  import type { ThemePref } from "./ui/theme";
  import IconButton from "./ui/IconButton.svelte";
  import Modal from "./Modal.svelte";

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  /// System first, matching the default -- and matching the order the
  /// three states read in: follow the OS, or override it either way.
  /// Lifted out of the sidebar footer, which no longer carries a theme
  /// control of its own: one setting, one place.
  const THEME_OPTIONS: { pref: ThemePref; label: string; icon: typeof Sun }[] = [
    { pref: "system", label: "Follow system", icon: Monitor },
    { pref: "light", label: "Light", icon: Sun },
    { pref: "dark", label: "Dark", icon: Moon },
  ];

  /// Only profiles gavin knows how to put a model on. A row for `cursor`
  /// or `custom` would be a control that cannot reach the agent.
  const profiles = $derived($agentProfilesStore.filter((p) => p.modelFlag));

  /// Which rows have their custom box open. A row whose stored value is
  /// not one of its presets starts open showing that value -- otherwise
  /// a hand-typed default would render as "(unset)" and look lost.
  let customOpen = $state<Record<string, boolean>>({});
  /// Per-row text while typing. Deliberately NOT synced back from the
  /// store by an effect: nothing outside this panel writes config.json's
  /// agentModels, so there is no external push to guard against -- and an
  /// effect that assigns into a $state object it also reads is how you
  /// get a loop. A row with no draft falls back to the stored value.
  let drafts = $state<Record<string, string>>({});

  function stored(profileId: string): string {
    return $agentModelDefaultsStore[profileId] ?? "";
  }

  function isCustom(profile: { id: string; models: string[] }): boolean {
    const value = stored(profile.id);
    return customOpen[profile.id] || (value !== "" && !profile.models.includes(value));
  }

  function selectValue(profile: { id: string; models: string[] }): string {
    return isCustom(profile) ? CUSTOM_MODEL : stored(profile.id);
  }

  function pick(profileId: string, value: string): void {
    if (value === CUSTOM_MODEL) {
      customOpen = { ...customOpen, [profileId]: true };
      drafts = { ...drafts, [profileId]: stored(profileId) };
      return;
    }
    customOpen = { ...customOpen, [profileId]: false };
    void setAgentModelDefault(profileId, value);
  }

  function commitCustom(profileId: string): void {
    const value = (drafts[profileId] ?? stored(profileId)).trim();
    if (value === stored(profileId)) return;
    void setAgentModelDefault(profileId, value);
  }
</script>

<Modal {onClose}>
  <div class="global-settings">
    <h2>Settings</h2>

    <section>
      <h3>Appearance</h3>
      <div class="row">
        <span>Theme</span>
        <div class="theme-toggle">
          {#each THEME_OPTIONS as opt (opt.pref)}
            <IconButton
              icon={opt.icon}
              label={opt.label}
              variant="segmented"
              size={12}
              active={themeState.pref === opt.pref}
              onclick={() => void themeState.setPref(opt.pref)}
            />
          {/each}
        </div>
      </div>
    </section>

    <section>
      <h3>Terminal</h3>
      <div class="row">
        <span>Font size</span>
        <select
          value={$terminalFontSizeDefault === null ? "" : String($terminalFontSizeDefault)}
          onchange={(e) =>
            void setTerminalFontSizeDefault(
              e.currentTarget.value === "" ? null : Number(e.currentTarget.value)
            )}
        >
          {#each fontSizeOptions(DEFAULT_TERMINAL_FONT_SIZE, $terminalFontSizeDefault) as opt (opt.value)}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </div>
      <p class="hint">
        Every terminal in every workspace, unless the workspace sets a size of its own. Open
        terminals resize as you pick.
      </p>
    </section>

    <section>
      <h3>Cards</h3>
      <div class="row">
        <span>Auto commit</span>
        <select
          value={autoCommitToSelect($autoCommitDefault)}
          onchange={(e) => void setAutoCommitDefault(autoCommitFromSelect(e.currentTarget.value))}
        >
          {#each autoCommitOptions(DEFAULT_AUTO_COMMIT) as opt (opt.value)}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </div>
      <p class="hint">
        Whether a new task or plan card starts asking the agent to commit its work when it finishes.
        Every workspace that sets nothing of its own follows this; every card can still be switched
        either way on the card itself.
      </p>
    </section>

    <section>
      <h3>Agent defaults</h3>
      {#if profiles.length === 0}
        <p class="hint">Waiting for the agent profile table…</p>
      {:else}
        {#each profiles as profile (profile.id)}
          <div class="row">
            <span>{profile.label}</span>
            <select
              value={selectValue(profile)}
              onchange={(e) => pick(profile.id, e.currentTarget.value)}
            >
              {#each modelOptions(profile, "") as opt (opt.value)}
                <option value={opt.value}>{opt.label}</option>
              {/each}
            </select>
            {#if isCustom(profile)}
              <input
                class="custom"
                spellcheck="false"
                placeholder="model name"
                value={drafts[profile.id] ?? stored(profile.id)}
                oninput={(e) => (drafts = { ...drafts, [profile.id]: e.currentTarget.value })}
                onblur={() => commitCustom(profile.id)}
                onkeydown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            {/if}
          </div>
        {/each}
        <p class="hint">
          Used by any workspace that sets no model of its own. Only Claude Code publishes stable
          aliases — for the rest, type the model name your CLI expects.
        </p>
      {/if}
    </section>

    <div class="actions">
      <button type="button" onclick={onClose}>Done</button>
    </div>
  </div>
</Modal>

<style>
  /* Deliberately the same rules as SettingsHubView's panel, so the
     app-wide and per-workspace settings read as one family rather than
     two designs that happen to sit next to each other. */
  .global-settings {
    display: flex;
    flex-direction: column;
    gap: 22px;
    font-size: 0.85em;
    min-width: 380px;
  }
  h2 {
    margin: 0;
    font-size: 1em;
    font-weight: normal;
    color: var(--text);
  }
  h3 {
    margin: 0 0 10px;
    color: var(--text-muted);
    font-size: 0.85em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: normal;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }
  .row > span:first-child {
    width: 110px;
    flex: 0 0 auto;
    color: var(--text-muted);
  }
  .row select,
  .row input {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-family: monospace;
    font-size: 1em;
    padding: 3px 8px;
  }
  .row select {
    min-width: 140px;
  }
  .row input.custom {
    flex: 1 1 auto;
    min-width: 0;
  }
  .theme-toggle {
    display: flex;
    gap: 2px;
    background: var(--surface-sunken);
    border-radius: 4px;
    padding: 1px;
  }
  .hint {
    color: var(--text-subtle);
    margin: 6px 0 0;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
  }
  .actions button {
    background: var(--surface-overlay);
    border: none;
    color: var(--text);
    padding: 5px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
    font-size: 1em;
  }
</style>
