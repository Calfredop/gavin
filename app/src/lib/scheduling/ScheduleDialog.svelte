<script lang="ts">
  // The Schedule dialog: when a Scheduled task fires, and which agent runs
  // it. Opened for a task card ("Schedule…"), for a task from scratch
  // ("New scheduled task") and for an existing task ("Edit schedule").
  // The form and the rule it makes live in scheduleDialog.ts; the writes
  // in scheduledActions.ts.
  import Modal from "$lib/core/Modal.svelte";
  import { agentForCard, profilesForWorkspace } from "$lib/core/layoutState";
  import {
    UNIT_OPTIONS,
    agentVerdict,
    defaultForm,
    formFromRule,
    formRule,
    type ScheduleForm,
  } from "$lib/scheduling/scheduleDialog";
  import { scheduledAgentFields } from "$lib/scheduling/scheduledRun";
  import { describeRule } from "$lib/scheduling/schedule";
  import { saveSchedule, type ScheduleRequest } from "$lib/scheduling/scheduledActions";

  interface Props {
    request: ScheduleRequest;
    onClose: () => void;
  }
  let { request, onClose }: Props = $props();

  const now = new Date();
  // Seeded once from the request it opened for: the dialog edits its own
  // copy, and is remounted for the next request.
  // svelte-ignore state_referenced_locally
  let form = $state<ScheduleForm>(
    request.mode === "edit" ? formFromRule(request.task.rule, now) : defaultForm(now)
  );
  let title = $state("");
  let body = $state("");
  let picked = $state<string>("");
  let saving = $state(false);
  let error = $state<string | null>(null);

  const heading = $derived(
    request.mode === "card"
      ? `Schedule “${request.title}”`
      : request.mode === "edit"
        ? `Edit the schedule of “${request.task.title}”`
        : "New scheduled task"
  );

  const fields = $derived(
    request.mode === "card" ? request.fields : request.mode === "edit" ? scheduledAgentFields(request.task) : {}
  );
  const verdict = $derived(
    agentVerdict(agentForCard(request.workspaceId, fields), profilesForWorkspace(request.workspaceId))
  );
  $effect(() => {
    if (verdict.kind === "pick" && !verdict.choices.some((c) => c.id === picked)) picked = verdict.choices[0].id;
  });

  const rule = $derived(formRule(form));
  const blocked = $derived(
    verdict.kind === "blocked"
      ? verdict.reason
      : typeof rule === "string"
        ? rule
        : request.mode === "new" && !title.trim()
          ? "Give the task a title"
          : null
  );

  async function submit(): Promise<void> {
    if (blocked || typeof rule === "string" || saving) return;
    saving = true;
    error = null;
    try {
      error = await saveSchedule(
        request,
        rule,
        verdict.kind === "pick" ? picked : null,
        request.mode === "new" ? { title: title.trim(), body } : null
      );
      if (!error) onClose();
    } finally {
      saving = false;
    }
  }
</script>

<Modal {onClose}>
  <form class="schedule" onsubmit={(e) => { e.preventDefault(); void submit(); }}>
    <h3>{heading}</h3>
    {#if request.mode === "card"}
      <p class="lead">
        Makes a Scheduled task: a copy of this card that runs on its own, headless, in this
        workspace's checkout. The card itself stays where it is, and the two do not follow each
        other's edits.
      </p>
    {/if}

    {#if request.mode === "new"}
      <label class="field">
        <span>Title</span>
        <input type="text" bind:value={title} placeholder="Nightly dependency check" />
      </label>
      <label class="field">
        <span>Prompt</span>
        <textarea rows="5" bind:value={body} placeholder="What the agent should do on each run"></textarea>
      </label>
    {/if}

    <label class="field">
      <span>Starts</span>
      <input type="datetime-local" bind:value={form.at} />
    </label>

    <label class="check">
      <input type="checkbox" bind:checked={form.repeat} />
      <span>Repeat</span>
    </label>
    {#if form.repeat}
      <div class="inline">
        <span>every</span>
        <input class="num" type="number" min="1" bind:value={form.n} aria-label="Interval" />
        <select bind:value={form.unit} aria-label="Interval unit">
          {#each UNIT_OPTIONS as option (option.unit)}
            <option value={option.unit}>{option.label}</option>
          {/each}
        </select>
      </div>
      <div class="inline">
        <label class="check">
          <input type="radio" name="runs" value="indefinite" bind:group={form.runsMode} />
          <span>indefinitely</span>
        </label>
        <label class="check">
          <input type="radio" name="runs" value="count" bind:group={form.runsMode} />
          <span>for</span>
        </label>
        <input
          class="num"
          type="number"
          min="1"
          bind:value={form.runs}
          disabled={form.runsMode !== "count"}
          aria-label="Number of runs"
        />
        <span>runs</span>
      </div>
    {/if}

    {#if typeof rule !== "string"}
      <p class="summary">{describeRule(rule, now)}</p>
    {/if}

    <div class="agent">
      {#if verdict.kind === "ok"}
        <span>Runs on <strong>{verdict.label}</strong>, headless.</span>
      {:else if verdict.kind === "pick"}
        <span>{verdict.why}. Run it on:</span>
        <select bind:value={picked} aria-label="Agent for the scheduled run">
          {#each verdict.choices as choice (choice.id)}
            <option value={choice.id}>{choice.label}</option>
          {/each}
        </select>
      {:else}
        <span class="err">{verdict.reason}</span>
      {/if}
    </div>

    {#if error}<div class="err">{error}</div>{/if}

    <div class="actions">
      <button type="button" onclick={onClose}>Cancel</button>
      <button type="submit" class="primary" disabled={blocked !== null || saving} title={blocked ?? ""}>
        {saving ? "Saving…" : request.mode === "edit" ? "Save schedule" : "Schedule"}
      </button>
    </div>
  </form>
</Modal>

<style>
  .schedule {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 420px;
    max-width: 520px;
    color: var(--text);
  }
  h3 {
    margin: 0;
    font-size: 1em;
  }
  .lead,
  .summary {
    margin: 0;
    font-size: 0.78em;
    color: var(--text-muted);
    line-height: 1.45;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.82em;
    color: var(--text-muted);
  }
  .check,
  .inline {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.82em;
  }
  .inline {
    gap: 8px;
    padding-left: 22px;
  }
  input[type="text"],
  input[type="datetime-local"],
  input.num,
  textarea,
  select {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-size: 0.9em;
    padding: 4px 6px;
    min-width: 0;
  }
  textarea {
    resize: vertical;
    font-family: inherit;
  }
  input.num {
    width: 64px;
  }
  input:focus,
  textarea:focus,
  select:focus {
    outline: none;
    border-color: var(--border-accent);
  }
  .agent {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 0.82em;
    color: var(--text-muted);
  }
  .err {
    color: var(--danger-text);
    font-size: 0.82em;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .actions button {
    background: var(--surface-overlay);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    cursor: pointer;
    font-family: monospace;
    padding: 5px 12px;
  }
  .actions .primary {
    background: var(--surface-success);
    border-color: var(--border-success);
    color: var(--success-text);
  }
  .actions button:disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
