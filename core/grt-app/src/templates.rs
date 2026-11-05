//! The templates folder: Templates inside the user's Documents, read one level deep, its subfolders as categories.

use std::fs;
use std::path::Path;

use serde_json::{json, Value};

/// The most templates listed, so a crowded folder cannot stall the program.
const LIMIT: usize = 500;

/// The templates under `folder` whose extension is one of `extensions`, sorted by category then name.
pub fn list(folder: &Path, extensions: &[String]) -> Vec<Value> {
    let wanted: Vec<String> = extensions.iter().map(|e| e.to_ascii_lowercase()).collect();
    let mut found = Vec::new();
    collect(folder, "", &wanted, &mut found, true);
    found.sort_by(|a, b| {
        let key = |v: &Value| (v["category"].as_str().unwrap_or("").to_lowercase(), v["name"].as_str().unwrap_or("").to_lowercase());
        key(a).cmp(&key(b))
    });
    found.truncate(LIMIT);
    found
}

fn collect(folder: &Path, category: &str, wanted: &[String], found: &mut Vec<Value>, top: bool) {
    let Ok(entries) = fs::read_dir(folder) else { return };
    for entry in entries.flatten() {
        if found.len() >= LIMIT * 2 {
            return;
        }
        // Links are not followed: the folder lists only what is in it.
        let Ok(meta) = fs::symlink_metadata(entry.path()) else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        if meta.is_dir() {
            if top {
                collect(&entry.path(), &name, wanted, found, false);
            }
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        let extension = Path::new(&name).extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
        if !wanted.contains(&extension) {
            continue;
        }
        let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0);
        found.push(json!({
            "name": name,
            "path": entry.path().to_string_lossy(),
            "category": category,
            "size": meta.len(),
            "modified": modified,
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_templates_one_level_deep_without_following_links() {
        let root = std::env::temp_dir().join(format!("grt-templates-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("Letters/Deeper")).unwrap();
        fs::write(root.join("Report.OTT"), b"x").unwrap();
        fs::write(root.join("Letters/Formal.dotx"), b"x").unwrap();
        fs::write(root.join("Letters/Deeper/Hidden.ott"), b"x").unwrap();
        fs::write(root.join("Sheet.ots"), b"x").unwrap();
        fs::write(root.join(".secret.ott"), b"x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("Report.OTT"), root.join("Link.ott")).unwrap();

        let found = list(&root, &["ott".into(), "dotx".into()]);
        let names: Vec<_> = found.iter().map(|v| (v["category"].as_str().unwrap().to_string(), v["name"].as_str().unwrap().to_string())).collect();
        assert_eq!(names, vec![("".into(), "Report.OTT".into()), ("Letters".into(), "Formal.dotx".into())]);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_missing_folder_lists_nothing() {
        assert!(list(Path::new("/nonexistent/grt"), &["ott".into()]).is_empty());
    }
}
