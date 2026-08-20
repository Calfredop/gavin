//! Geometry for the native macOS "double-click a window edge to extend it
//! to the screen edge" gesture. Pure and platform-independent so it can
//! be unit-tested anywhere; `mac_window.rs` feeds it real NSWindow frames.
//!
//! Coordinates follow AppKit: origin bottom-left, y grows upward.

/// A rectangle in AppKit screen coordinates.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
        Rect { x, y, w, h }
    }
    fn max_x(&self) -> f64 {
        self.x + self.w
    }
    fn max_y(&self) -> f64 {
        self.y + self.h
    }
}

/// Which window edges a click landed on, within tolerance.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Edges {
    pub left: bool,
    pub right: bool,
    pub bottom: bool,
    pub top: bool,
}

impl Edges {
    pub fn any(&self) -> bool {
        self.left || self.right || self.bottom || self.top
    }
}

/// Classify a screen-space click against `frame`'s edges. A click counts
/// for an edge when it is within `tolerance` of that edge's line (inside
/// or slightly outside the frame) and within the frame's extent along the
/// other axis, so a corner lights up both adjacent edges.
pub fn hit_edges(frame: Rect, click: (f64, f64), tolerance: f64) -> Edges {
    let (cx, cy) = click;
    let within_x = cx >= frame.x - tolerance && cx <= frame.max_x() + tolerance;
    let within_y = cy >= frame.y - tolerance && cy <= frame.max_y() + tolerance;
    if !(within_x && within_y) {
        return Edges::default();
    }
    Edges {
        left: (cx - frame.x).abs() <= tolerance,
        right: (cx - frame.max_x()).abs() <= tolerance,
        bottom: (cy - frame.y).abs() <= tolerance,
        top: (cy - frame.max_y()).abs() <= tolerance,
    }
}

/// The frame after extending the hit edges to the corresponding edges of
/// `screen` (the display's visible frame -- menu bar and Dock excluded).
/// With `opposite_too` (Option held) the opposite edge extends as well,
/// matching macOS. Returns `None` when nothing was hit or nothing would
/// change, so callers can let the event through untouched.
pub fn expanded_frame(frame: Rect, screen: Rect, edges: Edges, opposite_too: bool) -> Option<Rect> {
    if !edges.any() {
        return None;
    }
    let mut x0 = frame.x;
    let mut x1 = frame.max_x();
    let mut y0 = frame.y;
    let mut y1 = frame.max_y();

    if edges.left || (opposite_too && edges.right) {
        x0 = screen.x;
    }
    if edges.right || (opposite_too && edges.left) {
        x1 = screen.max_x();
    }
    if edges.bottom || (opposite_too && edges.top) {
        y0 = screen.y;
    }
    if edges.top || (opposite_too && edges.bottom) {
        y1 = screen.max_y();
    }

    let out = Rect::new(x0, y0, x1 - x0, y1 - y0);
    if out == frame {
        None
    } else {
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A 400x300 window sitting inside a 1440x(900-25 menu bar) screen,
    // with room on every side.
    const FRAME: Rect = Rect { x: 500.0, y: 300.0, w: 400.0, h: 300.0 };
    const SCREEN: Rect = Rect { x: 0.0, y: 0.0, w: 1440.0, h: 875.0 };
    const TOL: f64 = 6.0;

    fn go(click: (f64, f64), opt: bool) -> Option<Rect> {
        expanded_frame(FRAME, SCREEN, hit_edges(FRAME, click, TOL), opt)
    }

    #[test]
    fn click_in_the_middle_hits_nothing() {
        assert_eq!(hit_edges(FRAME, (700.0, 450.0), TOL), Edges::default());
        assert_eq!(go((700.0, 450.0), false), None);
    }

    #[test]
    fn click_far_outside_hits_nothing() {
        assert_eq!(go((100.0, 100.0), false), None);
        // Same x as the left edge but above the window entirely.
        assert_eq!(go((500.0, 700.0), false), None);
    }

    #[test]
    fn left_edge_extends_to_screen_left_only() {
        assert_eq!(go((502.0, 450.0), false), Some(Rect::new(0.0, 300.0, 900.0, 300.0)));
    }

    #[test]
    fn right_edge_extends_to_screen_right_only() {
        assert_eq!(go((898.0, 450.0), false), Some(Rect::new(500.0, 300.0, 940.0, 300.0)));
    }

    #[test]
    fn bottom_edge_extends_to_screen_bottom_only() {
        assert_eq!(go((700.0, 303.0), false), Some(Rect::new(500.0, 0.0, 400.0, 600.0)));
    }

    #[test]
    fn top_edge_extends_to_screen_top_only() {
        assert_eq!(go((700.0, 597.0), false), Some(Rect::new(500.0, 300.0, 400.0, 575.0)));
    }

    #[test]
    fn corner_extends_both_adjacent_edges() {
        assert_eq!(go((898.0, 597.0), false), Some(Rect::new(500.0, 300.0, 940.0, 575.0)));
    }

    #[test]
    fn slightly_outside_the_frame_still_counts() {
        assert_eq!(go((496.0, 450.0), false), Some(Rect::new(0.0, 300.0, 900.0, 300.0)));
        assert_eq!(go((700.0, 604.0), false), Some(Rect::new(500.0, 300.0, 400.0, 575.0)));
    }

    #[test]
    fn beyond_tolerance_does_not_count() {
        assert_eq!(go((507.0, 450.0), false), None);
        assert_eq!(go((493.0, 450.0), false), None);
    }

    #[test]
    fn option_extends_the_opposite_edge_too() {
        assert_eq!(go((502.0, 450.0), true), Some(Rect::new(0.0, 300.0, 1440.0, 300.0)));
        assert_eq!(go((700.0, 597.0), true), Some(Rect::new(500.0, 0.0, 400.0, 875.0)));
    }

    #[test]
    fn option_on_the_right_or_bottom_edge_extends_the_far_side() {
        assert_eq!(go((898.0, 450.0), true), Some(Rect::new(0.0, 300.0, 1440.0, 300.0)));
        assert_eq!(go((700.0, 303.0), true), Some(Rect::new(500.0, 0.0, 400.0, 875.0)));
    }

    #[test]
    fn option_on_a_corner_fills_the_screen() {
        assert_eq!(go((502.0, 302.0), true), Some(SCREEN));
    }

    #[test]
    fn already_at_the_screen_edge_is_a_no_op() {
        let flush = Rect::new(0.0, 300.0, 400.0, 300.0);
        let edges = hit_edges(flush, (2.0, 450.0), TOL);
        assert!(edges.left);
        assert_eq!(expanded_frame(flush, SCREEN, edges, false), None);
    }
}
