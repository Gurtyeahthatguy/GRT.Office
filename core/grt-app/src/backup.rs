//! Encrypted backups of a folder, an archive of notes, a vault or the calendars: one file, sealed with a password,
//! restored only into an empty folder, nothing in it able to reach outside that folder.

use std::fs;
use std::path::{Component, Path, PathBuf};

use grt_container::Entry;
use serde_json::json;

use crate::package::{read_document, write_document};

const MANIFEST: &str = "backup.json";
const PREFIX: &str = "files/";
const MAX_DEPTH: usize = 64;
const MAX_FILES: usize = 90_000;
const MAX_TOTAL: u64 = 1 << 30;

/// Every file under a folder with its path from the folder; links are neither followed nor kept.
fn collect(root: &Path) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut out = Vec::new();
    let mut total = 0u64;
    walk(root, root, 0, &mut out, &mut total)?;
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

fn walk(root: &Path, folder: &Path, depth: usize, out: &mut Vec<(String, Vec<u8>)>, total: &mut u64) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Err(format!("{} is nested too deeply to back up", folder.display()));
    }
    let entries = fs::read_dir(folder).map_err(|e| format!("Cannot read {}: {e}", folder.display()))?;
    for entry in entries.flatten() {
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        let path = entry.path();
        if kind.is_dir() {
            walk(root, &path, depth + 1, out, total)?;
        } else if kind.is_file() {
            let bytes = fs::read(&path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
            *total += bytes.len() as u64;
            if out.len() >= MAX_FILES || *total > MAX_TOTAL {
                return Err("The folder is larger than a backup holds, a gigabyte in ninety thousand files: back up its parts one by one".into());
            }
            let relative = path.strip_prefix(root).map_err(|e| e.to_string())?;
            let name = relative.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/");
            out.push((name, bytes));
        }
    }
    Ok(())
}

/// A path from a backup made safe to write under a folder: plain names only, nothing absolute, nothing going up.
fn safe_relative(name: &str) -> Option<PathBuf> {
    if name.is_empty() || name.contains('\\') || name.contains('\0') {
        return None;
    }
    let path = Path::new(name);
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => out.push(part),
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

/// Seals a folder into one file; the password is needed to read it back, and no name or date is written into it.
pub fn create(source: &Path, target: &Path, password: &str) -> Result<serde_json::Value, String> {
    if password.is_empty() {
        return Err("A backup needs a password".into());
    }
    if !source.is_dir() {
        return Err(format!("{} is not a folder", source.display()));
    }
    let source = source.canonicalize().map_err(|e| e.to_string())?;
    let parent = target.parent().unwrap_or(Path::new(".")).canonicalize().map_err(|e| format!("Cannot write to {}: {e}", target.display()))?;
    if parent.starts_with(&source) {
        return Err("The backup cannot go inside the folder it copies".into());
    }
    let files = collect(&source)?;
    let size: u64 = files.iter().map(|(_, b)| b.len() as u64).sum();
    let listing: Vec<_> = files.iter().map(|(name, bytes)| json!({ "path": name, "size": bytes.len() })).collect();
    let manifest = json!({ "format": "grt-backup", "version": 1, "files": listing });
    let mut entries = vec![Entry::new(MANIFEST, manifest.to_string().into_bytes())];
    for (name, bytes) in files.iter() {
        entries.push(Entry::new(format!("{PREFIX}{name}"), bytes.clone()));
    }
    write_document(target, entries, Some(password))?;
    Ok(json!({ "files": files.len(), "size": size }))
}

/// What a backup holds, read with its password.
fn open(source: &Path, password: &str) -> Result<Vec<Entry>, String> {
    let entries = read_document(source, Some(password))?;
    let manifest = entries.iter().find(|e| e.name == MANIFEST).ok_or("This is not a GRT backup")?;
    let value: serde_json::Value = serde_json::from_slice(&manifest.data).map_err(|_| "This backup is damaged".to_string())?;
    if value["format"] != "grt-backup" {
        return Err("This is not a GRT backup".into());
    }
    Ok(entries)
}

/// Writes a backup's files into a folder that is empty or not there yet, and nowhere else.
pub fn restore(source: &Path, target: &Path, password: &str) -> Result<serde_json::Value, String> {
    let entries = open(source, password)?;
    if target.exists() {
        let mut inside = fs::read_dir(target).map_err(|e| format!("Cannot read {}: {e}", target.display()))?;
        if inside.next().is_some() {
            return Err("A backup is restored only into an empty folder, so nothing there is overwritten".into());
        }
    } else {
        fs::create_dir_all(target).map_err(|e| format!("Cannot make {}: {e}", target.display()))?;
    }
    let mut count = 0usize;
    for entry in entries.iter().filter(|e| e.name.starts_with(PREFIX)) {
        let relative = safe_relative(&entry.name[PREFIX.len()..]).ok_or_else(|| format!("This backup names a file outside its folder: {}", entry.name))?;
        let path = target.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Cannot make {}: {e}", parent.display()))?;
        }
        fs::write(&path, &entry.data).map_err(|e| format!("Cannot write {}: {e}", path.display()))?;
        count += 1;
    }
    Ok(json!({ "files": count }))
}

#[tauri::command(async)]
pub fn backup_create(source: String, target: String, password: String) -> Result<serde_json::Value, String> {
    create(Path::new(&source), Path::new(&target), &password)
}

#[tauri::command(async)]
pub fn backup_restore(source: String, target: String, password: String) -> Result<serde_json::Value, String> {
    restore(Path::new(&source), Path::new(&target), &password)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("grt-backup-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn tree(root: &Path) -> Vec<(String, Vec<u8>)> {
        collect(root).unwrap()
    }

    #[test]
    fn a_backup_restores_into_an_empty_folder_identical_and_cannot_be_read_without_its_password() {
        let dir = scratch("round");
        let source = dir.join("Archive");
        fs::create_dir_all(source.join("Notebook/.hidden")).unwrap();
        fs::write(source.join("Notebook/Nota.md"), "Ciao [[Altra]]").unwrap();
        fs::write(source.join("Notebook/.hidden/x.bin"), [0u8, 1, 2, 255]).unwrap();
        fs::write(source.join("calendar.ics"), "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/passwd", source.join("link")).unwrap();
        let file = dir.join("copy.grtbackup");
        let made = create(&source, &file, "segreta").unwrap();
        assert_eq!(made["files"], 3);
        let bytes = fs::read(&file).unwrap();
        assert!(!bytes.windows(4).any(|w| w == b"Ciao"));
        assert!(restore(&file, &dir.join("wrong"), "sbagliata").is_err());
        let back = dir.join("Restored");
        restore(&file, &back, "segreta").unwrap();
        assert_eq!(tree(&source), tree(&back));
        assert!(restore(&file, &back, "segreta").is_err());
        assert!(create(&source, &source.join("inside.grtbackup"), "segreta").is_err());
        assert!(create(&source, &dir.join("nopass.grtbackup"), "").is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn names_that_would_leave_the_folder_are_refused() {
        for bad in ["../x", "/etc/passwd", "a/../../b", "", "a\\b", "./"] {
            assert!(safe_relative(bad).is_none(), "{bad}");
        }
        assert_eq!(safe_relative("a/b.md"), Some(PathBuf::from("a/b.md")));
    }
}
