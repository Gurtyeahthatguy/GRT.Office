//! Earlier versions of notes, in the program's data folder: one folder per notebook and per note, named by hashes the program gives.

use std::fs;
use std::path::{Path, PathBuf};

/// How many versions a note keeps; the oldest goes first.
pub const KEEP: usize = 50;
/// The least time between two versions kept, in milliseconds; saves in between replace nothing.
pub const GAP_MS: u64 = 5 * 60 * 1000;
/// The largest version kept, in bytes.
pub const MAX_BYTES: usize = 20 * 1024 * 1024;

/// A notebook's or a note's key: 64 hex digits, so it can never name a path of its own.
fn checked(key: &str) -> Result<&str, String> {
    if key.len() == 64
        && key
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        Ok(key)
    } else {
        Err("Not a history key".to_string())
    }
}

/// A version's id: the time it was kept, in milliseconds.
fn checked_id(id: &str) -> Result<u64, String> {
    if id.is_empty() || id.len() > 20 || !id.bytes().all(|b| b.is_ascii_digit()) {
        return Err("Not a version id".to_string());
    }
    id.parse().map_err(|_| "Not a version id".to_string())
}

pub fn root_in(data: &Path) -> PathBuf {
    data.join("history")
}

pub fn notebook_dir(data: &Path, notebook: &str) -> Result<PathBuf, String> {
    Ok(root_in(data).join(checked(notebook)?))
}

pub fn note_dir(data: &Path, notebook: &str, note: &str) -> Result<PathBuf, String> {
    Ok(notebook_dir(data, notebook)?.join(checked(note)?))
}

/// The versions of a note, newest first.
pub fn list(dir: &Path) -> Vec<(u64, u64)> {
    let mut out: Vec<(u64, u64)> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let id = checked_id(name.strip_suffix(".grt")?).ok()?;
            let size = entry.metadata().ok()?.len();
            Some((id, size))
        })
        .collect();
    out.sort_by_key(|v| std::cmp::Reverse(v.0));
    out
}

/// Keeps a version unless one was kept less than the gap ago and it is not forced; returns whether it kept it.
pub fn keep(
    dir: &Path,
    now_ms: u64,
    bytes: &[u8],
    force: bool,
    write: impl Fn(&Path, &[u8]) -> Result<(), String>,
) -> Result<bool, String> {
    if bytes.len() > MAX_BYTES {
        return Ok(false);
    }
    let existing = list(dir);
    if existing
        .first()
        .is_some_and(|(newest, _)| *newest >= now_ms || (!force && now_ms - *newest < GAP_MS))
    {
        return Ok(false);
    }
    fs::create_dir_all(dir).map_err(|e| format!("Cannot create the history folder: {e}"))?;
    write(&dir.join(format!("{now_ms}.grt")), bytes)?;
    for (id, _) in list(dir).into_iter().skip(KEEP) {
        let _ = fs::remove_file(dir.join(format!("{id}.grt")));
    }
    Ok(true)
}

pub fn version_path(dir: &Path, id: &str) -> Result<PathBuf, String> {
    Ok(dir.join(format!("{}.grt", checked_id(id)?)))
}

/// Takes a folder away, and is content when it was never there.
pub fn remove(dir: &Path) -> Result<(), String> {
    match fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Cannot remove the history: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("grt-notes-history-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn plain_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
        fs::write(path, bytes).map_err(|e| e.to_string())
    }

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[test]
    fn keys_cannot_name_paths() {
        let data = Path::new("/data");
        assert!(note_dir(data, A, A).is_ok());
        assert!(note_dir(data, "..", A).is_err());
        assert!(note_dir(data, A, &format!("{}/..", &A[..61])).is_err());
        assert!(note_dir(data, &A.to_uppercase(), A).is_err());
        assert!(version_path(data, "../1").is_err());
        assert!(version_path(data, "").is_err());
        assert!(version_path(data, "123").is_ok());
    }

    #[test]
    fn keeps_one_version_per_gap_and_no_more_than_the_limit() {
        let dir = scratch("keep");
        assert!(keep(&dir, 1_000_000, b"one", false, plain_write).unwrap());
        assert!(!keep(&dir, 1_000_000 + GAP_MS - 1, b"two", false, plain_write).unwrap());
        assert!(keep(&dir, 1_000_000 + GAP_MS, b"three", false, plain_write).unwrap());
        assert_eq!(
            list(&dir).iter().map(|v| v.0).collect::<Vec<_>>(),
            vec![1_000_000 + GAP_MS, 1_000_000]
        );
        // Forced, as before a restore, it is kept however soon; never over a version of the same moment.
        assert!(keep(&dir, 1_000_000 + GAP_MS + 1, b"forced", true, plain_write).unwrap());
        assert!(!keep(&dir, 1_000_000 + GAP_MS + 1, b"again", true, plain_write).unwrap());
        for n in 2..(KEEP as u64 + 10) {
            keep(&dir, 1_000_000 + GAP_MS * n, b"x", false, plain_write).unwrap();
        }
        let kept = list(&dir);
        assert_eq!(kept.len(), KEEP);
        assert_eq!(kept[0].0, 1_000_000 + GAP_MS * (KEEP as u64 + 9));
        remove(&dir).unwrap();
        assert!(list(&dir).is_empty());
        remove(&dir).unwrap();
    }

    #[test]
    fn leaves_out_what_is_too_big_and_files_not_its_own() {
        let dir = scratch("big");
        assert!(!keep(&dir, 1, &vec![0u8; MAX_BYTES + 1], true, plain_write).unwrap());
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("notes.txt"), b"x").unwrap();
        fs::write(dir.join("12x.grt"), b"x").unwrap();
        assert!(list(&dir).is_empty());
        remove(&dir).unwrap();
    }
}
