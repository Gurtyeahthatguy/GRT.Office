//! The search index ( of GRT_NOTES_DATES.md).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection};

pub struct Index(pub Mutex<Option<Connection>>);

impl Default for Index {
    fn default() -> Self {
        Index(Mutex::new(None))
    }
}

/// Opens the index, creating the schema if this is the first run.
pub fn open(path: Option<&Path>) -> Result<Connection, String> {
    let connection = match path {
        Some(path) => {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)
                    .map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;
            }
            Connection::open(path).map_err(|e| format!("Cannot open the index: {e}"))?
        }
        None => Connection::open_in_memory()
            .map_err(|e| format!("Cannot open an index in memory: {e}"))?,
    };

    // `path` and `modified` are UNINDEXED.
    connection
        .execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS notes USING fts5(
                 path UNINDEXED,
                 title,
                 tags,
                 body,
                 modified UNINDEXED,
                 tokenize = \"unicode61 remove_diacritics 2\"
             );",
        )
        .map_err(|e| format!("Cannot prepare the index: {e}"))?;

    Ok(connection)
}

/// Where the index file belongs.
pub fn path_in(data_dir: &Path) -> PathBuf {
    data_dir.join("search-index.sqlite3")
}

/// Replaces one note's entry.
pub fn upsert(
    connection: &Connection,
    path: &str,
    title: &str,
    tags: &str,
    body: &str,
    modified: i64,
) -> Result<(), String> {
    connection
        .execute("DELETE FROM notes WHERE path = ?1", params![path])
        .map_err(|e| format!("Cannot update the index: {e}"))?;
    connection
        .execute(
            "INSERT INTO notes (path, title, tags, body, modified)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![path, title, tags, body, modified],
        )
        .map_err(|e| format!("Cannot write to the index: {e}"))?;
    Ok(())
}

pub fn remove(connection: &Connection, path: &str) -> Result<(), String> {
    connection
        .execute("DELETE FROM notes WHERE path = ?1", params![path])
        .map_err(|e| format!("Cannot remove from the index: {e}"))?;
    Ok(())
}

/// What the index currently believes, so the caller can spot what changed.
pub fn state(connection: &Connection) -> Result<Vec<(String, i64)>, String> {
    let mut statement = connection
        .prepare("SELECT path, modified FROM notes")
        .map_err(|e| format!("Cannot read the index: {e}"))?;

    let rows = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
        .map_err(|e| format!("Cannot read the index: {e}"))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("Cannot read the index: {e}"))?);
    }
    Ok(out)
}

/// Turns what a person typed into something FTS5 will accept.
pub fn to_match_query(input: &str) -> Option<String> {
    let words: Vec<String> = input
        .split_whitespace()
        .map(|word| word.replace('"', ""))
        .filter(|word| !word.is_empty())
        .collect();

    if words.is_empty() {
        return None;
    }

    let last = words.len() - 1;
    let parts: Vec<String> = words
        .iter()
        .enumerate()
        .map(|(i, word)| {
            if i == last {
                format!("\"{word}\"*")
            } else {
                format!("\"{word}\"")
            }
        })
        .collect();

    Some(parts.join(" AND "))
}

pub struct Hit {
    pub path: String,
    pub title: String,
    pub tags: String,
    pub snippet: String,
}

pub fn search(connection: &Connection, query: &str, limit: i64) -> Result<Vec<Hit>, String> {
    let Some(match_query) = to_match_query(query) else {
        return Ok(Vec::new());
    };

    let mut statement = connection
        .prepare(
            "SELECT path, title, tags, snippet(notes, 3, '<<', '>>', '…', 14)
             FROM notes WHERE notes MATCH ?1 ORDER BY rank LIMIT ?2",
        )
        .map_err(|e| format!("Cannot search: {e}"))?;

    let rows = statement
        .query_map(params![match_query, limit], |row| {
            Ok(Hit {
                path: row.get(0)?,
                title: row.get(1)?,
                tags: row.get(2)?,
                snippet: row.get(3)?,
            })
        })
        .map_err(|e| format!("Cannot search: {e}"))?;

    let mut hits = Vec::new();
    for row in rows {
        hits.push(row.map_err(|e| format!("Cannot search: {e}"))?);
    }
    Ok(hits)
}

/// Every note's text, for the regular-expression search asks for.
pub fn dump(connection: &Connection) -> Result<Vec<(String, String, String)>, String> {
    let mut statement = connection
        .prepare("SELECT path, title, body FROM notes")
        .map_err(|e| format!("Cannot read the index: {e}"))?;

    let rows = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(|e| format!("Cannot read the index: {e}"))?;

    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("Cannot read the index: {e}"))?);
    }
    Ok(out)
}

pub fn clear(connection: &Connection) -> Result<(), String> {
    connection
        .execute("DELETE FROM notes", [])
        .map_err(|e| format!("Cannot clear the index: {e}"))?;
    Ok(())
}
