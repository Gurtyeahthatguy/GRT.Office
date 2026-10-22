//! When the main window may close.

use std::time::{Duration, Instant};

/// How long the page has to acknowledge a close request before it is presumed
/// dead and the window is let go.
pub const UNANSWERED: Duration = Duration::from_secs(3);

/// What to do with a request to close the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Close,
    Ask,
}

/// The state behind the decision.
#[derive(Debug, Default)]
pub struct Guard {
    held: bool,
    asked: Option<Instant>,
    answered: bool,
}

impl Guard {
    /// Holds the window open, or lets it go.
    pub fn hold(&mut self, held: bool) {
        self.held = held;
        if !held {
            self.asked = None;
            self.answered = false;
        }
    }

    /// The page received the last request.
    pub fn answer(&mut self) {
        self.answered = true;
    }

    /// Decides on a request to close, made at `now`.
    pub fn request(&mut self, now: Instant) -> Decision {
        if !self.held {
            return Decision::Close;
        }
        match self.asked {
            Some(at) if !self.answered => {
                if now.saturating_duration_since(at) > UNANSWERED {
                    Decision::Close
                } else {
                    Decision::Ask
                }
            }
            _ => {
                self.asked = Some(now);
                self.answered = false;
                Decision::Ask
            }
        }
    }
}
