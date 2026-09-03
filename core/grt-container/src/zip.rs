//! Deterministic ZIP writing and reading.

use std::io::{Read, Write};

use flate2::write::DeflateEncoder;
use flate2::read::DeflateDecoder;
use flate2::Compression;

use crate::README_NAME;

/// Fixed timestamp for every entry.
const DOS_TIME: u16 = 0;
const DOS_DATE: u16 = 0x0021;

/// A constant, non-informative mode.
const EXTERNAL_ATTRIBUTES: u32 = 0o100_644 << 16;

const COMPRESSION: Compression = Compression::new(6);

const SIGNATURE_LOCAL: u32 = 0x0403_4b50;
const SIGNATURE_CENTRAL: u32 = 0x0201_4b50;
const SIGNATURE_END: u32 = 0x0605_4b50;

const METHOD_STORE: u16 = 0;
const METHOD_DEFLATE: u16 = 8;

/// One file inside the archive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub data: Vec<u8>,
}

impl Entry {
    pub fn new(name: impl Into<String>, data: impl Into<Vec<u8>>) -> Self {
        Entry { name: name.into(), data: data.into() }
    }
}

/// Orders entries the way requires: the readable note first, then
/// alphabetically.
fn ordered(entries: &mut Vec<Entry>) {
    entries.sort_by(|a, b| {
        let rank = |name: &str| if name == README_NAME { 0 } else { 1 };
        rank(&a.name)
            .cmp(&rank(&b.name))
            .then_with(|| a.name.cmp(&b.name))
    });
}

fn crc32(data: &[u8]) -> u32 {
    // Table-free implementation.
    let mut crc = 0xFFFF_FFFFu32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

fn deflate(data: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut encoder = DeflateEncoder::new(Vec::new(), COMPRESSION);
    encoder.write_all(data)?;
    encoder.finish()
}

fn inflate(data: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut out = Vec::new();
    DeflateDecoder::new(data).read_to_end(&mut out)?;
    Ok(out)
}

/// Builds the archive bytes.
pub fn write_archive(mut entries: Vec<Entry>) -> std::io::Result<Vec<u8>> {
    ordered(&mut entries);

    let mut out: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();
    let mut count: u16 = 0;

    for entry in &entries {
        let offset = out.len() as u32;
        let crc = crc32(&entry.data);

        let compressed = deflate(&entry.data)?;
        // Storing is used when deflating would make the entry larger, which
        // happens with tiny or already-compressed files.
        let (method, payload) = if compressed.len() < entry.data.len() {
            (METHOD_DEFLATE, compressed)
        } else {
            (METHOD_STORE, entry.data.clone())
        };

        let name = entry.name.as_bytes();

        out.extend_from_slice(&SIGNATURE_LOCAL.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());          // version needed.
        out.extend_from_slice(&0u16.to_le_bytes());           // flags: none.
        out.extend_from_slice(&method.to_le_bytes());
        out.extend_from_slice(&DOS_TIME.to_le_bytes());
        out.extend_from_slice(&DOS_DATE.to_le_bytes());
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        out.extend_from_slice(&(entry.data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());           // extra field: none.
        out.extend_from_slice(name);
        out.extend_from_slice(&payload);

        central.extend_from_slice(&SIGNATURE_CENTRAL.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());       // version made by.
        central.extend_from_slice(&20u16.to_le_bytes());       // version needed.
        central.extend_from_slice(&0u16.to_le_bytes());        // flags.
        central.extend_from_slice(&method.to_le_bytes());
        central.extend_from_slice(&DOS_TIME.to_le_bytes());
        central.extend_from_slice(&DOS_DATE.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        central.extend_from_slice(&(entry.data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(name.len() as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());        // extra field.
        central.extend_from_slice(&0u16.to_le_bytes());        // comment.
        central.extend_from_slice(&0u16.to_le_bytes());        // disk number.
        central.extend_from_slice(&0u16.to_le_bytes());        // internal attrs.
        central.extend_from_slice(&EXTERNAL_ATTRIBUTES.to_le_bytes());
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name);

        count += 1;
    }

    let central_offset = out.len() as u32;
    let central_size = central.len() as u32;
    out.extend_from_slice(&central);

    out.extend_from_slice(&SIGNATURE_END.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());               // this disk.
    out.extend_from_slice(&0u16.to_le_bytes());               // disk with central.
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&central_size.to_le_bytes());
    out.extend_from_slice(&central_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());               // comment length.

    Ok(out)
}

/// Reads an archive back.
pub fn read_archive(bytes: &[u8]) -> std::io::Result<Vec<Entry>> {
    let mut entries = Vec::new();
    let mut cursor = 0usize;

    let u16_at = |b: &[u8], i: usize| u16::from_le_bytes([b[i], b[i + 1]]);
    let u32_at = |b: &[u8], i: usize| u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);

    while cursor + 30 <= bytes.len() {
        if u32_at(bytes, cursor) != SIGNATURE_LOCAL {
            break;
        }

        let method = u16_at(bytes, cursor + 8);
        let compressed_size = u32_at(bytes, cursor + 18) as usize;
        let name_len = u16_at(bytes, cursor + 26) as usize;
        let extra_len = u16_at(bytes, cursor + 28) as usize;

        let name_start = cursor + 30;
        let data_start = name_start + name_len + extra_len;
        let data_end = data_start + compressed_size;

        if data_end > bytes.len() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "archive entry runs past the end of the file",
            ));
        }

        let name = String::from_utf8_lossy(&bytes[name_start..name_start + name_len]).into_owned();
        let payload = &bytes[data_start..data_end];

        let data = match method {
            METHOD_STORE => payload.to_vec(),
            METHOD_DEFLATE => inflate(payload)?,
            other => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("unsupported compression method {other}"),
                ))
            }
        };

        entries.push(Entry { name, data });
        cursor = data_end;
    }

    Ok(entries)
}
