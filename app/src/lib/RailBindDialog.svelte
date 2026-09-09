<script lang="ts">
  import Modal from "$lib/Modal.svelte";
  import GitForkDialog from "$lib/GitForkDialog.svelte";
  import { gitStore, createBranch } from "$lib/gitState";
  import { gavinTrees } from "$lib/gavinState";
  import { layoutState, createPage, resolvedAgentFor, daemonCompat } from "$lib/layoutState";
  import {
    bindRailAction,
    orchestrations,
    runOnRailPage,
    setRailTriggerAction,
  } from "$lib/orchestrationState";
  import { presetSingle } from "$lib/panes/layout";
  import { freeBranchNameFrom, validateBranchName } from "$lib/git";
  import { featureBlockedReason } from "$lib/daemonCompat";
  import {
    RAIL_BIND_TABS,
    railBindChip,
    railBindTabAfterKey,
    type RailBindTab,
  } from "$lib/railBind";
  import type { Rail, RailTrigger, RailTriggerKind } from "$lib/orchestration";
  import {
    RAIL_TRIGGER_CHOICES,
    emptyOrchestration,
    railTriggerVerdict,
  } from "$lib/orchestration";

  interface Props {
    workspaceId: string;
    rail: Rail;
    /// Which binding the human came here to change. The conflict box
    /// knows (a missing branch is a branch question), and so does each
    /// chip in the rail header, so neither has to drop the reader at the
    /// top of a dialog and let them find the right list.
    initialTab?: RailBindTab;
    onClose: () => void;
  }
  let { workspaceId, rail, initialTab = "worktree", onClose }: Props = $props();

  /// Which rail this dialog is for, read ONCE. `rail` is a lazy prop over
  /// the hub view's `{@const bindingRail = orch.rails.find(r => r.id ===
  /// binding)}`, so it resolves the rail through the very state `onClose`
  /// clears: every read after the close re-runs that derived against a
  /// null `binding` and hands back `undefined`. Both of the fork dialog's
  /// callbacks run after that close on purpose -- the dialog must not
  /// hang on a save round trip -- and reading `rail.id` there threw a
  /// TypeError the calling `void submit()` swallowed, which is what left
  /// a freshly cut worktree with no binding and no setup session while
  /// the button looked like it had done nothing at all.
  ///
  /// A snapshot is safe because the id is what SELECTS this dialog: the
  /// hub unmounts it to point at another rail, so it cannot change while
  /// the dialog is open. Every action here goes through it; only the
  /// rail's name stays live, so a rename still redraws the header.
  const railId = rail.id;

  /// Snapshotted for the same reason, and deliberately not re-synced from
  /// the prop: which tab you land on is a question asked once, when the
  /// dialog opens. After that the strip belongs to the human.
  let tab = $state<RailBindTab>(initialTab);

  let forking = $state(false);

  const worktrees = $derived($gitStore[workspaceId]?.refs?.worktrees ?? []);
  const branches = $derived($gitStore[workspaceId]?.refs?.branches ?? []);
  const headBranch = $derived($gitStore[workspaceId]?.refs?.headBranch ?? null);
  const pages = $derived($layoutState.workspaces.find((w) => w.id === workspaceId)?.pages ?? []);

  /// The bound page's name, or null when the rail has none -- and equally
  /// when it points at a page that has since been closed, which the tab
  /// strip and the panel below both report as "made at the next launch".
  const pageName = $derived(pages.find((p) => p.id === rail.pageId)?.name ?? null);

  /// What each tab is currently set to, so the strip says the answers as
  /// well as the questions: a human who opened this to check where a rail
  /// runs never has to visit all three panels to find out.
  const chips = $derived(RAIL_BIND_TABS.map((t) => railBindChip(t.id, rail, pageName)));

  /// Where each branch is currently checked out, so the list can say so.
  /// A branch checked out in ANOTHER worktree is the one binding git
  /// refuses at switch time, and the human deserves to see that here
  /// rather than in a stall reason.
  const checkedOutIn = $derived(
    new Map(
      worktrees
        .filter((w) => w.branch !== null)
        .map((w) => [w.branch as string, w.path] as const)
    )
  );

  /// The checkout this rail's steps run in, and so the one its branch
  /// applies to — its own worktree, or the workspace root when it has
  /// none. Spelled exactly as `executeToolLaunch` and `conflictCheckout`
  /// spell it, so a page made here opens where the rail's own Start
  /// would have opened it and the dialog can never name a different
  /// checkout than the scheduler switches.
  const tree = $derived($gavinTrees[workspaceId]);
  const railCheckout = $derived(
    rail.worktreePath ?? (tree && !tree.rootMissing ? tree.rootPath : null)
  );

  /// `branch` widens SetOrchestration, a request that has existed since
  /// v10, so the wire gate is structurally blind to it: a v15 daemon
  /// takes the write, drops the field and hands the rail back unbound.
  /// Without this the human picks a branch, sees the list snap back to
  /// "None" and is told nothing at all.
  const branchBlocked = $derived(featureBlockedReason($daemonCompat, "railBranch"));

  /// `trigger` widens SetOrchestration exactly as `branch` does, and is
  /// dropped by an older daemon exactly as silently -- so the panel is
  /// disabled with the reason rather than taking a choice that never
  /// reaches disk. See FEATURE_MIN_VERSION.railTrigger.
  const triggerBlocked = $derived(featureBlockedReason($daemonCompat, "railTrigger"));

  /// The plan itself, for the trigger panel alone: what a condition WOULD
  /// do right now -- which rails it is still waiting for, whether the name
  /// it holds resolves -- is an answer about the whole workspace, and it
  /// changes while the dialog is open.
  const orch = $derived($orchestrations[workspaceId] ?? emptyOrchestration());
  const verdict = $derived(railTriggerVerdict(orch, rail));

  /// Every OTHER rail, for the `rail-done` picker. Offered by NAME,
  /// because that is what a trigger stores (see RailTrigger) -- and a
  /// rail sharing its name with another is still offered, so the human
  /// meets the ambiguity as the verdict's sentence rather than as a pick
  /// that quietly does nothing.
  const otherRails = $derived(orch.rails.filter((r) => r.id !== railId));

  const triggerKind = $derived<RailTriggerKind | null>(
    (rail.trigger?.kind as RailTriggerKind | undefined) ?? null
  );

  /// Picking the KIND writes the trigger immediately, even when it is not
  /// yet complete: `rail-done` with no name is stored, and the verdict
  /// says what is missing. The alternative -- holding the choice back
  /// until a rail is named too -- makes the first click do nothing
  /// visible, which reads as a dead control.
  function setTrigger(next: RailTrigger | null): void {
    void setRailTriggerAction(workspaceId, railId, next);
  }

  let naming = $state(false);
  let draftBranch = $state("");
  let draftFrom = $state("HEAD");
  let creating = $state(false);
  /// Why the last "Create and bind" did not take. Said here for the same
  /// reason the fork dialog says its own: the Git tab's error banner is
  /// not on screen from the orchestration hub, so a refusal delegated to
  /// it reached nobody and the button read as dead.
  let createError = $state<string | null>(null);

  /// What a branch made HERE is for: this rail. Seeding both name fields
  /// with it is the whole point of making a branch or a worktree from
  /// the bind dialog rather than from the Git tab -- gavin already knows
  /// the answer, so it should not make the human retype it. Numbered
  /// past the branches that exist, because both fields reject a name the
  /// repo already has and a default that opens on an error is none.
  /// Empty when the rail's name slugs to nothing, which leaves each
  /// input's own placeholder to speak.
  const seedBranch = $derived(freeBranchNameFrom(rail.name, branches.map((b) => b.name)));

  /// Opens the form with the seed in place. Re-seeded on every open, so
  /// Cancel discards a half-typed name rather than preserving it: the
  /// form is a fresh question each time it is asked.
  function startNaming(): void {
    draftBranch = seedBranch;
    createError = null;
    naming = true;
  }

  const draftError = $derived.by(() => {
    const v = validateBranchName(draftBranch);
    if (v) return v;
    if (branches.some((b) => b.name === draftBranch)) return "Branch already exists — pick it above";
    return null;
  });

  /// Roving focus across the strip, per the WAI-ARIA tabs pattern. Only
  /// the keys `railBindTabAfterKey` claims are swallowed -- Escape has to
  /// keep reaching the modal stack.
  function onTabKey(event: KeyboardEvent): void {
    const next = railBindTabAfterKey(tab, event.key);
    if (!next) return;
    event.preventDefault();
    tab = next;
    const el = document.getElementById(`rail-bind-tab-${next}`);
    if (el instanceof HTMLElement) el.focus();
  }

  /// The page the rail's first launch would spawn on its own (spec O16),
  /// made early: named after the rail, opened in the rail's checkout.
  ///
  /// This one DOES open a blank shell, and deliberately. A launch builds
  /// the page around its own session, which is why it no longer leaves an
  /// idle terminal first in the tab strip -- but here there is no session
  /// to build one around, only a human asking for the page now. A page
  /// has to be made of something, and a shell in the rail's checkout is
  /// what they asked for.
  async function bindNewPage(): Promise<void> {
    const pageId = await createPage(workspaceId, (ids) => presetSingle(ids[0]), 1, rail.name, {
      cwd: railCheckout ?? undefined,
    });
    if (pageId) await bindRailAction(workspaceId, railId, { pageId });
  }

  /// Creates the branch WITHOUT checking it out: the rail's own Start is
  /// what moves a checkout, once, when the human arms it.
  async function createAndBind(): Promise<void> {
    if (draftError || creating) return;
    creating = true;
    createError = null;
    const name = draftBranch;
    const created = await createBranch(workspaceId, name, draftFrom === "HEAD" ? null : draftFrom, false);
    creating = false;
    if (!created.ok) {
      createError = created.error;
      return;
    }
    try {
      await bindRailAction(workspaceId, railId, { branch: name });
    } catch (e) {
      // The branch exists; only the binding failed. Closing the form
      // here would report a half-done action as a finished one.
      createError = `Created ${name}, but binding it to this rail failed: ${e instanceof Error ? e.message : String(e)}`;
      return;
    }
    naming = false;
    draftBranch = "";
  }
