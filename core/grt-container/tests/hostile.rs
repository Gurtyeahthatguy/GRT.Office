//! Archives made to hurt the reader: each gives an error, quickly, and nothing worse.

use std::time::{Duration, Instant};

use grt_container::{read_archive, recover_archive, write_zip, Item};

/// The offset of the first central directory record.
fn central(bytes: &[u8]) -> usize {
    bytes.windows(4).position(|w| w == [0x50, 0x4B, 0x01, 0x02]).unwrap()
}

fn quickly<T>(work: impl FnOnce() -> T) -> T {
    let start = Instant::now();
    let out = work();
    assert!(start.elapsed() < Duration::from_secs(5), "took {:?}", start.elapsed());
    out
}

#[test]
fn an_entry_that_says_it_is_huge_is_refused_before_it_is_inflated() {
    let mut bytes = write_zip(&[Item { name: "content.xml", data: b"<a/>", store: false }]).unwrap();
    let at = central(&bytes) + 24;
    bytes[at..at + 4].copy_from_slice(&0xFFFF_FFF0u32.to_le_bytes());
    let error = quickly(|| read_archive(&bytes)).unwrap_err();
    assert!(error.to_string().contains("too large"), "{error}");
}

#[test]
fn an_entry_that_inflates_past_what_it_says_is_refused() {
    let zeros = vec![0u8; 8 << 20];
    let mut bytes = write_zip(&[Item { name: "content.xml", data: &zeros, store: false }]).unwrap();
    let at = central(&bytes) + 24;
    bytes[at..at + 4].copy_from_slice(&100u32.to_le_bytes());
    assert!(quickly(|| read_archive(&bytes)).is_err());
    let damage = std::io::Error::other("test");
    let recovered = quickly(|| recover_archive(&bytes, &damage));
    assert!(recovered.is_none_or(|r| r.entries.iter().all(|e| e.data.len() <= 8 << 20)));
}

#[test]
fn names_that_climb_out_of_the_archive_are_never_written() {
    for name in ["../escape.txt", "a/../../b", "/etc/passwd", "a\\b", "./a", "a\0b"] {
        assert!(write_zip(&[Item { name, data: b"x", store: false }]).is_err(), "{name:?}");
    }
    assert!(write_zip(&[Item { name: "resources/image..png", data: b"x", store: false }]).is_ok());
}

#[test]
fn a_central_directory_that_claims_more_than_it_holds_is_refused() {
    let mut bytes = write_zip(&[Item { name: "a", data: b"x", store: false }]).unwrap();
    let end = bytes.len() - 22;
    bytes[end + 8..end + 10].copy_from_slice(&60_000u16.to_le_bytes());
    bytes[end + 10..end + 12].copy_from_slice(&60_000u16.to_le_bytes());
    assert!(quickly(|| read_archive(&bytes)).is_err());
}

#[test]
fn random_damage_never_panics() {
    let base = write_zip(&[
        Item { name: "mimetype", data: b"application/vnd.oasis.opendocument.text", store: true },
        Item { name: "content.xml", data: &b"<office:document-content>words</office:document-content>".repeat(50), store: false },
    ])
    .unwrap();
    let mut state = 0x9E37_79B9u32;
    for _ in 0..2000 {
        let mut bytes = base.clone();
        for _ in 0..4 {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            let at = state as usize % bytes.len();
            bytes[at] = (state >> 8) as u8;
        }
        let _ = read_archive(&bytes);
        let _ = grt_container::encryption::protection_of(&bytes);
        let _ = grt_container::encryption::unlock_pdf(&bytes, None);
    }
}
