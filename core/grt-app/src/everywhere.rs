//! Search everywhere: the words of the GRT documents in a folder, in an index kept in the program's data folder.
//! A sealed document is never read for the index; it is searched in memory once its password is given.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use grt_container::encryption::protection_of;
use grt_container::{read_archive, Entry};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::{is_ephemeral, lock, package};

/// The most documents a folder may hold, the deepest it is walked, and the most read of each.
const MAX_FILES: usize = 50_000;
const MAX_DEPTH: usize = 16;
const MAX_FILE: u64 = 256 << 20;
const MAX_TEXT: usize = 2 << 20;
/// The most sealed documents one password is tried on.
const MAX_LOCKED_TRIES: usize = 300;

/// The open index, opened on first use.
#[derive(Default)]
pub struct Everywhere(Mutex<Option<Connection>>);

pub fn file_in(data: &Path) -> PathBuf {
    data.join("search-everywhere.sqlite3")
}

pub fn open(path: Option<&Path>) -> Result<Connection, String> {
    let connection = match path {
        Some(path) => {
            if let Some(dir) = path.parent() {
                fs::create_dir_all(dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
            }
            Connection::open(path).map_err(|e| format!("Cannot open the index: {e}"))?
        }
        None => Connection::open_in_memory().map_err(|e| format!("Cannot open an index in memory: {e}"))?,
    };
    connection
        .execute_batch(
            "PRAGMA secure_delete = ON;
             CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS docs (path TEXT PRIMARY KEY, kind TEXT NOT NULL, modified INTEGER NOT NULL,
                 size INTEGER NOT NULL, locked INTEGER NOT NULL);
             CREATE VIRTUAL TABLE IF NOT EXISTS words USING fts5(path UNINDEXED, name, body,
                 tokenize = \"unicode61 remove_diacritics 2\");",
        )
        .map_err(|e| format!("Cannot prepare the index: {e}"))?;
    Ok(connection)
}

/// Keys whose strings are never words: identifiers, styles, colours and the like.
const NOT_WORDS: &[&str] = &[
    "id", "kind", "type", "style", "styles", "font", "fontFamily", "color", "colour", "fill", "stroke", "align", "shape",
    "routing", "format", "numberFormat", "nf", "lang", "theme", "layout", "media_type", "path", "src", "data", "resource",
    "ins", "del", "cmt", "chgnote", "parent", "from", "to", "anchor", "level", "border", "background",
];

/// The words of a document's JSON, in the order they come.
pub fn words_of(value: &Value, out: &mut String) {
    if out.len() >= MAX_TEXT {
        return;
    }
    match value {
        Value::String(text) => {
            let text = text.trim();
            if text.is_empty() || text.starts_with("data:") || (text.starts_with('#') && text.len() <= 9 && !text.contains(' ')) {
                return;
            }
            let room = MAX_TEXT.saturating_sub(out.len());
            let mut end = text.len().min(room);
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            out.push_str(&text[..end]);
            out.push('\n');
        }
        Value::Array(items) => items.iter().for_each(|item| words_of(item, out)),
        Value::Object(map) => {
            for (key, item) in map {
                if !NOT_WORDS.contains(&key.as_str()) {
                    words_of(item, out);
                }
            }
        }
        _ => {}
    }
}

/// The programs whose documents are told apart; any other name is not taken from a file.
const KINDS: &[&str] = &["paper", "grid", "slides", "graphs", "notes", "tables"];

/// A document's kind and words, from its parts.
pub fn read_entries(entries: &[Entry]) -> (String, String) {
    let json_of = |name: &str| entries.iter().find(|e| e.name == name).and_then(|e| serde_json::from_slice::<Value>(&e.data).ok());
    let named = |value: Option<Value>| {
        let value = value?;
        ["kind", "type"].iter().find_map(|key| value.get(key).and_then(Value::as_str).filter(|k| KINDS.contains(k)).map(str::to_string))
    };
    // The manifest names the kind; a document without one names it in its content.
    let kind = named(json_of("manifest.json")).or_else(|| named(json_of("content/main.json"))).unwrap_or_else(|| "document".to_string());
    let mut body = String::new();
    for entry in entries {
        if entry.name.starts_with("content/") && entry.name.ends_with(".json") {
            if let Ok(value) = serde_json::from_slice::<Value>(&entry.data) {
                words_of(&value, &mut body);
            }
        } else if entry.name.ends_with(".sql") {
            // A Tables database is its rows as text.
            let text = String::from_utf8_lossy(&entry.data);
            let mut end = text.len().min(MAX_TEXT.saturating_sub(body.len()));
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            body.push_str(&text[..end]);
            body.push('\n');
        }
    }
    (kind, body)
}

/// The `.grt` documents under a folder, without following links or entering hidden folders.
pub fn documents_in(folder: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![(folder.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() && depth < MAX_DEPTH {
                stack.push((entry.path(), depth + 1));
            } else if kind.is_file() && name.to_lowercase().ends_with(".grt") {
                out.push(entry.path());
                if out.len() >= MAX_FILES {
                    return out;
                }
            }
        }
    }
    out.sort();
    out
}

fn stamp(path: &Path) -> Option<(i64, i64)> {
    let meta = fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis() as i64;
    Some((modified, meta.len() as i64))
}

/// What a refresh did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Summary {
    pub documents: usize,
    pub read: usize,
    pub locked: usize,
    pub failed: usize,
}

/// Brings the index in step with a folder: new and changed documents read, gone ones forgotten.
pub fn refresh(connection: &Connection, folder: &Path) -> Result<Summary, String> {
    let err = |e: rusqlite::Error| format!("Cannot update the index: {e}");
    let folder_text = folder.to_string_lossy().to_string();
    let previous: Option<String> = connection
        .query_row("SELECT value FROM meta WHERE key = 'folder'", [], |row| row.get(0))
        .optional()
        .map_err(err)?;
    // Another folder: what was known of the last one goes.
    if previous.as_deref() != Some(folder_text.as_str()) {
        connection.execute_batch("DELETE FROM docs; DELETE FROM words;").map_err(err)?;
        connection
            .execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('folder', ?1)", params![folder_text])
            .map_err(err)?;
    }
    let found = documents_in(folder);
    let mut summary = Summary { documents: found.len(), ..Summary::default() };
    let known: std::collections::HashMap<String, (i64, i64)> = {
        let mut statement = connection.prepare("SELECT path, modified, size FROM docs").map_err(err)?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, (row.get(1)?, row.get(2)?)))).map_err(err)?;
        rows.flatten().collect()
    };
    let present: std::collections::HashSet<String> = found.iter().map(|p| p.to_string_lossy().to_string()).collect();
    connection.execute_batch("BEGIN").map_err(err)?;
    for path in known.keys().filter(|p| !present.contains(*p)) {
        connection.execute("DELETE FROM docs WHERE path = ?1", params![path]).map_err(err)?;
        connection.execute("DELETE FROM words WHERE path = ?1", params![path]).map_err(err)?;
    }
    for path in &found {
        let text = path.to_string_lossy().to_string();
        let Some((modified, size)) = stamp(path) else { continue };
        if known.get(&text) == Some(&(modified, size)) {
            let locked: bool = connection
                .query_row("SELECT locked FROM docs WHERE path = ?1", params![text], |row| row.get(0))
                .map_err(err)?;
            summary.locked += usize::from(locked);
            continue;
        }
        connection.execute("DELETE FROM words WHERE path = ?1", params![text]).map_err(err)?;
        let bytes = if size as u64 <= MAX_FILE { fs::read(path).ok() } else { None };
        let Some(bytes) = bytes else {
            summary.failed += 1;
            connection.execute("DELETE FROM docs WHERE path = ?1", params![text]).map_err(err)?;
            continue;
        };
        // A sealed document is listed as locked and nothing of it is written.
        let (kind, body, locked) = if protection_of(&bytes).is_some() {
            ("locked".to_string(), String::new(), true)
        } else {
            match read_archive(&bytes) {
                Ok(entries) => {
                    let (kind, body) = read_entries(&entries);
                    (kind, body, false)
                }
                Err(_) => {
                    summary.failed += 1;
                    connection.execute("DELETE FROM docs WHERE path = ?1", params![text]).map_err(err)?;
                    continue;
                }
            }
        };
        connection
            .execute(
                "INSERT OR REPLACE INTO docs (path, kind, modified, size, locked) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![text, kind, modified, size, locked],
            )
            .map_err(err)?;
        if locked {
            summary.locked += 1;
        } else {
            let name = path.file_stem().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            connection.execute("INSERT INTO words (path, name, body) VALUES (?1, ?2, ?3)", params![text, name, body]).map_err(err)?;
            summary.read += 1;
        }
    }
    connection.execute_batch("COMMIT").map_err(err)?;
    Ok(summary)
}

