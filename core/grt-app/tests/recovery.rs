use std::fs;
use std::path::PathBuf;

use grt_app::recovery::{self, valid_extension, valid_id};

/// A fresh, empty folder for one test.
fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("grt-app-test-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    dir
}

fn names(dir: &PathBuf) -> Vec<String> {
    let mut found: Vec<String> = fs::read_dir(dir)
        .map(|entries| entries.filter_map(|e| e.ok()?.file_name().into_string().ok()).collect())
        .unwrap_or_default();
    found.sort();
    found
}

#[test]
fn ids_and_extensions_are_strictly_checked() {
    assert!(valid_id("0123456789abcdef"));
    assert!(!valid_id("0123456789ABCDEF"));
    assert!(!valid_id("../../etc/passwd"));
    assert!(!valid_id("0123456789abcde"));
    assert!(valid_extension("grt"));
    assert!(!valid_extension("grt/x"));
    assert!(!valid_extension(""));
    assert!(!valid_extension("toolongext"));
}

#[test]
fn a_slot_takes_a_lock_and_names_its_copy() {
    let dir = scratch("begin");
    let slot = recovery::begin(&dir, "grt").unwrap();
    assert!(valid_id(&slot.id));
    assert_eq!(slot.data, dir.join(format!("{}.grt", slot.id)));
    assert_eq!(names(&dir), vec![format!("{}.lock", slot.id)]);
    recovery::release(slot).unwrap();
}

#[test]
fn a_running_program_s_copy_is_not_an_orphan() {
    let dir = scratch("alive");
    let slot = recovery::begin(&dir, "grt").unwrap();
    fs::write(&slot.data, b"work").unwrap();
    assert!(recovery::orphans(&dir, None).unwrap().is_empty());
    recovery::release(slot).unwrap();
}

#[test]
fn a_program_that_dies_leaves_an_orphan_with_its_meta() {
    let dir = scratch("died");
    let slot = recovery::begin(&dir, "grt").unwrap();
    fs::write(&slot.data, b"work").unwrap();
    recovery::note(&slot, &serde_json::json!({ "path": "/home/a/letter.grt", "name": "letter.grt" })).unwrap();
    let id = slot.id.clone();
    let data = slot.data.clone();
    drop(slot);

    let found = recovery::orphans(&dir, None).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].id, id);
    assert_eq!(found[0].data, data);
    assert_eq!(found[0].meta["path"], "/home/a/letter.grt");

    recovery::remove(&dir, &id, None).unwrap();
    assert!(!dir.exists());
}

#[test]
fn after_the_lock_goes_the_copy_is_an_orphan_with_its_meta() {
    let dir = scratch("crashed");
    fs::create_dir_all(&dir).unwrap();
    let id = "00000000000000aa";
    fs::write(dir.join(format!("{id}.grt")), b"work").unwrap();
    fs::write(dir.join(format!("{id}.lock")), b"").unwrap();
    fs::write(dir.join(format!("{id}.meta.json")), br#"{"path":null,"name":"Untitled"}"#).unwrap();

    let found = recovery::orphans(&dir, None).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].id, id);
    assert_eq!(found[0].data, dir.join(format!("{id}.grt")));
    assert_eq!(found[0].meta["name"], "Untitled");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_copy_without_meta_or_lock_is_still_offered() {
    let dir = scratch("bare");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("00000000000000bb.json"), b"{}").unwrap();
    let found = recovery::orphans(&dir, None).unwrap();
    assert_eq!(found.len(), 1);
    assert!(found[0].meta.as_object().unwrap().is_empty());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn stray_files_are_ignored() {
    let dir = scratch("stray");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("notes.txt"), b"x").unwrap();
    fs::write(dir.join(".grt-write-1-0"), b"x").unwrap();
    fs::write(dir.join("00000000000000cc.lock"), b"").unwrap();
    fs::write(dir.join("00000000000000cc.meta.json"), b"{}").unwrap();
    fs::write(dir.join("00000000000000cc.meta.tmp"), b"{}").unwrap();
    assert!(recovery::orphans(&dir, None).unwrap().is_empty());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn the_caller_s_own_slot_is_never_an_orphan() {
    let dir = scratch("own");
    fs::create_dir_all(&dir).unwrap();
    let id = "00000000000000dd";
    fs::write(dir.join(format!("{id}.grt")), b"work").unwrap();
    assert!(recovery::orphans(&dir, Some(id)).unwrap().is_empty());
    assert!(recovery::remove(&dir, id, Some(id)).is_err());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_missing_folder_means_no_orphans() {
    let dir = scratch("absent");
    assert!(recovery::orphans(&dir, None).unwrap().is_empty());
}

#[test]
fn discarding_keeps_the_slot_but_not_the_copy() {
    let dir = scratch("discard");
    let slot = recovery::begin(&dir, "grt").unwrap();
    fs::write(&slot.data, b"work").unwrap();
    recovery::note(&slot, &serde_json::json!({ "name": "a" })).unwrap();
    recovery::discard(&slot).unwrap();
    assert_eq!(names(&dir), vec![format!("{}.lock", slot.id)]);
    recovery::discard(&slot).unwrap();
    recovery::release(slot).unwrap();
}

#[test]
fn releasing_leaves_nothing_behind_not_even_the_folder() {
    let dir = scratch("release");
    let slot = recovery::begin(&dir, "grt").unwrap();
    fs::write(&slot.data, b"work").unwrap();
    recovery::note(&slot, &serde_json::json!({ "name": "a" })).unwrap();
    recovery::release(slot).unwrap();
    assert!(!dir.exists());
}

#[test]
fn removing_an_orphan_deletes_every_file_of_it_and_nothing_else() {
    let dir = scratch("remove");
    fs::create_dir_all(&dir).unwrap();
    let id = "00000000000000ee";
    for suffix in ["grt", "lock", "meta.json", "meta.tmp"] {
        fs::write(dir.join(format!("{id}.{suffix}")), b"x").unwrap();
    }
    fs::write(dir.join("00000000000000ff.grt"), b"another").unwrap();
    recovery::remove(&dir, id, None).unwrap();
    assert_eq!(names(&dir), vec!["00000000000000ff.grt".to_string()]);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_slot_still_in_use_cannot_be_removed() {
    let dir = scratch("busy");
    let slot = recovery::begin(&dir, "grt").unwrap();
    fs::write(&slot.data, b"work").unwrap();
    assert!(recovery::remove(&dir, &slot.id, None).is_err());
    assert!(slot.data.exists());
    recovery::release(slot).unwrap();
}

#[test]
fn meta_must_be_a_small_object() {
    let dir = scratch("meta");
    let slot = recovery::begin(&dir, "grt").unwrap();
    assert!(recovery::note(&slot, &serde_json::json!("text")).is_err());
    let big = "x".repeat(70 * 1024);
    assert!(recovery::note(&slot, &serde_json::json!({ "name": big })).is_err());
    recovery::release(slot).unwrap();
}

#[test]
fn two_programs_get_two_slots() {
    let dir = scratch("two");
    let first = recovery::begin(&dir, "grt").unwrap();
    let second = recovery::begin(&dir, "grt").unwrap();
    assert_ne!(first.id, second.id);
    fs::write(&first.data, b"one").unwrap();
    fs::write(&second.data, b"two").unwrap();
    assert!(recovery::orphans(&dir, Some(&first.id)).unwrap().is_empty());
    recovery::release(first).unwrap();
    recovery::release(second).unwrap();
    assert!(!dir.exists());
}
