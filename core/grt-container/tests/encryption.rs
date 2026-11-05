//! Files LibreOffice 26.2 saved with the password "grt-pass", opened and sealed again.

use std::fs;
use std::path::PathBuf;

use grt_container::encryption::{lock, protection_of, unlock, LockError, Protection};
use grt_container::{write_zip, Entry, Item};

const PASSWORD: &str = "grt-pass";

fn fixture(name: &str) -> Vec<u8> {
    fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/encrypted").join(name)).expect(name)
}

fn text_of(entries: &[Entry], part: &str) -> String {
    let entry = entries.iter().find(|entry| entry.name == part).unwrap_or_else(|| panic!("no {part}"));
    String::from_utf8_lossy(&entry.data).to_string()
}

fn zip_of(entries: &[Entry]) -> Vec<u8> {
    let items: Vec<Item> = entries
        .iter()
        .map(|entry| Item { name: &entry.name, data: &entry.data, store: entry.name == "mimetype" })
        .collect();
    write_zip(&items).unwrap()
}

#[test]
fn office_files_with_standard_encryption_open() {
    for (file, part, words) in [
        ("standard.docx", "word/document.xml", "Secret docx text"),
        ("standard.xlsx", "xl/sharedStrings.xml", "Secret xlsx text"),
        ("standard.pptx", "ppt/slides/slide1.xml", "Secret pptx text"),
    ] {
        let bytes = fixture(file);
        assert_eq!(protection_of(&bytes), Some(Protection::Office), "{file}");
        let (kind, entries) = unlock(&bytes, PASSWORD).unwrap();
        assert_eq!(kind, Protection::Office);
        assert!(text_of(&entries, part).contains(words), "{file}");
        assert_eq!(unlock(&bytes, "grt-pas"), Err(LockError::WrongPassword), "{file}");
    }
}

#[test]
fn opendocument_files_of_every_generation_open() {
    for (file, words) in [
        ("odf14.odt", "Secret odt text"),
        ("odf14.ods", "Secret ods text"),
        ("odf14.odp", "Secret odp text"),
        ("odf12.odt", "Secret odf12 text"),
        ("odf11.odt", "Secret odf11 text"),
    ] {
        let bytes = fixture(file);
        assert_eq!(protection_of(&bytes), Some(Protection::Odf), "{file}");
        let (_, entries) = unlock(&bytes, PASSWORD).unwrap();
        assert!(text_of(&entries, "content.xml").contains(words), "{file}");
        assert!(!text_of(&entries, "META-INF/manifest.xml").contains("encryption-data"), "{file}");
        assert_eq!(unlock(&bytes, "GRT-PASS"), Err(LockError::WrongPassword), "{file}");
    }
}

#[test]
fn what_is_opened_seals_again_in_its_own_kind_and_opens_the_same() {
    for (file, kind) in [("standard.docx", Protection::Office), ("odf14.ods", Protection::Odf), ("odf11.odt", Protection::Grt)] {
        let (_, entries) = unlock(&fixture(file), PASSWORD).unwrap();
        let sealed = lock(&zip_of(&entries), kind, "another one").unwrap();
        assert_eq!(protection_of(&sealed), Some(kind), "{file}");
        let (_, again) = unlock(&sealed, "another one").unwrap();
        assert_eq!(again, entries, "{file}");
    }
}

#[test]
fn a_file_in_the_clear_is_not_taken_for_a_protected_one() {
    let plain = write_zip(&[Item { name: "mimetype", data: b"application/vnd.oasis.opendocument.text", store: true }]).unwrap();
    assert_eq!(protection_of(&plain), None);
    assert_eq!(protection_of(b"not a document at all"), None);
}

#[test]
fn an_empty_password_seals_nothing() {
    assert!(lock(b"PK", Protection::Grt, "").is_err());
}
