//! The notes of a Markdown vault and the `[[links]]` in each, for drawing their graph.

use std::fs;
use std::path::{Path, PathBuf};

const MAX_NOTES: usize = 20_000;
const MAX_DEPTH: usize = 20;
const MAX_NOTE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_LINKS: usize = 2_000;

/// One note: where it is, its title, and the titles its links name.
pub struct Note {
    pub path: PathBuf,
    pub title: String,
    pub links: Vec<String>,
}

/// The titles of every `[[link]]` and `![[embed]]` in a text, in order, without repeats: `[[Folder/Note#Part|shown]]` names Note.
pub fn links_in(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("[[") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("]]") else { break };
        let inner = &after[..end];
        rest = &after[end + 2..];
        if inner.contains('\n') || inner.contains("[[") {
            continue;
        }
        let target = inner.split('|').next().unwrap_or("").split('#').next().unwrap_or("").trim();
        let name = target.rsplit('/').next().unwrap_or("").trim_end_matches(".md").trim();
        if name.is_empty() || out.iter().any(|seen| seen.eq_ignore_ascii_case(name)) {
            continue;
        }
        out.push(name.to_string());
        if out.len() >= MAX_LINKS {
            break;
        }
    }
    out
}

/// Every Markdown note under a folder, hidden folders such as `.obsidian` and `.trash` left out, links not followed.
pub fn notes_in(root: &Path) -> Vec<Note> {
    let mut out = Vec::new();
    walk(root, 0, &mut out);
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

fn walk(folder: &Path, depth: usize, out: &mut Vec<Note>) {
    if depth > MAX_DEPTH || out.len() >= MAX_NOTES {
        return;
    }
    let Ok(entries) = fs::read_dir(folder) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        if out.len() >= MAX_NOTES {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        // The kind of the entry itself: a link to elsewhere is neither walked into nor read.
        let Ok(kind) = entry.file_type() else { continue };
        let path = entry.path();
        if kind.is_dir() {
            walk(&path, depth + 1, out);
        } else if kind.is_file() && name.to_lowercase().ends_with(".md") {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.len() > MAX_NOTE_BYTES {
                continue;
            }
            let Ok(text) = fs::read_to_string(&path) else { continue };
            let title = name[..name.len() - 3].to_string();
            out.push(Note { path, title, links: links_in(&text) });
        }
    }
}

/// The notes of a vault and their links, for Graphs to draw.
#[tauri::command(async)]
pub fn read_markdown_links(root: String) -> Result<serde_json::Value, String> {
    let root = PathBuf::from(&root);
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let notes: Vec<serde_json::Value> = notes_in(&root)
        .into_iter()
        .map(|n| serde_json::json!({ "path": n.path.to_string_lossy(), "title": n.title, "links": n.links }))
        .collect();
    Ok(serde_json::json!({ "root": root.to_string_lossy(), "notes": notes }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_are_read_as_their_note_titles_once_each() {
        let text = "See [[Alfa]], [[Folder/Beta#Part|shown]], ![[Gamma.md]] and [[alfa]] again; [[broken\nlink]] and [[]] are not links.";
        assert_eq!(links_in(text), vec!["Alfa", "Beta", "Gamma"]);
    }

    #[test]
    fn a_vault_is_walked_without_its_hidden_folders_or_links_to_elsewhere() {
        let dir = std::env::temp_dir().join(format!("grt-notes-graph-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("Sub")).unwrap();
        fs::create_dir_all(dir.join(".obsidian")).unwrap();
        fs::write(dir.join("One.md"), "[[Two]]").unwrap();
        fs::write(dir.join("Sub/Two.md"), "back to [[One]]").unwrap();
        fs::write(dir.join(".obsidian/Hidden.md"), "[[One]]").unwrap();
        fs::write(dir.join("picture.png"), [0u8; 4]).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc", dir.join("elsewhere")).unwrap();
        let notes = notes_in(&dir);
        let titles: Vec<_> = notes.iter().map(|n| n.title.as_str()).collect();
        assert_eq!(titles, vec!["One", "Two"]);
        assert_eq!(notes[0].links, vec!["Two"]);
        fs::remove_dir_all(&dir).unwrap();
    }
}
