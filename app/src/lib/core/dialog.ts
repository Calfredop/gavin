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

/// A second, smaller answer carried by the same prompt: not "are you
/// sure" again, but a variation on the one action ("also delete the
/// branches"). It exists so a flow that would otherwise ask twice asks
/// once -- two prompts in a row is how a human learns to dismiss the
/// second without reading it.
export interface ConfirmCheck {
  /// What ticking it does, in the same voice as the confirm button.
  label: string;
  /// Ticked when the prompt opens. Default on is for the answer the
  /// caller expects; it is never allowed to make the prompt MORE
  /// destructive than its title says.
  default?: boolean;
}

/// One rung of a ConfirmPicker.
export interface ConfirmPickerOption {
  value: string;
  label: string;
  /// What choosing this rung costs, under its label. Optional: a picker
  /// choosing a destination ("move the cards to...") has nothing to add,
  /// while a severity ladder has nothing BUT this to say.
  detail?: string;
  /// This rung ends something that cannot be got back. The prompt keeps
  /// focus on the dismissing button while it is the one picked, so a
  /// ladder is safe to answer by reflex at the top and never at the
  /// bottom.
  danger?: boolean;
}

/// A ladder of answers to the one question, where the rungs are the
/// answer rather than a variation on it.
///
/// It exists for ConfirmCheck's reason -- one prompt rather than a
/// second one nobody reads -- but for a question whose answers are a
/// severity order ("this window" ... "and stop the daemon") rather than
/// a yes with a tick-box hung off it.
export interface ConfirmPicker {
  /// What the ladder chooses, above it. One short line.
  label: string;
  options: ConfirmPickerOption[];
  /// The rung the prompt opens on, and the answer when the human
  /// touches nothing. Never a rung more destructive than the title
  /// says, for the reason a tick-box is never default-on.
  default?: string;
  /// Show every rung at once rather than folding them into a <select>.
  /// A destructive ladder must be expanded: answers hidden behind a
  /// click cannot be claimed to have been read.
  expanded?: boolean;
}

/// Both halves of the answer. `checked` is meaningless when `confirmed`
/// is false, and is reported as the value the box was left at rather
/// than reset -- nobody reads it after a cancel.
export interface ConfirmAnswer {
  confirmed: boolean;
  checked: boolean;
  /// The rung, for a prompt that carried a ladder. Absent -- not null
  /// -- for one that did not, so every caller that never asked for a
  /// picker keeps the answer shape it always had.
  picked?: string;
}

/// A block of text the prompt shows VERBATIM, in a scrollable
/// monospace box under the consequence lines.
///
/// It exists for the one kind of question where a paraphrase is the
/// whole failure: the first-Run card review (`cardReview.ts`) asks a
/// human to agree to a prompt an agent is about to be handed, and a
/// summary of that prompt would be a second description to keep in step
/// with the thing actually sent. Every other prompt in the app says what
/// will happen in `lines`, and should keep doing so -- this is not a
/// place to put prose.
export interface ConfirmBlock {
  /// What the box is, above it. One short line.
  label: string;
  /// The text, exactly as it will be used. Never rendered as markdown
  /// or HTML: an HTML comment in it is content the reader has to SEE.
  text: string;
}

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
  /// An optional tick-box above the buttons. Only `askConfirmChecked`
  /// reads its value back; `askConfirm` still resolves to a plain
  /// boolean, so no existing call site has to care.
  check?: ConfirmCheck;
  /// A ladder of answers, read back by `askConfirmPicked`. A prompt
  /// carries one or the other: a ladder whose rungs already say "and
  /// end the sessions" plus a box saying the same thing is two controls
  /// that can disagree.
  picker?: ConfirmPicker;
  /// Text the reader must be able to see byte for byte. See ConfirmBlock.
  block?: ConfirmBlock;
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
  check: ConfirmCheck | null;
  picker: ConfirmPicker | null;
  block: ConfirmBlock | null;
}

interface Pending {
  request: DialogRequest;
  resolve: (answer: ConfirmAnswer) => void;
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

function enqueue(request: DialogRequest): Promise<ConfirmAnswer> {
  return new Promise<ConfirmAnswer>((resolve) => {
    queue.push({ request, resolve });
    if (queue.length === 1) head.set(request);
  });
}

function confirmRequest(options: ConfirmOptions): DialogRequest {
  return {
    id: nextId++,
    title: options.title,
    lines: options.lines ?? [],
    confirmLabel: options.confirmLabel,
    cancelLabel: options.cancelLabel ?? "Cancel",
    danger: options.danger ?? false,
    check: options.check ?? null,
    picker: options.picker ?? null,
    block: options.block ?? null,
  };
}

/// Asks the question and resolves to whether the human said yes.
/// Drop-in for the native `confirm()` these call sites used to await.
export async function askConfirm(options: ConfirmOptions): Promise<boolean> {
  return (await enqueue(confirmRequest(options))).confirmed;
}

/// The same prompt, for a caller that also needs the tick-box back --
/// one question that settles both halves of what will happen, rather
/// than a confirm followed by a second prompt asking the follow-up.
export function askConfirmChecked(options: ConfirmOptions & { check: ConfirmCheck }): Promise<ConfirmAnswer> {
  return enqueue(confirmRequest(options));
}

/// The same prompt, asked as a ladder: one question whose answer is
/// which rung the human picked. `default` is required here and not
/// merely honoured, because that is what makes the answer total -- an
/// untouched prompt still resolves to a rung, so no call site has to
/// invent its own fallback and drift from the one the modal showed.
export function askConfirmPicked(
  options: ConfirmOptions & { picker: ConfirmPicker & { default: string } }
): Promise<ConfirmAnswer & { picked: string }> {
  return enqueue(confirmRequest(options)) as Promise<ConfirmAnswer & { picked: string }>;
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
    check: null,
    picker: null,
    block: null,
  });
}

/// Settles the request on screen and promotes the next one. An id that
/// is not the current head is ignored, which is what makes a
/// double-answer harmless -- Escape and a click on the same dialog both
/// land here, and only the first one counts.
///
/// `checked` is whatever the tick-box was left at; a prompt without one
/// answers false and nobody reads it.
///
/// `picked` is the rung, and null means the human never touched the
/// ladder -- which is an answer, not the absence of one: it resolves to
/// the rung the prompt opened on. A prompt with no ladder carries no
/// `picked` key at all rather than a null every existing caller would
/// have to start ignoring.
export function answerDialog(
  id: number,
  confirmed: boolean,
  checked = false,
  picked: string | null = null
): void {
  const current = queue[0];
  if (!current || current.request.id !== id) return;
  queue = queue.slice(1);
  head.set(queue[0]?.request ?? null);
  const ladder = current.request.picker;
  if (!ladder) {
    current.resolve({ confirmed, checked });
    return;
  }
  current.resolve({ confirmed, checked, picked: picked ?? ladder.default ?? ladder.options[0]?.value });
}

/// Test-only reset: drops every queued request without settling it, so
/// one suite's leftovers cannot answer another's question.
export function resetDialogs(): void {
  queue = [];
  head.set(null);
}
