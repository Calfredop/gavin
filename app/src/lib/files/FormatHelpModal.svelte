<script lang="ts">
  import Modal from "$lib/core/Modal.svelte";

  interface Props {
    onClose: () => void;
  }
  let { onClose }: Props = $props();
</script>

<Modal {onClose}>
  <div class="help">
    <div class="title">gavin file formats</div>

    <p>
      A context is a folder holding <code>.gavin/</code> (the workspace root holds
      <code>.gavin-root/</code>), each with <code>plans/</code>, <code>docs/</code> and
      <code>specs/</code> inside.
    </p>

    <div class="section">plans/*.md — cards on the board</div>
    <p>
      Flat <code>key: value</code> frontmatter between <code>---</code> lines. Every field is
      optional; <code>kind</code> defaults to <code>plan</code>.
    </p>
    <pre>---
kind: plan          # note | task | plan
title: Auth rework
status: In Progress # a board column name
priority: high      # none|low|medium|high|urgent
labels: bug, ui
parent: epic.md     # nests under that plan when status is unset
order: 1024         # manual board position
---
- [ ] steps as ordinary markdown checklists
- [x] ticked items count as board progress</pre>
    <ul>
      <li><b>note</b> — a reminder; title plus optional body.</li>
      <li><b>task</b> — one unit of agent work; <b>the body is the prompt</b> an agent runs.</li>
      <li><b>plan</b> — multi-step work; the body holds checklists.</li>
    </ul>

    <div class="section">docs/ and specs/</div>
    <p>Plain markdown, subfolders allowed. No frontmatter contract.</p>

    <div class="section">config.toml</div>
    <pre>name = "auth"        # display name of the context
# root config only:
[agent]
profile = "claude-code"
extra_contexts = ["/abs/folder"]  # contexts outside the workspace</pre>
  </div>
</Modal>

<style>
  .help {
    font-family: monospace;
    font-size: 0.85em;
    color: var(--text);
    max-width: 440px;
  }
  .title {
    font-weight: bold;
    color: var(--text);
    margin-bottom: 10px;
  }
  .section {
    color: var(--success-text);
    margin: 14px 0 4px;
  }
  p {
    margin: 6px 0;
    line-height: 1.45;
  }
  ul {
    margin: 6px 0;
    padding-left: 18px;
  }
  li {
    margin-bottom: 3px;
  }
  pre {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 10px;
    overflow-x: auto;
    font-size: 0.95em;
    line-height: 1.4;
    color: var(--text-muted);
  }
  code {
    color: var(--warning-text);
  }
  b {
    color: var(--text);
  }
</style>
