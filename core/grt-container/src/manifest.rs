//! The document manifest.

use serde::{Deserialize, Serialize};

pub const FORMAT_VERSION: u32 = 1;

/// A reference to a place in another document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Link {
    /// `grt://balance.grt#cell:B12`.
    pub target: String,

    /// The last value read, shown when the source cannot be reached.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached: Option<String>,

    /// Deliberately always null.
    #[serde(default)]
    pub cached_at: Option<String>,
}

impl Link {
    pub fn new(target: impl Into<String>) -> Self {
        Link { target: target.into(), cached: None, cached_at: None }
    }
}

/// One file inside the container, listed so a reader knows what to expect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Part {
    pub path: String,
    pub media_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    /// "graphs", "paper", "slides", "grid", "notes", "dates".
    pub kind: String,
    pub format_version: u32,
    pub parts: Vec<Part>,

    /// References into other documents, resolved only when the user asks.
    #[serde(default)]
    pub links: Vec<Link>,
}

impl Manifest {
    pub fn new(kind: impl Into<String>) -> Self {
        Manifest {
            kind: kind.into(),
            format_version: FORMAT_VERSION,
            parts: Vec::new(),
            links: Vec::new(),
        }
    }

    /// Serialised the way it is stored: indented, so it can be read by eye.
    pub fn to_json(&self) -> serde_json::Result<String> {
        let mut text = serde_json::to_string_pretty(self)?;
        text.push('\n');
        Ok(text)
    }

    pub fn from_json(text: &str) -> serde_json::Result<Self> {
        serde_json::from_str(text)
    }
}
