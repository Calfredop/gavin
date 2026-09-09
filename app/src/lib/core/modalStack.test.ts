import { describe, it, expect, beforeEach } from "vitest";
import { pushModal, popModal, isTopModal, resetModalStack } from "$lib/core/modalStack";

beforeEach(() => {
  resetModalStack();
});

describe("modalStack", () => {
  it("gives Escape to the modal opened last", () => {
    const detail = pushModal("card detail");
    expect(isTopModal(detail)).toBe(true);
    const confirmDelete = pushModal("confirm");
    // The card detail underneath must not also close on that Escape.
    expect(isTopModal(detail)).toBe(false);
    expect(isTopModal(confirmDelete)).toBe(true);
  });

  it("hands Escape back when the top one closes", () => {
    const detail = pushModal();
    const confirmDelete = pushModal();
    popModal(confirmDelete);
    expect(isTopModal(detail)).toBe(true);
  });

  it("survives an out-of-order teardown", () => {
    // Answering the confirm can dismiss the surface that raised it, and
    // then the two tear down in mount order rather than reverse.
    const detail = pushModal();
    const confirmDelete = pushModal();
    popModal(detail);
    expect(isTopModal(confirmDelete)).toBe(true);
    popModal(confirmDelete);
    expect(isTopModal(confirmDelete)).toBe(false);
  });

  it("ignores a token that is no longer on the stack", () => {
    const gone = pushModal();
    popModal(gone);
    popModal(gone);
    const other = pushModal();
    expect(isTopModal(other)).toBe(true);
  });
});
