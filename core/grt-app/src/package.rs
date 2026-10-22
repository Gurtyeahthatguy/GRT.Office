//! Whole ZIP packages between the page and the disk, as one block of bytes.


use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use grt_container::{read_archive, recover_archive, write_zip, Item};
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

/// Reads a ZIP file into a block, entries in the archive's order, damage noted in `damage`.
pub fn read_block(path: &Path) -> io::Result<Vec<u8>> {
    let bytes = fs::read(path)?;
    let (entries, damage) = match read_archive(&bytes) {
        Ok(entries) => (entries, None),
        Err(e) => match recover_archive(&bytes, &e) {
            Some(recovered) => (recovered.entries, Some(recovered.damage)),
            None => return Err(e),
        },
    };
    let header = json!({
        "entries": entries.iter()
            .map(|entry| json!({ "name": entry.name, "size": entry.data.len() }))
            .collect::<Vec<_>>(),
        "damage": damage,
    });
    let header = serde_json::to_vec(&header).map_err(io::Error::other)?;
    let header_len = u32::try_from(header.len()).map_err(|_| invalid("too many entries"))?;

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

/// Builds the ZIP for a block and writes it atomically.
pub fn write_block(path: &Path, block: &[u8]) -> io::Result<()> {
    let entries = unpack(block)?;
    let items: Vec<Item> = entries
        .iter()
        .map(|entry| Item { name: &entry.name, data: &entry.data, store: entry.store })
        .collect();
    write_atomically(path, &write_zip(&items)?)
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