/// What a person typed, as an FTS5 query of words that must all be there, the last one as a prefix.
pub fn to_match(input: &str) -> Option<String> {
    let words: Vec<String> = input.split_whitespace().map(|w| w.replace('"', "")).filter(|w| !w.is_empty()).take(32).collect();
    let last = words.len().checked_sub(1)?;
    Some(
        words
            .iter()
            .enumerate()
            .map(|(i, w)| if i == last { format!("\"{w}\"*") } else { format!("\"{w}\"") })
            .collect::<Vec<_>>()
            .join(" AND "),
    )
}

pub fn search(connection: &Connection, query: &str, limit: i64) -> Result<Vec<Value>, String> {
    let Some(query) = to_match(query) else { return Ok(Vec::new()) };
    let err = |e: rusqlite::Error| format!("Cannot search: {e}");
    let mut statement = connection
        .prepare(
            "SELECT words.path, docs.kind, snippet(words, 2, '<<', '>>', '…', 14)
             FROM words JOIN docs ON docs.path = words.path WHERE words MATCH ?1 ORDER BY rank LIMIT ?2",
        )
        .map_err(err)?;
    let rows = statement
        .query_map(params![query, limit], |row| {
            Ok(json!({ "path": row.get::<_, String>(0)?, "kind": row.get::<_, String>(1)?, "snippet": row.get::<_, String>(2)? }))
        })
        .map_err(err)?;
    Ok(rows.flatten().collect())
}

