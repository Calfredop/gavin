// The Review tab's entry into Critical review. `criticalReviewOffer` in
// reviewBoard.ts decides card vs rail from the current selection; these
// re-exports are the launch side the hub calls once it has that answer.
//
// Pure re-exports — no behaviour of their own.

export {
  requestCardCriticalReview,
  requestRailCriticalReview,
} from "$lib/review/criticalReviewActions";

export {
  criticalReviewOffer,
  type ReviewCriticalOffer,
} from "$lib/review/reviewBoard";
