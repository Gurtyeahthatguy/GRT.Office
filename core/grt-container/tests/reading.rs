//! Reading archives that other programs wrote, and refusing damaged ones.

use grt_container::{read_archive, write_archive, write_zip, Entry, Item};

const TEXT: &[u8] = b"The quick brown fox jumps over the lazy dog.\n";

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

fn names(entries: &[Entry]) -> Vec<&str> {
    entries.iter().map(|e| e.name.as_str()).collect()
}

fn error(bytes: &[u8]) -> String {
    read_archive(bytes).expect_err("this archive must be refused").to_string()
}

#[test]
fn reads_every_entry_of_a_streamed_archive() {
    let entries = read_archive(&fixture("streamed.zip")).unwrap();
    assert_eq!(names(&entries), ["mimetype", "content.xml", "Pictures/empty.png"]);
    assert_eq!(entries[0].data, b"application/vnd.oasis.opendocument.text");
    assert_eq!(entries[1].data, TEXT.repeat(40));
    assert!(entries[2].data.is_empty());
}

#[test]
fn reads_a_zip64_archive() {
    let entries = read_archive(&fixture("zip64.zip")).unwrap();
    assert_eq!(names(&entries), ["big.txt", "small.txt"]);
    assert_eq!(entries[0].data, TEXT.repeat(40));
    assert_eq!(entries[1].data, b"small\n");
}

#[test]
fn reads_names_flagged_utf8() {
    let entries = read_archive(&fixture("accented.zip")).unwrap();
    assert_eq!(names(&entries), ["Città/perché.txt"]);
    assert_eq!(entries[0].data, "è così\n".as_bytes());
}

#[test]
fn a_signature_inside_the_comment_is_not_taken_for_the_end() {
    let entries = read_archive(&fixture("commented.zip")).unwrap();
    assert_eq!(names(&entries), ["a.txt"]);
}

#[test]
fn reads_unflagged_names_as_cp437_when_they_are_not_utf8() {
    let mut bytes = write_zip(&[Item { name: "x.txt", data: b"x", store: false }]).unwrap();
    for at in [30, bytes.len() - 22 - 51 + 46] {
        assert_eq!(bytes[at], b'x');
        bytes[at] = 0x82;
    }
    let entries = read_archive(&bytes).unwrap();
    assert_eq!(names(&entries), ["é.txt"]);
}

#[test]
fn every_cp437_byte_has_a_character() {
    for byte in 0x80u8..=0xFF {
        let mut bytes = write_zip(&[Item { name: "x", data: b"", store: true }]).unwrap();
        let central_name = bytes.len() - 22 - 47 + 46;
        bytes[30] = byte;
        bytes[central_name] = byte;
        let name = read_archive(&bytes).unwrap().remove(0).name;
        assert_eq!(name.chars().count(), 1, "byte {byte:#x}");
        assert_ne!(name, "?", "byte {byte:#x}");
    }
}

#[test]
fn writes_entries_in_the_order_given_and_stores_when_asked() {
    let bytes = write_zip(&[
        Item { name: "mimetype", data: b"application/vnd.oasis.opendocument.text", store: true },
        Item { name: "content.xml", data: &TEXT.repeat(40), store: false },
        Item { name: "META-INF/manifest.xml", data: b"<manifest/>", store: false },
    ])
    .unwrap();

    assert_eq!(&bytes[8..10], &[0, 0], "mimetype is compressed");
    assert_eq!(&bytes[28..30], &[0, 0], "mimetype has an extra field");
    assert_eq!(&bytes[30..38], b"mimetype");
    assert_eq!(&bytes[38..77], b"application/vnd.oasis.opendocument.text");

    let entries = read_archive(&bytes).unwrap();
    assert_eq!(names(&entries), ["mimetype", "content.xml", "META-INF/manifest.xml"]);
}

#[test]
fn flags_a_name_utf8_only_when_it_needs_it() {
    let bytes = write_zip(&[
        Item { name: "plain.txt", data: b"", store: true },
        Item { name: "Città.txt", data: b"", store: true },
    ])
    .unwrap();
    assert_eq!(u16::from_le_bytes([bytes[6], bytes[7]]), 0);
    let second = 30 + "plain.txt".len();
    assert_eq!(u16::from_le_bytes([bytes[second + 6], bytes[second + 7]]), 1 << 11);
    assert_eq!(names(&read_archive(&bytes).unwrap()), ["plain.txt", "Città.txt"]);
}

#[test]
fn refuses_to_write_a_name_twice() {
    let item = Item { name: "a", data: b"", store: true };
    assert!(write_zip(&[item, item]).is_err());
}

#[test]
fn a_cut_archive_is_refused_at_every_length() {
    let bytes = fixture("streamed.zip");
    for length in 0..bytes.len() {
        assert!(read_archive(&bytes[..length]).is_err(), "cut at {length} was accepted");
    }
}

