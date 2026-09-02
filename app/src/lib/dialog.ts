// The app's own alert/confirm layer: one queue, one AppDialog.svelte
// mounted at the app root (+page.svelte), drawing the same
// ConfirmPrompt every other surface in gavin already uses. Same family
// as contextMenu.ts and tooltip.ts -- a module-level store, so plain
// .ts modules (confirmClose, archiveActions, layoutState) can ask a
// question without owning a component of their own.
//
// It exists because those call sites used to reach for the OS dialogs in
// @tauri-apps/plugin-dialog, and an OS dialog is the wrong instrument
// here for three reasons: it is drawn by macOS, so it ignores the theme
// the rest of the window obeys; its buttons can only say OK/Cancel, so
// every prompt lost the verb that made it answerable ("Close tab",
// "Restore", "Start fresh"); and it can carry one blob of text where
// these prompts want a title plus a list of consequences. The
// capability list is narrowed to `dialog:allow-open` (the file picker,
// which genuinely is an OS service) so a reintroduced native confirm
// fails loudly rather than quietly looking foreign.

import { writable, type Readable } from "svelte/store";

export interface ConfirmOptions {
  /// The question, as a question -- the modal's heading.
  title: string;
  /// What answering "yes" costs, one consequence per line. The same
  /// voice as every other ConfirmPrompt in the app.
  lines?: string[];
  /// The verb, not "OK": the button has to say what it does, because
  /// after a mis-click that label is the only record of what happened.
  confirmLabel: string;
  /// The other answer. Defaults to "Cancel"; a flow whose second answer
  /// is itself an action ("Start fresh") names it instead.
  cancelLabel?: string;
  /// Styles the confirm button red AND leaves keyboard focus on the
  /// dismissing button, so Enter cannot fire it by reflex.
  danger?: boolean;
}

export interface AlertOptions {
  title: string;
  lines?: string[];
  /// The single button. "OK" unless the caller has a better word.
  dismissLabel?: string;
}

/// What AppDialog.svelte renders. `confirmLabel` is null for an alert,
/// which is the whole difference between the two: an alert has one
/// button and no second answer.
export interface DialogRequest {
  id: number;
  title: string;
  lines: string[];
  confirmLabel: string | null;
  cancelLabel: string;
  danger: boolean;
}

interface Pending {
  request: DialogRequest;
  resolve: (confirmed: boolean) => void;
}

// FIFO, not last-one-wins: two failures in a row (a menu action that
// reports, then its retry) each deserve to be read. The OS dialogs
// queued for the same reason, and dropping that would make the second
// error invisible.
let queue: Pending[] = [];
let nextId = 1;

const head = writable<DialogRequest | null>(null);

/// The request on screen, or null. Read-only on purpose: answers go
/// through answerDialog so the promise is settled exactly once.
export const dialogRequest: Readable<DialogRequest | null> = { subscribe: head.subscribe };

function enqueue(request: DialogRequest): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    queue.push({ request, resolve });
    if (queue.length === 1) head.set(request);
  });
}

/// Asks the question and resolves to whether the human said yes.
/// Drop-in for the native `confirm()` these call sites used to await.
export function askConfirm(options: ConfirmOptions): Promise<boolean> {
  return enqueue({
    id: nextId++,
    title: options.title,
    lines: options.lines ?? [],
    confirmLabel: options.confirmLabel,
    cancelLabel: options.cancelLabel ?? "Cancel",
    danger: options.danger ?? false,
  });
}

/// States something and resolves when it has been dismissed. Drop-in
/// for the native `message()`; awaited by callers that want to know the
/// human has seen it, ignored by the ones that only had to say it.
export async function showAlert(options: AlertOptions): Promise<void> {
  await enqueue({
    id: nextId++,
    title: options.title,
    lines: options.lines ?? [],
    confirmLabel: null,
    cancelLabel: options.dismissLabel ?? "OK",
    danger: false,
  });
}

/// Settles the request on screen and promotes the next one. An id that
/// is not the current head is ignored, which is what makes a
/// double-answer harmless -- Escape and a click on the same dialog both
/// land here, and only the first one counts.
export function answerDialog(id: number, confirmed: boolean): void {
  const current = queue[0];
  if (!current || current.request.id !== id) return;
  queue = queue.slice(1);
  head.set(queue[0]?.request ?? null);
  current.resolve(confirmed);
}

/// Test-only reset: drops every queued request without settling it, so
/// one suite's leftovers cannot answer another's question.
export function resetDialogs(): void {
  queue = [];
  head.set(null);
}
