use grt_container::{write_archive, Entry, Link, Manifest, Part, README_NAME, README_TEXT};

fn main() -> std::io::Result<()> {
    let mut manifest = Manifest::new("graphs");
    manifest.parts.push(Part { path: "content/main.json".into(), media_type: "application/json".into() });
    manifest.links.push(Link::new("grt://balance.grt#cell:B12"));

    let entries = vec![
        Entry::new(README_NAME, README_TEXT.as_bytes().to_vec()),
        Entry::new("manifest.json", manifest.to_json().unwrap().into_bytes()),
        Entry::new("content/main.json", b"{\n  \"nodes\": [],\n  \"edges\": []\n}\n".to_vec()),
    ];

    std::fs::write(std::env::args().nth(1).unwrap(), write_archive(entries)?)
}
