//! Whole ZIP packages between the page and the disk, as one block of bytes.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::SystemTime;

use grt_container::encryption::{lock, protection_of, unlock, unlock_pdf, LockError, Protection};
use grt_container::{read_archive, recover_archive, write_archive, write_zip, Entry, Item};
use serde_json::{json, Value};

pub const MAGIC: &[u8; 8] = b"GRTPACK1";

/// One entry as the page sends it for writing.
#[derive(Debug, PartialEq, Eq)]
pub struct Outgoing {
    pub name: String,
    pub store: bool,
    pub data: Vec<u8>,
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

/// What the page is told when a file needs a password, followed by the kind of protection.
pub const PASSWORD_NEEDED: &str = "grt:password-needed:";
/// What the page is told when a password does not open the file.
pub const PASSWORD_WRONG: &str = "grt:password-wrong";

/// A protection error as the page reads it.
pub fn lock_message(error: LockError) -> String {
    match error {
        LockError::NeedsPassword(kind) => format!("{PASSWORD_NEEDED}{}", kind.name()),
        LockError::WrongPassword => PASSWORD_WRONG.to_string(),
        other => other.to_string(),
    }
}

/// The entries of an opened file, how it was protected, and any damage found.
pub type Opened = (Vec<Entry>, Option<Protection>, Option<String>);

/// The entries of a file, opened with the password when it is protected.
pub fn open_entries(bytes: &[u8], password: Option<&str>) -> Result<Opened, String> {
    if let Some(kind) = protection_of(bytes) {
        let password = password.filter(|p| !p.is_empty()).ok_or_else(|| lock_message(LockError::NeedsPassword(kind)))?;
        let (kind, entries) = unlock(bytes, password).map_err(lock_message)?;
        return Ok((entries, Some(kind), None));
    }
    match read_archive(bytes) {
        Ok(entries) => Ok((entries, None, None)),
        Err(e) => match recover_archive(bytes, &e) {
            Some(recovered) => Ok((recovered.entries, None, Some(recovered.damage))),
            None => Err(e.to_string()),
        },
    }
}

/// Reads a ZIP file into a block, entries in the archive's order, damage noted in `damage`.
pub fn read_block(path: &Path, password: Option<&str>) -> Result<Vec<u8>, String> {
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let (entries, protection, damage) = open_entries(&bytes, password)?;
    let header = json!({
        "entries": entries.iter()
            .map(|entry| json!({ "name": entry.name, "size": entry.data.len() }))
            .collect::<Vec<_>>(),
        "damage": damage,
        "protection": protection.map(Protection::name),
    });
    let header = serde_json::to_vec(&header).map_err(|e| e.to_string())?;
    let header_len = u32::try_from(header.len()).map_err(|_| "too many entries".to_string())?;

    let size: usize = entries.iter().map(|entry| entry.data.len()).sum();
    let mut out = Vec::with_capacity(12 + header.len() + size);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&header_len.to_le_bytes());
    out.extend_from_slice(&header);
    for entry in &entries {
        out.extend_from_slice(&entry.data);
    }
    Ok(out)
}