pub fn locked(connection: &Connection) -> Result<Vec<String>, String> {
    let mut statement = connection.prepare("SELECT path FROM docs WHERE locked = 1 ORDER BY path").map_err(|e| e.to_string())?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

/// Lower case without accents, for matching words in memory as the index does.
fn fold(text: &str) -> String {
    text.chars()
        .flat_map(char::to_lowercase)
        .map(|c| match c {
            'à' | 'á' | 'â' | 'ä' | 'ã' | 'å' => 'a',
            'è' | 'é' | 'ê' | 'ë' => 'e',
            'ì' | 'í' | 'î' | 'ï' => 'i',
            'ò' | 'ó' | 'ô' | 'ö' | 'õ' => 'o',
            'ù' | 'ú' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            'ñ' => 'n',
            other => other,
        })
        .collect()
}

/// Whether text holds every word of a query, and a few words around the first.
pub fn find_in(body: &str, query: &str) -> Option<String> {
    let folded = fold(body);
    let words: Vec<String> = query.split_whitespace().map(fold).filter(|w| !w.is_empty()).collect();
    if words.is_empty() || !words.iter().all(|w| folded.contains(w.as_str())) {
        return None;
    }
    let at = folded.find(words[0].as_str()).unwrap_or(0);
    // Folding mostly keeps one char for one char; where it does not, the snippet comes from the folded text.
    let original: Vec<char> = body.chars().collect();
    let chars: Vec<char> = if folded.chars().count() == original.len() { original } else { folded.chars().collect() };
    let index = folded[..at].chars().count();
    let start = index.saturating_sub(40);
    let end = (index + words[0].chars().count() + 40).min(chars.len());
    Some(chars[start..end].iter().collect::<String>().replace('\n', " "))
}

/// Opens each sealed document the password opens and looks for the words in it; unsealing is slow, so the work is shared out.
pub fn search_locked(paths: &[String], query: &str, password: &str) -> (Vec<Value>, usize) {
    let one = |path: &String| -> Option<Option<Value>> {
        let bytes = fs::read(path).ok().filter(|b| b.len() as u64 <= MAX_FILE)?;
        let (entries, _, _) = package::open_entries(&bytes, Some(password)).ok()?;
        let (kind, body) = read_entries(&entries);
        let name = Path::new(path).file_stem().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        Some(find_in(&format!("{name}\n{body}"), query).map(|snippet| json!({ "path": path, "kind": kind, "snippet": snippet, "locked": true })))
    };
    let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).clamp(1, 8);
    let share = paths.len().div_ceil(workers).max(1);
    let results: Vec<Option<Option<Value>>> = std::thread::scope(|scope| {
        let handles: Vec<_> = paths.chunks(share).map(|chunk| scope.spawn(move || chunk.iter().map(one).collect::<Vec<_>>())).collect();
        handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
    });
    let opened = results.iter().filter(|r| r.is_some()).count();
    (results.into_iter().flatten().flatten().collect(), opened)
}

