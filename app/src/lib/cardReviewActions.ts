/// The first-Run review, wired: read the marker, raise the sheet, stamp
/// the answer. The decisions all live in `cardReview.ts`; this is the
/// half that touches the store and the dialog layer.
///
/// Separate from `cardRunActions.ts` because both a launcher and a
/// COMPONENT need it — the card detail modal offers the same review, so
/// that a rail step stalled on an unreviewed card has somewhere to be
/// answered without spawning a session first.

import { askConfirm } from "./dialog";
import { cardReviewed, stampCardReview } from "./layoutState";
import {
  REVIEW_CANCEL_LABEL,
  REVIEW_CONFIRM_LABEL,
  reviewLines,
  reviewTitle,
  reviewedAttachments,
  type CardContent,
} from "./cardReview";
import type { AttachmentStatus } from "./attachments";

/// Everything the sheet shows, gathered by the caller before anything is
/// created. `prompt` is the composed prompt itself — the exact bytes the
/// agent is handed — and `statuses` is what the host resolved each
/// `attachments:` entry to.
export interface CardReviewRequest {
  workspaceId: string;
  /// The card's path, which is what the marker is keyed by.
  path: string;
  content: CardContent;
  statuses: readonly AttachmentStatus[];
  prompt: string;
  /// Overrides the block's label ("The prompt the agent receives:") for
  /// a launch whose composed prompt carries none of the card — develop's
  /// does not, so `prompt` here is the card body instead, and the label
  /// has to say that rather than call it a prompt it isn't.
  blockLabel?: string;
}

/// Whether this launch may go ahead: true when the human has already read
/// exactly this content, or reads it now and says yes.
///
/// Every caller must run this BEFORE the status write and before any
/// session, worktree or page is created. A refused review has to leave
/// the card exactly as it was — writing In Progress and then asking would
/// move the card on the board for a run the human then declined, and they
/// would have to put it back by hand.
///
/// The stamp is taken from the content that was SHOWN, so a card edited
/// between the sheet opening and the button being pressed cannot be
/// approved by a click aimed at something else: the next launch re-reads
/// the file, finds a different digest, and asks again.
export async function ensureCardReviewed(request: CardReviewRequest): Promise<boolean> {
  if (cardReviewed(request.workspaceId, request.path, request.content)) return true;
  const confirmed = await askConfirm({
    title: reviewTitle(request.content.title),
    lines: reviewLines(request.content, reviewedAttachments(request.statuses)),
    block: { label: request.blockLabel ?? "The prompt the agent receives:", text: request.prompt },
    confirmLabel: REVIEW_CONFIRM_LABEL,
    cancelLabel: REVIEW_CANCEL_LABEL,
    // `danger` for its second effect rather than its first: it keeps
    // keyboard focus on the DISMISSING button, so Enter cannot launch an
    // agent on text nobody has read yet. The red button is the honest
    // colour for it too — this is the click that hands a repository's
    // words to a process running as the human.
    danger: true,
  });
  if (!confirmed) return false;
  await stampCardReview(request.workspaceId, request.path, request.content);
  return true;
}