#[test]
fn a_flipped_byte_is_never_read_as_good_data() {
    let original = write_archive(vec![
        Entry::new("a.txt", TEXT.repeat(10)),
        Entry::new("b.txt", b"short".to_vec()),
    ])
    .unwrap();
    let expected = read_archive(&original).unwrap();
    for at in 0..original.len() {
        let mut bytes = original.clone();
        bytes[at] ^= 0x55;
        if let Ok(entries) = read_archive(&bytes) {
            let data: Vec<_> = entries.iter().map(|e| &e.data).collect();
            let wanted: Vec<_> = expected.iter().map(|e| &e.data).collect();
            assert_eq!(data, wanted, "flipping byte {at} changed the data silently");
        }
    }
}

#[test]
fn a_wrong_checksum_is_refused() {
    let mut bytes = write_zip(&[Item { name: "a.txt", data: b"hello", store: true }]).unwrap();
    // The stored payload follows the 30-byte header and the name.
    bytes[30 + 5] = b'j';
    assert!(error(&bytes).contains("checksum"));
}

#[test]
fn an_encrypted_entry_is_refused_by_name() {
    let mut bytes = fixture("accented.zip");
    let central = bytes.len() - 22 - (46 + "Città/perché.txt".len());
    bytes[central + 8] |= 1;
    assert!(error(&bytes).contains("encrypted"));
}

#[test]
fn a_name_listed_twice_is_refused() {
    let mut bytes = write_zip(&[
        Item { name: "a.txt", data: b"1", store: true },
        Item { name: "b.txt", data: b"2", store: true },
    ])
    .unwrap();
    let second_central = bytes.windows(5).rposition(|w| w == b"b.txt").unwrap();
    bytes[second_central] = b'a';
    assert!(error(&bytes).contains("twice"));
}

#[test]
fn an_entry_larger_than_it_claims_is_refused() {
    let data = TEXT.repeat(40);
    let mut bytes = write_zip(&[Item { name: "a.txt", data: &data, store: false }]).unwrap();
    let central = bytes.len() - 22 - (46 + 5);
    for at in [22, central + 24] {
        let size = u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap()) / 2;
        bytes[at..at + 4].copy_from_slice(&size.to_le_bytes());
    }
    assert!(error(&bytes).contains("size"));
}

#[test]
fn something_that_is_not_an_archive_is_refused() {
    assert!(read_archive(b"").is_err());
    assert!(read_archive(b"%PDF-1.7 not a zip at all, but long enough to search").is_err());
}

#[test]
fn a_lowered_entry_count_is_refused_rather_than_dropping_entries() {
    let mut bytes = write_zip(&[
        Item { name: "a.txt", data: b"1", store: true },
        Item { name: "b.txt", data: b"2", store: true },
    ])
    .unwrap();
    let end = bytes.len() - 22;
    bytes[end + 8] = 1;
    bytes[end + 10] = 1;
    assert!(read_archive(&bytes).is_err());
}

#[test]
fn an_ole_file_is_named_for_what_it_is() {
    let mut bytes = vec![0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    bytes.resize(4096, 0);
    assert!(error(&bytes).contains("password-protected"));
}

#[test]
fn a_cut_archive_gives_back_the_entries_before_the_cut() {
    use grt_container::recover_archive;
    let bytes = fixture("streamed.zip");
    let whole = read_archive(&bytes).unwrap();
    let mut seen = 0;
    for length in 0..bytes.len() {
        let cut = &bytes[..length];
        let damage = read_archive(cut).unwrap_err();
        let Some(recovered) = recover_archive(cut, &damage) else { continue };
        // Whatever comes back is exactly the start of the archive.
        assert!(recovered.entries.len() <= whole.len());
        assert_eq!(recovered.entries[..], whole[..recovered.entries.len()], "cut at {length}");
        seen = seen.max(recovered.entries.len());
    }
    assert_eq!(seen, whole.len(), "cutting only the directory should leave every entry readable");
}

#[test]
fn recovery_stops_at_a_damaged_entry() {
    use grt_container::recover_archive;
    let mut bytes = write_zip(&[
        Item { name: "a.txt", data: b"first", store: true },
        Item { name: "b.txt", data: b"second", store: true },
    ])
    .unwrap();
    // Damage the second entry's data and remove the directory.
    let second = bytes.windows(6).position(|w| w == b"second").unwrap();
    bytes[second] = b'X';
    let end = bytes.windows(4).position(|w| w == [0x50, 0x4b, 0x01, 0x02]).unwrap();
    bytes.truncate(end);
    let damage = read_archive(&bytes).unwrap_err();
    let recovered = recover_archive(&bytes, &damage).unwrap();
    assert_eq!(names(&recovered.entries), ["a.txt"]);
}