fn connection<'a, R: Runtime>(app: &AppHandle<R>, state: &'a State<'_, Everywhere>) -> Result<std::sync::MutexGuard<'a, Option<Connection>>, String> {
    let mut held = lock(&state.0);
    if held.is_none() {
        // In ephemeral mode the index lives in memory and goes with the program.
        let file = if is_ephemeral() {
            None
        } else {
            Some(file_in(&app.path().app_data_dir().map_err(|e| format!("No data directory available: {e}"))?))
        };
        *held = Some(open(file.as_deref())?);
    }
    Ok(held)
}

/// The folder searched last, if any.
#[tauri::command]
pub fn everywhere_folder<R: Runtime>(app: AppHandle<R>, state: State<'_, Everywhere>) -> Result<Option<String>, String> {
    let held = connection(&app, &state)?;
    let connection = held.as_ref().ok_or("No index")?;
    connection
        .query_row("SELECT value FROM meta WHERE key = 'folder'", [], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

/// Brings the index up to date with a folder and searches it.
#[tauri::command(async)]
pub fn everywhere_search<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Everywhere>,
    folder: String,
    query: String,
    refresh_first: bool,
) -> Result<Value, String> {
    let folder_path = Path::new(&folder);
    if !folder_path.is_dir() {
        return Err(format!("{folder} is not a folder"));
    }
    let held = connection(&app, &state)?;
    let connection = held.as_ref().ok_or("No index")?;
    let summary = if refresh_first { Some(refresh(connection, folder_path)?) } else { None };
    let hits = search(connection, &query, 200)?;
    let locked = locked(connection)?;
    Ok(json!({
        "hits": hits,
        "locked": locked,
        "summary": summary.map(|s| json!({ "documents": s.documents, "read": s.read, "locked": s.locked, "failed": s.failed })),
    }))
}

/// Searches the sealed documents of the folder with a password, in memory; nothing found is written anywhere.
#[tauri::command(async)]
pub fn everywhere_search_locked<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Everywhere>,
    query: String,
    password: String,
) -> Result<Value, String> {
    let paths = {
        let held = connection(&app, &state)?;
        locked(held.as_ref().ok_or("No index")?)?
    };
    let tried = &paths[..paths.len().min(MAX_LOCKED_TRIES)];
    let (hits, opened) = search_locked(tried, &query, &password);
    Ok(json!({ "hits": hits, "opened": opened, "tried": tried.len(), "left": paths.len() - tried.len() }))
}

