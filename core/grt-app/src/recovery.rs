//! Recovery copies: one slot per running program, a data file, a meta file and a held lock.

use std::collections::hash_map::RandomState;
use std::fs::{self, File};
use std::hash::{BuildHasher, Hasher};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Largest meta file accepted.
const META_LIMIT: usize = 64 * 1024;

/// One program's slot.
#[derive(Debug)]
pub struct Slot {
    pub id: String,
    pub data: PathBuf,
    dir: PathBuf,
    lock: Option<File>,
}

/// A slot left behind by a program that is no longer running.
#[derive(Debug)]
pub struct Orphan {
    pub id: String,
    pub data: PathBuf,
    pub meta: serde_json::Value,
}

/// An id is sixteen lowercase hex digits, and nothing else reaches a path.
pub fn valid_id(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// An extension is one to eight lowercase letters.
pub fn valid_extension(extension: &str) -> bool {
    (1..=8).contains(&extension.len()) && extension.bytes().all(|b| b.is_ascii_lowercase())
}

fn fresh_id() -> String {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u32(std::process::id());
    format!("{:016x}", hasher.finish())
}

fn lock_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.lock"))
}

fn meta_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.meta.json"))
}

/// Splits a file name into its id and the rest, if it belongs to a slot.
fn parse(name: &str) -> Option<(&str, &str)> {
    let (id, rest) = name.split_once('.')?;
    valid_id(id).then_some((id, rest))
}

/// Claims a new slot in `dir`.
pub fn begin(dir: &Path, extension: &str) -> io::Result<Slot> {
    if !valid_extension(extension) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid extension"));
    }
    fs::create_dir_all(dir)?;

    loop {
        let id = fresh_id();
        let path = lock_path(dir, &id);
        let file = match File::options().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        };
        file.try_lock().map_err(|e| io::Error::other(e.to_string()))?;
        return Ok(Slot {
            data: dir.join(format!("{id}.{extension}")),
            id,
            dir: dir.to_path_buf(),
            lock: Some(file),
        });
    }
}

/// Records which document the slot holds.
pub fn note(slot: &Slot, meta: &serde_json::Value) -> io::Result<()> {
    if !meta.is_object() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "meta must be an object"));
    }
    let text = serde_json::to_vec(meta).map_err(io::Error::other)?;
    if text.len() > META_LIMIT {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "meta is too large"));
    }
    write_atomically(&meta_path(&slot.dir, &slot.id), &text)
}

/// Removes the slot's copy and its meta, keeping the slot itself.
pub fn discard(slot: &Slot) -> io::Result<()> {
    remove_quietly(&slot.data)?;
    remove_quietly(&meta_path(&slot.dir, &slot.id))
}

/// Gives the slot up entirely, leaving nothing of it on disk.
pub fn release(mut slot: Slot) -> io::Result<()> {
    discard(&slot)?;
    drop(slot.lock.take());
    remove_quietly(&lock_path(&slot.dir, &slot.id))?;
    let _ = fs::remove_dir(&slot.dir);
    Ok(())
}

/// Slots in `dir` whose program has stopped, other than `own`.
pub fn orphans(dir: &Path, own: Option<&str>) -> io::Result<Vec<Orphan>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };

    let mut found = Vec::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some((id, rest)) = parse(name) else { continue };
        if rest == "lock" || rest == "meta.json" || Some(id) == own {
            continue;
        }
        if !valid_extension(rest) || !entry.file_type()?.is_file() {
            continue;
        }
        if lock_is_held(dir, id)? {
            continue;
        }
        let meta = fs::read(meta_path(dir, id))
            .ok()
            .filter(|bytes| bytes.len() <= META_LIMIT)
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .filter(serde_json::Value::is_object)
            .unwrap_or_else(|| serde_json::json!({}));
        found.push(Orphan { id: id.to_string(), data: entry.path(), meta });
    }
    found.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(found)
}

/// Deletes an orphan, never the caller's own slot or one whose program still runs.
pub fn remove(dir: &Path, id: &str, own: Option<&str>) -> io::Result<()> {
    if !valid_id(id) || Some(id) == own {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "not an orphan"));
    }
    if lock_is_held(dir, id)? {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "still in use"));
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        if let Some(name) = name.to_str() {
            if parse(name).map(|(found, _)| found) == Some(id) {
                remove_quietly(&entry.path())?;
            }
        }
    }
    let _ = fs::remove_dir(dir);
    Ok(())
}

/// Whether a running program holds the slot's lock.
fn lock_is_held(dir: &Path, id: &str) -> io::Result<bool> {
    let file = match File::options().write(true).open(lock_path(dir, id)) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    match file.try_lock() {
        Ok(()) => Ok(false),
        Err(std::fs::TryLockError::WouldBlock) => Ok(true),
        Err(std::fs::TryLockError::Error(e)) => Err(e),
    }
}

fn remove_quietly(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

fn write_atomically(target: &Path, bytes: &[u8]) -> io::Result<()> {
    let temp = target.with_extension("tmp");
    let result = (|| {
        let mut file = File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&temp);
        return Err(e);
    }
    fs::rename(&temp, target)
}