</script>

{#if forking}
  <GitForkDialog
    {workspaceId}
    agentCommand={resolvedAgentFor(workspaceId).launchCommand}
    branchSeed={seedBranch}
    onRunInWorktree={(path, command) => void runOnRailPage(workspaceId, railId, path, command)}
    allowSpawn={false}
    switchAfter={false}
    onPicked={async (path) => {
      // Closed first, awaited second: the dialog must not hang on a save
      // round trip, but the fork dialog does have to wait for the binding
      // before it opens the setup session, so that session's page is
      // created in the new worktree. `railId`, never `rail.id`: the close
      // below is exactly what makes that prop read `undefined`.
      forking = false;
      onClose();
      await bindRailAction(workspaceId, railId, { worktreePath: path });
    }}
    onClose={() => (forking = false)}
  />
{:else}
  <Modal {onClose}>
    <div class="bind">
      <!-- The dialog names all four settings before the strip does, so
           a human who opened it from the worktree chip learns here that
           the branch, the page and what starts the rail are the same
           dialog away. -->
      <h3>How “{rail.name}” runs</h3>
      <p class="lede">
        What starts it, its checkout, the branch that checkout sits on, and the page its sessions
        land on.
      </p>

      <div class="tabs" role="tablist" aria-label="Rail settings">
        {#each chips as chip (chip.tab)}
          <button
            type="button"
            role="tab"
            id="rail-bind-tab-{chip.tab}"
            aria-selected={tab === chip.tab}
            aria-controls="rail-bind-panel"
            tabindex={tab === chip.tab ? 0 : -1}
            class:on={tab === chip.tab}
            onclick={() => (tab = chip.tab)}
            onkeydown={onTabKey}
          >
            <span class="tab-label">{chip.label}</span>
            <span class="tab-value" class:unset={!chip.bound}>{chip.value}</span>
          </button>
        {/each}
      </div>

      <!-- One panel at a time, and only the one on screen is built: the
           lists together were a 900px scroll in a dialog whose job is one
           question. -->
      <div class="tab-panel" id="rail-bind-panel" role="tabpanel" aria-labelledby="rail-bind-tab-{tab}">
        {#if tab === "trigger"}
          <section title={triggerBlocked ?? undefined}>
            <p class="note">
              What arms this rail without you. Gavin starts it from its first unfinished stage, the
              same as the Start button — it never resumes a paused rail, and never rewinds a running
              one. The condition STANDS: give this rail new work and it runs itself again, so pause
              it when you want it held.
            </p>
            {#if triggerBlocked}
              <p class="err">{triggerBlocked}</p>
            {/if}
            <ul>
              <li>
                <button
                  type="button"
                  class:on={triggerKind === null}
                  disabled={Boolean(triggerBlocked)}
                  onclick={() => setTrigger(null)}
                >
                  <span class="path">Nothing — you start this rail</span>
                  <span class="branch">
                    Or a “Start rail” step on another rail does, which is unaffected by this.
                  </span>
                </button>
              </li>
              {#each RAIL_TRIGGER_CHOICES as choice (choice.kind)}
                <li>
                  <button
                    type="button"
                    class:on={triggerKind === choice.kind}
                    disabled={Boolean(triggerBlocked)}
                    onclick={() =>
                      setTrigger({
                        kind: choice.kind,
                        // The rail a `rail-done` trigger names is picked
                        // in the list below; keeping whatever was there
                        // means re-picking the kind does not erase it.
                        rail: choice.needsRail ? (rail.trigger?.rail ?? null) : null,
                      })}
                  >
                    <span class="path">{choice.label}</span>
                    <span class="branch">{choice.blurb}</span>
                  </button>
                </li>
              {/each}
            </ul>

            <!-- The second half of the two-part question, shown only when
                 the kind asks it. A rail list rather than a text box: the
                 names are known, and a typo here is a rail that waits
                 forever on something that does not exist. -->
            {#if triggerKind === "rail-done"}
              <p class="note">Which rail this one waits for:</p>
              {#if otherRails.length === 0}
                <p class="note">This workspace has no other rail to wait for.</p>
              {:else}
                <ul>
                  {#each otherRails as other (other.id)}
                    <li>
                      <button
                        type="button"
                        class:on={(rail.trigger?.rail ?? "").trim().toLowerCase() ===
                          other.name.trim().toLowerCase()}
                        disabled={Boolean(triggerBlocked)}
                        onclick={() => setTrigger({ kind: "rail-done", rail: other.name })}
                      >
                        <span class="path">{other.name}</span>
                      </button>
                    </li>
                  {/each}
                </ul>
              {/if}
            {/if}

            <!-- What the condition says RIGHT NOW. A trigger is the one
                 setting here whose value does not tell you whether it can
                 ever do anything: "after all rails" is the same words on
                 a rail that fires in a minute and on the only rail in the
                 workspace, which never will. -->
            {#if verdict.kind === "broken"}
              <p class="err" role="alert">This trigger cannot fire: {verdict.reason}.</p>
            {:else if verdict.kind === "wait"}
              <p class="note">Right now: {verdict.reason}.</p>
            {:else if verdict.kind === "fire"}
              <p class="note">
                Right now: nothing is in the way — this rail starts as soon as it has an unfinished
                stage.
              </p>
            {/if}
          </section>
        {:else if tab === "worktree"}
          <section>
            <p class="note">
              Where this rail's steps run. Re-binding affects steps started from now on.
            </p>
            <ul>
              <li>
                <button
                  type="button"
                  class:on={rail.worktreePath === null}
                  onclick={() => void bindRailAction(workspaceId, railId, { worktreePath: null })}
                >
                  <span class="path">None — each card's own folder</span>
                </button>
              </li>
              {#each worktrees as wt (wt.path)}
                <li>
                  <button
                    type="button"
                    class:on={rail.worktreePath === wt.path}
                    onclick={() => void bindRailAction(workspaceId, railId, { worktreePath: wt.path })}
                  >
                    <span class="path">{wt.path}</span>
                    <span class="branch">
                      {wt.branch ?? "detached"}{wt.isMain ? " · main checkout" : ""}
                    </span>
                  </button>
                </li>
              {/each}
            </ul>
            <button type="button" class="secondary" onclick={() => (forking = true)}>New worktree…</button>
          </section>
        {:else if tab === "branch"}
          <section title={branchBlocked ?? undefined}>
            <p class="note">
              Which branch that checkout sits on. Gavin switches
              {railCheckout ?? "the checkout"} before the rail's first step, and refuses while it has
              uncommitted changes.
            </p>
            {#if branchBlocked}
              <p class="err">{branchBlocked}</p>
            {/if}
            <ul>
              <li>
                <button
                  type="button"
                  class:on={!rail.branch}
                  disabled={Boolean(branchBlocked)}
                  onclick={() => void bindRailAction(workspaceId, railId, { branch: null })}
                >
                  <span class="path">None — whatever is checked out</span>
                </button>
              </li>
              {#each branches as b (b.name)}
                {@const where = checkedOutIn.get(b.name) ?? null}
                <li>
                  <button
                    type="button"
                    class:on={rail.branch === b.name}
                    disabled={Boolean(branchBlocked)}
                    onclick={() => void bindRailAction(workspaceId, railId, { branch: b.name })}
                  >
                    <span class="path">{b.name}</span>
                    {#if where === railCheckout && where !== null}
                      <span class="branch">already checked out here</span>
                    {:else if where}
                      <!-- git refuses to check a branch out twice, so this
                           binding stalls at Start until the other checkout
                           moves. Better said here than in a stall reason. -->
                      <span class="branch warn">checked out at {where} — gavin cannot switch to it</span>
                    {/if}
                  </button>
                </li>
              {/each}
            </ul>
            <!-- Without this the list simply shows nothing selected, which
                 reads as "unbound" rather than "bound to something gone". -->
            {#if rail.branch && !branches.some((b) => b.name === rail.branch)}
              <p class="err">Bound to {rail.branch}, which this repo no longer has.</p>
            {/if}
            {#if naming}
              <form class="new-branch" onsubmit={(e) => { e.preventDefault(); void createAndBind(); }}>
                <!-- svelte-ignore a11y_autofocus -->
                <input type="text" bind:value={draftBranch} placeholder="feature/thing" autofocus />
                <select bind:value={draftFrom}>
                  <option value="HEAD">from HEAD{headBranch ? ` (${headBranch})` : ""}</option>
                  {#each branches as b (b.name)}
                    <option value={b.name}>from {b.name}</option>
                  {/each}
                </select>
                <div class="row">
                  <button type="button" class="secondary" onclick={() => (naming = false)}>Cancel</button>
                  <button
                    type="submit"
                    class="secondary"
                    disabled={!!draftError || creating || Boolean(branchBlocked)}
                  >
                    {creating ? "Creating…" : "Create and bind"}
                  </button>
                </div>
                {#if draftError && draftBranch}<div class="err">{draftError}</div>{/if}
                <!-- git's own refusal, in the form that asked for it. -->
                {#if createError}<div class="err" role="alert">{createError}</div>{/if}
              </form>
            {:else}
              <button
                type="button"
                class="secondary"
                disabled={Boolean(branchBlocked)}
                onclick={startNaming}>New branch…</button
              >
            {/if}
          </section>
        {:else}
          <section>
            <p class="note">
              Where this rail's agent sessions land. Unbound, the rail's first launch gives it a page
              of its own, named after it, opening on that session.
            </p>
            <ul>
              <li>
                <button
                  type="button"
                  class:on={rail.pageId === null}
                  onclick={() => void bindRailAction(workspaceId, railId, { pageId: null })}
                >
                  <span class="path">None — a page of its own, made at its first launch</span>
                </button>
              </li>
              {#each pages as page (page.id)}
                <li>
                  <button
                    type="button"
                    class:on={rail.pageId === page.id}
                    onclick={() => void bindRailAction(workspaceId, railId, { pageId: page.id })}
                  >
                    <span class="path">{page.name}</span>
                  </button>
                </li>
              {/each}
            </ul>
            <!-- Same honesty the branch list above shows: a binding to
                 something gone reads as "unbound" otherwise, since nothing
                 in the list is selected. -->
            {#if rail.pageId && !pages.some((p) => p.id === rail.pageId)}
              <p class="note">
                Bound to a page that has since been closed — the next launch will make a new one.
              </p>
            {/if}
            <button type="button" class="secondary" onclick={() => void bindNewPage()}>
              New page “{rail.name}”
            </button>
          </section>
        {/if}
      </div>

      <div class="actions">
        <button type="button" onclick={onClose}>Done</button>
      </div>
    </div>
  </Modal>
{/if}

<style>
  .bind {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 420px;
  }
  h3 {
    margin: 0;
    font-size: 14px;
  }
  .lede {
    margin: -6px 0 0;
    font-size: 11px;
    color: var(--text-subtle);
  }
  .tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--border);
  }
  .tabs button {
    display: flex;
    flex-direction: column;
    gap: 1px;
    flex: 1 1 0;
    min-width: 0;
    padding: 5px 8px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-muted);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  .tabs button:hover {
    background: var(--surface-hover);
  }
  .tabs button.on {
    border-bottom-color: var(--border-focus);
    color: var(--text);
  }
  .tab-label {
    font-size: 12px;
  }
  /* The answer under the question. Ellipsised rather than wrapped: a tab
     that grows a line taller than its neighbours moves the panel under
     it every time the strip is used. */
  .tab-value {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 10px;
    color: var(--text-subtle);
  }
  .tab-value.unset {
    opacity: 0.7;
  }
  /* A floor, not a height: the three panels are different lengths, and a
     dialog that resizes under the pointer on every tab press is what
     makes a strip feel unusable. */
  .tab-panel {
    min-height: 220px;
  }
  section {
    display: flex;
    flex-direction: column;
  }
  .note {
    margin: 0 0 6px;
    font-size: 11px;
    color: var(--text-subtle);
  }
  ul {
    list-style: none;
    margin: 0 0 6px;
    padding: 0;
    max-height: 34vh;
    overflow-y: auto;
  }
  li button {
    display: flex;
    flex-direction: column;
    gap: 1px;
    width: 100%;
    padding: 5px 7px;
    background: none;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--text);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }
  li button:hover {
    background: var(--surface-hover);
  }
  li button.on {
    border-color: var(--border-focus);
    background: var(--surface-accent);
  }
  .path {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .branch {
    color: var(--text-subtle);
    font-size: 10px;
  }
  .branch.warn {
    color: var(--warning-text);
  }
  .new-branch {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .new-branch input,
  .new-branch select {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--text);
    font-family: monospace;
    font-size: 12px;
    padding: 4px 7px;
  }
  .new-branch input:focus,
  .new-branch select:focus {
    outline: none;
    border-color: var(--border-accent);
  }
  .new-branch .row {
    display: flex;
    gap: 6px;
  }
  .new-branch .secondary:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .err {
    color: var(--danger-text);
    font-size: 11px;
  }
  .secondary {
    align-self: flex-start;
    padding: 4px 8px;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--text);
    font-size: 12px;
    cursor: pointer;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
  }
</style>