/// Deletes the index and the folder it remembers.
#[tauri::command]
pub fn everywhere_forget<R: Runtime>(app: AppHandle<R>, state: State<'_, Everywhere>) -> Result<(), String> {
    *lock(&state.0) = None;
    if let Ok(dir) = app.path().app_data_dir() {
        for suffix in ["", "-journal", "-wal", "-shm"] {
            let path = PathBuf::from(format!("{}{suffix}", file_in(&dir).display()));
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("Cannot delete the index: {e}")),
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use grt_container::write_archive;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("grt-everywhere-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn document(kind: &str, content: Value) -> Vec<u8> {
        write_archive(vec![
            Entry::new("manifest.json", json!({ "kind": kind, "format_version": 1, "parts": [] }).to_string().into_bytes()),
            Entry::new("content/main.json", content.to_string().into_bytes()),
        ])
        .unwrap()
    }

    #[test]
    fn words_leave_out_ids_styles_and_colours() {
        let mut out = String::new();
        words_of(&json!({ "blocks": [{ "id": "b123", "kind": "paragraph", "style": "Heading", "runs": [{ "text": "Zebrafish results", "color": "#ff0000" }] }], "fill": "#fff", "note": "#tag here" }), &mut out);
        assert_eq!(out, "Zebrafish results\n#tag here\n");
    }

    #[test]
    fn indexes_a_folder_finds_words_and_follows_changes() {
        let dir = scratch("index");
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::create_dir_all(dir.join(".hidden")).unwrap();
        fs::write(dir.join("a.grt"), document("paper", json!({ "blocks": [{ "runs": [{ "text": "Città di Bologna" }] }] }))).unwrap();
        fs::write(dir.join("sub/b.grt"), document("grid", json!({ "cells": { "A1": { "v": "Bologna budget" } } }))).unwrap();
        fs::write(dir.join(".hidden/c.grt"), document("paper", json!({ "text": "Bologna" }))).unwrap();
        fs::write(dir.join("broken.grt"), b"not a zip").unwrap();
        let connection = open(None).unwrap();
        let summary = refresh(&connection, &dir).unwrap();
        assert_eq!(summary, Summary { documents: 3, read: 2, locked: 0, failed: 1 });
        let hits = search(&connection, "bologna", 10).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(search(&connection, "citta", 10).unwrap()[0]["kind"], "paper");
        assert_eq!(search(&connection, "bud", 10).unwrap()[0]["kind"], "grid");
        // A kind is taken from the content when no manifest names it, rows of a database are words, and an odd kind is not believed.
        let odd = |kind: &str, name: &str, data: &str| vec![Entry::new("manifest.json", json!({ "type": kind }).to_string().into_bytes()), Entry::new(name, data.as_bytes().to_vec())];
        assert_eq!(read_entries(&odd("tables", "data.sql", "INSERT INTO t VALUES ('Ferrara');")), ("tables".to_string(), "INSERT INTO t VALUES ('Ferrara');\n".to_string()));
        assert_eq!(read_entries(&odd("<script>", "x", "")).0, "document");
        assert_eq!(read_entries(&[Entry::new("content/main.json", br#"{"type":"notes","title":"T"}"#.to_vec())]), ("notes".to_string(), "T\n".to_string()));
        // A changed document is read again and a deleted one forgotten.
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(dir.join("a.grt"), document("paper", json!({ "text": "Modena" }))).unwrap();
        fs::remove_file(dir.join("sub/b.grt")).unwrap();
        refresh(&connection, &dir).unwrap();
        assert!(search(&connection, "bologna", 10).unwrap().is_empty());
        assert_eq!(search(&connection, "modena", 10).unwrap().len(), 1);
        // Another folder starts afresh.
        let other = scratch("other");
        refresh(&connection, &other).unwrap();
        assert!(search(&connection, "modena", 10).unwrap().is_empty());
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&other);
    }

    #[test]
    fn a_sealed_document_is_listed_but_none_of_it_is_indexed() {
        let dir = scratch("sealed");
        let entries = vec![
            Entry::new("manifest.json", json!({ "kind": "paper" }).to_string().into_bytes()),
            Entry::new("content/main.json", json!({ "text": "zebrafish secret" }).to_string().into_bytes()),
        ];
        fs::write(dir.join("secret.grt"), package::seal_document(entries, Some("pw")).unwrap()).unwrap();
        let file = dir.join("index.sqlite3");
        let connection = open(Some(&file)).unwrap();
        let summary = refresh(&connection, &dir).unwrap();
        assert_eq!(summary.locked, 1);
        assert!(search(&connection, "zebrafish", 10).unwrap().is_empty());
        assert_eq!(locked(&connection).unwrap().len(), 1);
        drop(connection);
        let bytes = fs::read(&file).unwrap();
        assert!(!bytes.windows(9).any(|w| w == b"zebrafish"));
        // With the password the word is found, in memory; with a wrong one nothing opens.
        let paths = vec![dir.join("secret.grt").to_string_lossy().to_string()];
        let (hits, opened) = search_locked(&paths, "zebra", "pw");
        assert_eq!((hits.len(), opened), (1, 1));
        assert_eq!(hits[0]["kind"], "paper");
        assert_eq!(search_locked(&paths, "zebra", "wrong"), (Vec::new(), 0));
        assert_eq!(search_locked(&paths, "absent", "pw"), (Vec::new(), 1));
        assert!(!fs::read(&file).unwrap().windows(9).any(|w| w == b"zebrafish"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn finds_words_in_memory_as_the_index_would() {
        assert_eq!(find_in("La Città di Bologna", "citta bol").as_deref(), Some("La Città di Bologna"));
        assert!(find_in("Bologna", "bologna modena").is_none());
        assert!(find_in("anything", "  ").is_none());
        // A letter that folds into two keeps the snippet in bounds.
        assert!(find_in("İİİİ word", "word").is_some());
        assert_eq!(to_match("a \"b"), Some("\"a\" AND \"b\"*".to_string()));
        assert_eq!(to_match("   "), None);
    }
}