/// The parts of a `.grt` document, opened with the password when it is protected.
pub fn read_document(path: &Path, password: Option<&str>) -> Result<Vec<Entry>, String> {
    let stamp = stamp_of(path);
    if let (Some(stamp), Some(password)) = (&stamp, password) {
        let last = LAST_UNLOCKED.lock().map_err(|_| "The last document is unavailable".to_string())?;
        if let Some(last) = last.as_ref().filter(|last| last.path == path && &last.stamp == stamp && last.password == password) {
            return Ok(last.entries.clone());
        }
    }
    let bytes = fs::read(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    if protection_of(&bytes).is_some() {
        let (entries, _, _) = open_entries(&bytes, password)?;
        if let (Some(stamp), Some(password)) = (stamp, password) {
            let unlocked = Unlocked { path: path.to_path_buf(), stamp, password: password.to_string(), entries: entries.clone() };
            *LAST_UNLOCKED.lock().map_err(|_| "The last document is unavailable".to_string())? = Some(unlocked);
        }
        return Ok(entries);
    }
    read_archive(&bytes).map_err(|e| format!("{} is not a readable GRT document: {e}", path.display()))
}

/// The protected document opened last, so that its parts are not unsealed again one by one.
struct Unlocked {
    path: PathBuf,
    stamp: (u64, SystemTime),
    password: String,
    entries: Vec<Entry>,
}

static LAST_UNLOCKED: Mutex<Option<Unlocked>> = Mutex::new(None);

fn stamp_of(path: &Path) -> Option<(u64, SystemTime)> {
    let meta = fs::metadata(path).ok()?;
    Some((meta.len(), meta.modified().ok()?))
}

/// The bytes of a `.grt` document, sealed when a password is given.
pub fn seal_document(entries: Vec<Entry>, password: Option<&str>) -> Result<Vec<u8>, String> {
    let zip = write_archive(entries).map_err(|e| format!("Cannot build the document: {e}"))?;
    match password.filter(|p| !p.is_empty()) {
        Some(password) => lock(&zip, Protection::Grt, password).map_err(lock_message),
        None => Ok(zip),
    }
}

/// Writes a `.grt` document, sealed when a password is given.
pub fn write_document(path: &Path, entries: Vec<Entry>, password: Option<&str>) -> Result<(), String> {
    let bytes = seal_document(entries, password)?;
    write_atomically(path, &bytes).map_err(|e| format!("Cannot write {}: {e}", path.display()))
}

/// A PDF in the clear, opened with the password when it has one.
pub fn read_pdf(path: &Path, password: Option<&str>) -> Result<Vec<u8>, String> {
    let bytes = fs::read(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    match unlock_pdf(&bytes, password) {
        Ok(Some(open)) => Ok(open),
        Ok(None) => Ok(bytes),
        Err(e) => Err(lock_message(e)),
    }
}

/// Writes a PDF, sealed with AES-256 when a password is given.
pub fn write_pdf(path: &Path, bytes: &[u8], password: Option<&str>) -> Result<(), String> {
    let sealed;
    let bytes = match password.filter(|p| !p.is_empty()) {
        Some(password) => {
            sealed = lock(bytes, Protection::Pdf, password).map_err(lock_message)?;
            &sealed[..]
        }
        None => bytes,
    };
    write_atomically(path, bytes).map_err(|e| format!("Cannot write {}: {e}", path.display()))
}

/// Splits a block from the page into its entries, refusing anything malformed.
pub fn unpack(block: &[u8]) -> io::Result<Vec<Outgoing>> {
    if block.len() < 12 || &block[..8] != MAGIC {
        return Err(invalid("not a package block"));
    }
    let header_len = u32::from_le_bytes(block[8..12].try_into().expect("four bytes")) as usize;
    let header_end = 12usize.checked_add(header_len).filter(|&end| end <= block.len());
    let header_end = header_end.ok_or_else(|| invalid("the package header is cut short"))?;
    let header: Value = serde_json::from_slice(&block[12..header_end])
        .map_err(|_| invalid("the package header is not JSON"))?;
    let list = header
        .get("entries")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("the package header lists no entries"))?;

    let mut at = header_end;
    let mut out = Vec::with_capacity(list.len());
    for item in list {
        let name = item.get("name").and_then(Value::as_str).ok_or_else(|| invalid("an entry has no name"))?;
        let size = item.get("size").and_then(Value::as_u64).ok_or_else(|| invalid("an entry has no size"))?;
        let store = item.get("store").and_then(Value::as_bool).unwrap_or(false);
        let size = usize::try_from(size).map_err(|_| invalid("an entry is too large"))?;
        let end = at.checked_add(size).filter(|&end| end <= block.len());
        let end = end.ok_or_else(|| invalid("the package data is cut short"))?;
        out.push(Outgoing { name: name.to_string(), store, data: block[at..end].to_vec() });
        at = end;
    }
    if at != block.len() {
        return Err(invalid("the package data is longer than its header says"));
    }
    Ok(out)
}

/// Builds the ZIP for a block and writes it atomically, sealed when a protection is given.
pub fn write_block(path: &Path, block: &[u8], seal: Option<(Protection, &str)>) -> Result<(), String> {
    let entries = unpack(block).map_err(|e| e.to_string())?;
    let items: Vec<Item> = entries
        .iter()
        .map(|entry| Item { name: &entry.name, data: &entry.data, store: entry.store })
        .collect();
    let zip = write_zip(&items).map_err(|e| e.to_string())?;
    let bytes = match seal {
        Some((kind, password)) => lock(&zip, kind, password).map_err(lock_message)?,
        None => zip,
    };
    write_atomically(path, &bytes).map_err(|e| e.to_string())
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn temp_beside(target: &Path) -> PathBuf {
    let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let name = format!(".grt-write-{}-{n}", std::process::id());
    match target.parent() {
        Some(dir) => dir.join(name),
        None => PathBuf::from(name),
    }
}

/// Replaces a file whole or not at all, keeping its permissions.
pub fn write_atomically(target: &Path, bytes: &[u8]) -> io::Result<()> {
    let temp = temp_beside(target);
    let written = (|| {
        let mut file = fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&temp);
        return Err(e);
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(target) {
            let _ = fs::set_permissions(&temp, fs::Permissions::from_mode(meta.permissions().mode()));
        }
    }

    if let Err(e) = fs::rename(&temp, target) {
        let _ = fs::remove_file(&temp);
        return Err(e);
    }

    #[cfg(unix)]
    if let Some(dir) = target.parent() {
        if let Ok(handle) = fs::File::open(dir) {
            let _ = handle.sync_all();
        }
    }
    Ok(())
}
