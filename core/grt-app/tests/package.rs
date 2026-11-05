//! Packages as blocks of bytes, and their atomic writing.

use grt_app::package::{read_block, read_document, read_pdf, unpack, write_atomically, write_block, write_document, write_pdf, Outgoing, MAGIC, PASSWORD_NEEDED, PASSWORD_WRONG};
use grt_container::encryption::Protection;
use grt_container::Entry;

fn block(entries: &[(&str, bool, &[u8])]) -> Vec<u8> {
    let header = serde_json::json!({
        "entries": entries.iter()
            .map(|(name, store, data)| serde_json::json!({ "name": name, "store": store, "size": data.len() }))
            .collect::<Vec<_>>(),
    });
    let header = serde_json::to_vec(&header).unwrap();
    let mut out = MAGIC.to_vec();
    out.extend_from_slice(&(header.len() as u32).to_le_bytes());
    out.extend_from_slice(&header);
    for (_, _, data) in entries {
        out.extend_from_slice(data);
    }
    out
}

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("grt-app-package-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn a_block_comes_back_as_the_entries_it_carries() {
    let bytes = block(&[("mimetype", true, b"application/vnd.oasis.opendocument.text"), ("content.xml", false, b"<x/>")]);
    assert_eq!(
        unpack(&bytes).unwrap(),
        vec![
            Outgoing { name: "mimetype".into(), store: true, data: b"application/vnd.oasis.opendocument.text".to_vec() },
            Outgoing { name: "content.xml".into(), store: false, data: b"<x/>".to_vec() },
        ],
    );
}

#[test]
fn a_malformed_block_is_refused() {
    let good = block(&[("a", false, b"abc")]);
    assert!(unpack(&good[..good.len() - 1]).is_err(), "cut short");
    let mut longer = good.clone();
    longer.push(0);
    assert!(unpack(&longer).is_err(), "trailing bytes");
    assert!(unpack(b"GRTPACK0\0\0\0\0").is_err(), "wrong magic");
    assert!(unpack(&block(&[])[..11]).is_err(), "no header length");
}

#[test]
fn written_and_read_back_in_the_same_order() {
    let dir = scratch("roundtrip");
    let path = dir.join("Città.odt");
    let entries: [(&str, bool, &[u8]); 3] = [
        ("mimetype", true, b"application/vnd.oasis.opendocument.text"),
        ("content.xml", false, b"<office:document-content/>"),
        ("Pictures/é.png", false, b"\x89PNG"),
    ];
    write_block(&path, &block(&entries), None).unwrap();
    let back = unpack(&read_block(&path, None).unwrap()).unwrap();
    let names: Vec<_> = back.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["mimetype", "content.xml", "Pictures/é.png"]);
    assert_eq!(back[2].data, b"\x89PNG");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_package_sealed_on_writing_asks_for_its_password_and_opens_with_it() {
    let dir = scratch("sealed");
    let entries: [(&str, bool, &[u8]); 2] = [
        ("mimetype", true, b"application/vnd.oasis.opendocument.text"),
        ("content.xml", false, b"<office:document-content>secret words</office:document-content>"),
    ];
    for (name, kind) in [("a.odt", Protection::Odf), ("a.docx", Protection::Office)] {
        let path = dir.join(name);
        write_block(&path, &block(&entries), Some((kind, "pässwörd"))).unwrap();
        assert!(!String::from_utf8_lossy(&std::fs::read(&path).unwrap()).contains("secret words"), "{name}");
        assert_eq!(read_block(&path, None).unwrap_err(), format!("{PASSWORD_NEEDED}{}", kind.name()), "{name}");
        assert_eq!(read_block(&path, Some("passwörd")).unwrap_err(), PASSWORD_WRONG, "{name}");
        let back = unpack(&read_block(&path, Some("pässwörd")).unwrap()).unwrap();
        assert_eq!(back[1].data, entries[1].2, "{name}");
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_document_written_with_a_password_reads_back_only_with_it() {
    let dir = scratch("document");
    let path = dir.join("note.grt");
    write_document(&path, vec![Entry::new("content/main.json", b"{\"secret\":true}".to_vec())], Some("pw")).unwrap();
    assert_eq!(read_document(&path, None).unwrap_err(), format!("{PASSWORD_NEEDED}grt"));
    assert_eq!(read_document(&path, Some("PW")).unwrap_err(), PASSWORD_WRONG);
    let parts = read_document(&path, Some("pw")).unwrap();
    assert!(parts.iter().any(|entry| entry.name == "content/main.json" && entry.data == b"{\"secret\":true}"));
    assert_eq!(read_document(&path, Some("pw")).unwrap(), parts);
    write_document(&path, parts.clone(), Some("another")).unwrap();
    assert_eq!(read_document(&path, Some("pw")).unwrap_err(), PASSWORD_WRONG);
    assert_eq!(read_document(&path, Some("another")).unwrap(), parts);
    write_document(&path, parts, None).unwrap();
    assert!(read_document(&path, None).is_ok());
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_failed_write_leaves_the_old_file_and_no_litter() {
    let dir = scratch("failed");
    let path = dir.join("doc.odt");
    std::fs::write(&path, b"old").unwrap();
    assert!(write_block(&path, b"not a block", None).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"old");
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[test]
fn replacing_a_file_keeps_its_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let dir = scratch("mode");
    let path = dir.join("private.odt");
    std::fs::write(&path, b"old").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    write_atomically(&path, b"new").unwrap();
    assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(std::fs::read(&path).unwrap(), b"new");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_pdf_written_with_a_password_reads_back_only_with_it() {
    let dir = scratch("pdf");
    let path = dir.join("letter.pdf");
    let plain = b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 /Note (secret note) >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n";
    write_pdf(&path, plain, None).unwrap();
    assert_eq!(read_pdf(&path, None).unwrap(), plain);
    write_pdf(&path, plain, Some("pw")).unwrap();
    assert!(!String::from_utf8_lossy(&std::fs::read(&path).unwrap()).contains("secret note"));
    assert_eq!(read_pdf(&path, None).unwrap_err(), format!("{PASSWORD_NEEDED}pdf"));
    assert_eq!(read_pdf(&path, Some("PW")).unwrap_err(), PASSWORD_WRONG);
    assert!(String::from_utf8_lossy(&read_pdf(&path, Some("pw")).unwrap()).contains("<736563726574206E6F7465>"));
    std::fs::remove_dir_all(dir).unwrap();
}
