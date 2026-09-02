// Which modal Escape belongs to.
//
// Modal.svelte listens on the WINDOW, because a backdrop cannot receive
// key events it never has focus for. That is fine for one modal and
// wrong for two: a confirm raised from inside another modal (delete from
// the card detail, archive from a board card's detail) would take one
// Escape and close both -- the answer to the question AND the surface
// that asked it.
//
// So every mounted Modal takes a token here, and only the token on top
// answers Escape. A stack rather than a counter because teardown order
// is not guaranteed to be the reverse of mount order once a modal closes
// the surface underneath it.

const stack: symbol[] = [];

/// Called by Modal.svelte on mount. The returned token is the modal's
/// identity for as long as it is on screen.
export function pushModal(label = "modal"): symbol {
  const token = Symbol(label);
  stack.push(token);
  return token;
}

/// Called on teardown. Removes the token wherever it sits, so a modal
/// that outlives one opened on top of it still leaves the stack honest.
export function popModal(token: symbol): void {
  const i = stack.lastIndexOf(token);
  if (i !== -1) stack.splice(i, 1);
}

/// Whether this modal is the one an Escape is meant for.
export function isTopModal(token: symbol): boolean {
  return stack.length > 0 && stack[stack.length - 1] === token;
}

/// Test-only: the stack is module state shared by every Modal instance.
export function resetModalStack(): void {
  stack.length = 0;
}
