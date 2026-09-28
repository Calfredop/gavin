//! The gateway's only log.
//!
//! The rule every caller keeps: a line is built from ids, counts, route
//! templates, status codes and Apple's or Google's reason codes, and
//! NEVER from a payload, a push token, a device secret or a permission.
//! The ciphertext is opaque, but it is still the one thing this service
//! exists to pass along without keeping, and a token or a secret in a log
//! is a credential in a log. Nothing here formats a request body, a raw
//! request path or an HTTP client error (whose Display carries the URL,
//! and an APNs URL carries the push token).

use std::sync::{Arc, Mutex};

pub trait LogSink: Send + Sync {
    fn line(&self, line: &str);
}

/// Standard error, which is what `docker logs` collects and timestamps.
pub struct Stderr;

impl LogSink for Stderr {
    fn line(&self, line: &str) {
        eprintln!("{line}");
    }
}

/// Every line, kept for a test to search.
#[derive(Default)]
pub struct CapturedLog(Mutex<Vec<String>>);

impl CapturedLog {
    pub fn lines(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }

    pub fn text(&self) -> String {
        self.lines().join("\n")
    }
}

impl LogSink for CapturedLog {
    fn line(&self, line: &str) {
        self.0.lock().unwrap().push(line.to_string());
    }
}

#[derive(Clone)]
pub struct Log(Arc<dyn LogSink>);

impl Log {
    pub fn new(sink: Arc<dyn LogSink>) -> Log {
        Log(sink)
    }

    pub fn stderr() -> Log {
        Log(Arc::new(Stderr))
    }

    pub fn info(&self, line: impl AsRef<str>) {
        self.0.line(line.as_ref());
    }
}
