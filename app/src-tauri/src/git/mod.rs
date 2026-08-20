//! The Git tab's backend: shells out to the system `git` (spec
//! docs/superpowers/specs/2026-08-20-git-tab-local-changes-design.md §2).
pub mod commands;
pub mod ops;
pub mod parse;
pub mod run;
pub mod types;
pub mod watch;

pub use commands::*;
pub use ops::*;
pub use watch::*;
