//! Packages as blocks of bytes, and their atomic writing.

use grt_app::package::{read_block, unpack, write_atomically, write_block, Outgoing, MAGIC};

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
    write_block(&path, &block(&entries)).unwrap();
    let back = unpack(&read_block(&path).unwrap()).unwrap();
    let names: Vec<_> = back.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["mimetype", "content.xml", "Pictures/é.png"]);
    assert_eq!(back[2].data, b"\x89PNG");
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_failed_write_leaves_the_old_file_and_no_litter() {
    let dir = scratch("failed");
    let path = dir.join("doc.odt");
    std::fs::write(&path, b"old").unwrap();
    assert!(write_block(&path, b"not a block").is_err());
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
