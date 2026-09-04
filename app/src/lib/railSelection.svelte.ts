/// The shape `OrchestrationHubView` hands `RailBindDialog`, in runes, so
/// the suite can hold the one thing about it that bites:
///
///   {#if binding && orch}
///     {@const bindingRail = orch.rails.find((r) => r.id === binding)}
///     <RailBindDialog rail={bindingRail} onClose={() => (binding = null)} />
///
/// The compiler emits `rail` as a LAZY getter over that `{@const}`, and
/// the `{@const}` resolves the rail through `binding` — the very state
/// `onClose` clears. So the prop is not a value the child holds: it is a
/// question re-asked on every read, and after the close the answer is
/// `undefined`.
///
/// Lives in a `.svelte.ts` because that is the only place outside a
/// component where `$state`/`$derived` are the real runes rather than a
/// hand-rolled stand-in — a stand-in would be pinning my model of Svelte
/// instead of Svelte.
export interface RailLike {
  id: string;
  name: string;
}

export interface RailSelection {
  /// What the child receives as `rail={bindingRail}`.
  readonly rail: RailLike | undefined;
  /// What the child calls as `onClose()`.
  close(): void;
}

export function railSelection(rails: RailLike[], selected: string): RailSelection {
  let binding = $state<string | null>(selected);
  const bindingRail = $derived(rails.find((r) => r.id === binding));
  return {
    get rail() {
      return bindingRail;
    },
    close() {
      binding = null;
    },
  };
}
