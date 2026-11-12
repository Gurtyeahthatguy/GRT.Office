//! Dictionaries kept compressed inside the program, opened the first time they are needed.

use std::io::Read;

/// The text of a gzip file built into the program; the size is bounded so a damaged build cannot run away.
pub fn text(bytes: &[u8]) -> Result<String, String> {
    let mut out = String::new();
    flate2::read::GzDecoder::new(bytes)
        .take(64 << 20)
        .read_to_string(&mut out)
        .map_err(|e| format!("A dictionary could not be read: {e}"))?;
    Ok(out)
}
