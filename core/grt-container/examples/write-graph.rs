//! Writes a .grt holding a small diagram, exactly as GRT Graphs would.
use grt_container::{write_archive, Entry, Manifest, Part, README_NAME, README_TEXT};

fn main() -> std::io::Result<()> {
    let mut manifest = Manifest::new("graphs");
    manifest.parts.push(Part { path: "content/main.json".into(), media_type: "application/json".into() });

    let content = r##"{
  "version": 1,
  "type": "graphs",
  "nodes": [
    { "id": "nabc123", "shape": "ellipse", "x": 40, "y": 40, "w": 160, "h": 60,
      "text": "Start", "style": "default", "data": { "line": "Hello there" } },
    { "id": "ndef456", "shape": "diamond", "x": 340, "y": 40, "w": 160, "h": 60,
      "text": "Has key?", "style": "accent", "data": { "condition": "has_key" } }
  ],
  "edges": [
    { "id": "exyz789", "from": "nabc123", "to": "ndef456", "fromPort": "auto",
      "toPort": "auto", "routing": "orthogonal", "label": "yes", "style": "arrow",
      "waypoints": [], "data": { "requires": "gold >= 10" } }
  ],
  "styles": { "default": { "fill": "#ffffff", "stroke": "#333333", "strokeWidth": 2 } },
  "meta": { "gridSize": 10, "snapToGrid": true }
}
"##;

    let entries = vec![
        Entry::new(README_NAME, README_TEXT.as_bytes().to_vec()),
        Entry::new("manifest.json", manifest.to_json().unwrap().into_bytes()),
        Entry::new("content/main.json", content.as_bytes().to_vec()),
    ];

    std::fs::write(std::env::args().nth(1).unwrap(), write_archive(entries)?)
}
