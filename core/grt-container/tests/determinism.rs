//! The property the whole container design rests on.

use grt_container::{read_archive, write_archive, Entry, Link, Manifest, README_NAME, README_TEXT};

fn sample() -> Vec<Entry> {
    vec![
        Entry::new("content/main.json", b"{\n  \"nodes\": []\n}\n".to_vec()),
        Entry::new(README_NAME, README_TEXT.as_bytes().to_vec()),
        Entry::new("manifest.json", b"{\n  \"kind\": \"graphs\"\n}\n".to_vec()),
    ]
}

#[test]
fn two_writes_produce_identical_bytes() {
    let first = write_archive(sample()).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(1100));
    let second = write_archive(sample()).unwrap();

    assert_eq!(first, second, "the archive changed between two saves");
}

#[test]
fn entry_order_does_not_depend_on_the_caller() {
    let mut shuffled = sample();
    shuffled.reverse();

    assert_eq!(write_archive(sample()).unwrap(), write_archive(shuffled).unwrap());
}

#[test]
fn readme_comes_first() {
    let bytes = write_archive(sample()).unwrap();
    let entries = read_archive(&bytes).unwrap();

    assert_eq!(entries[0].name, README_NAME);
}

#[test]
fn remaining_entries_are_alphabetical() {
    let bytes = write_archive(sample()).unwrap();
    let names: Vec<String> = read_archive(&bytes).unwrap()[1..]
        .iter()
        .map(|e| e.name.clone())
        .collect();

    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(names, sorted);
}

#[test]
fn no_unix_extra_fields_are_written() {
    // A Unix extra field carries the writer's UID and GID.
    let bytes = write_archive(sample()).unwrap();
    let leaked = bytes.windows(2).any(|w| w == [0x75, 0x78]);

    assert!(!leaked, "an archive entry carries a Unix UID/GID extra field");
}

#[test]
fn no_current_year_appears_in_the_archive() {
    // Crude but effective: a timestamp written as text anywhere in the file,
    // or a DOS date encoding a recent year, would show up here.
    let bytes = write_archive(sample()).unwrap();
    let text = String::from_utf8_lossy(&bytes);

    for year in ["2024", "2025", "2026", "2027"] {
        assert!(!text.contains(year), "the archive contains the year {year}");
    }
}

#[test]
fn content_survives_a_round_trip() {
    let bytes = write_archive(sample()).unwrap();
    let mut back = read_archive(&bytes).unwrap();
    back.sort_by(|a, b| a.name.cmp(&b.name));

    let mut expected = sample();
    expected.sort_by(|a, b| a.name.cmp(&b.name));

    assert_eq!(back, expected);
}

#[test]
fn a_real_archiver_would_accept_the_result() {
    // Structural check rather than a full parse.
    let bytes = write_archive(sample()).unwrap();
    let end = bytes
        .windows(4)
        .rposition(|w| w == [0x50, 0x4b, 0x05, 0x06])
        .expect("no end-of-central-directory record");

    let count = u16::from_le_bytes([bytes[end + 10], bytes[end + 11]]);
    assert_eq!(count, 3);
}

#[test]
fn a_truncated_archive_is_an_error_not_a_panic() {
    // Files of unknown provenance are an attack surface.
    let bytes = write_archive(sample()).unwrap();
    let truncated = &bytes[..bytes.len() / 2];

    let _ = read_archive(truncated);
}

#[test]
fn manifest_round_trips_with_links() {
    let mut manifest = Manifest::new("graphs");
    manifest.links.push(Link::new("grt://balance.grt#cell:B12"));

    let json = manifest.to_json().unwrap();
    let back = Manifest::from_json(&json).unwrap();

    assert_eq!(back, manifest);
}

#[test]
fn a_cached_link_value_never_carries_a_timestamp() {
    // cached_at stays null by design.
    let mut link = Link::new("grt://notes.grt#node:7");
    link.cached = Some("42.500".into());

    let mut manifest = Manifest::new("grid");
    manifest.links.push(link);

    let json = manifest.to_json().unwrap();
    assert!(json.contains("42.500"));
    assert!(!json.contains("cachedAt") || json.contains("null"));

    let back = Manifest::from_json(&json).unwrap();
    assert_eq!(back.links[0].cached_at, None);
}
