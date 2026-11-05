// Which session statuses mean the agent's turn is over. Its own module,
// importing nothing, so the Companion's code and every pure module can ask
// without pulling the notification plugin `notifications.ts` imports.

/// Whether the agent's turn is over and it sits at its prompt: `idle`,
/// or one of its two refinements. Everything that ACTS on a finished turn
/// -- a rail step completing, a follow-up going out, a verdict being
/// read -- asks this rather than `=== "idle"`, so the refinements never
/// become turns that did not end. Surfaces that only DRAW a status
/// compare to the word itself, because there the difference is the point.
///
/// `background` ends the turn on purpose: an agent that left a dev server
/// running has finished all the same, and holding a rail on that shell
/// would hold it for as long as the server lives.
export function endsTurn(status: string | null | undefined): boolean {
  return status === "idle" || status === "background" || status === "done";
}
