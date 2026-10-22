//! Deterministic ZIP writing, and strict reading.

use std::io::{self, Read, Write};

use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use flate2::{Compression, Crc};

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
const SIGNATURE_END64: u32 = 0x0606_4b50;
const SIGNATURE_LOCATOR64: u32 = 0x0706_4b50;

const METHOD_STORE: u16 = 0;
const METHOD_DEFLATE: u16 = 8;

const FLAG_ENCRYPTED: u16 = 1;
const FLAG_UTF8: u16 = 1 << 11;

const EXTRA_ZIP64: u16 = 0x0001;

/// Largest entry read into memory.
pub const MAX_ENTRY: u64 = 1 << 30;
/// Largest total read from one archive.
pub const MAX_TOTAL: u64 = 2 << 30;

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

/// An entry to write, with how to write it.
#[derive(Debug, Clone, Copy)]
pub struct Item<'a> {
    pub name: &'a str,
    pub data: &'a [u8],
    /// Never compressed, as ODF requires of its `mimetype`.
    pub store: bool,
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = Crc::new();
    crc.update(data);
    crc.sum()
}

fn deflate(data: &[u8]) -> io::Result<Vec<u8>> {
    let mut encoder = DeflateEncoder::new(Vec::new(), COMPRESSION);
    encoder.write_all(data)?;
    encoder.finish()
}

/// The `.grt` order: the readable note first, then alphabetically.
fn ordered(entries: &mut [Entry]) {
    entries.sort_by(|a, b| {
        let rank = |name: &str| if name == README_NAME { 0 } else { 1 };
        rank(&a.name).cmp(&rank(&b.name)).then_with(|| a.name.cmp(&b.name))
    });
}

/// Builds a `.grt` archive.
pub fn write_archive(mut entries: Vec<Entry>) -> io::Result<Vec<u8>> {
    ordered(&mut entries);
    let items: Vec<Item> = entries
        .iter()
        .map(|entry| Item { name: &entry.name, data: &entry.data, store: false })
        .collect();
    write_zip(&items)
}

/// Builds an archive with the entries in the order given.
pub fn write_zip(items: &[Item]) -> io::Result<Vec<u8>> {
    let too_big = || invalid("the archive is too large for a ZIP without ZIP64");
    if items.len() > usize::from(u16::MAX) {
        return Err(too_big());
    }

    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();

    for item in items {
        if item.name.is_empty() || item.name.len() > usize::from(u16::MAX) {
            return Err(invalid(format!("unusable entry name {:?}", item.name)));
        }
        if !seen.insert(item.name) {
            return Err(invalid(format!("the entry {} is given twice", item.name)));
        }

        let offset = u32::try_from(out.len()).map_err(|_| too_big())?;
        let crc = crc32(item.data);
        let size = u32::try_from(item.data.len()).map_err(|_| too_big())?;

        // Storing is used when deflating would make the entry larger, which
        // happens with tiny or already-compressed files.
        let compressed = if item.store { None } else { Some(deflate(item.data)?) };
        let (method, payload): (u16, &[u8]) = match &compressed {
            Some(bytes) if bytes.len() < item.data.len() => (METHOD_DEFLATE, bytes),
            _ => (METHOD_STORE, item.data),
        };
        let packed = u32::try_from(payload.len()).map_err(|_| too_big())?;

        let name = item.name.as_bytes();
        let flags = if item.name.is_ascii() { 0 } else { FLAG_UTF8 };

        out.extend_from_slice(&SIGNATURE_LOCAL.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed.
        out.extend_from_slice(&flags.to_le_bytes());
        out.extend_from_slice(&method.to_le_bytes());
        out.extend_from_slice(&DOS_TIME.to_le_bytes());
        out.extend_from_slice(&DOS_DATE.to_le_bytes());
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&packed.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra field: none.
        out.extend_from_slice(name);
        out.extend_from_slice(payload);

        central.extend_from_slice(&SIGNATURE_CENTRAL.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes()); // version made by.
        central.extend_from_slice(&20u16.to_le_bytes()); // version needed.
        central.extend_from_slice(&flags.to_le_bytes());
        central.extend_from_slice(&method.to_le_bytes());
        central.extend_from_slice(&DOS_TIME.to_le_bytes());
        central.extend_from_slice(&DOS_DATE.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&packed.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&(name.len() as u16).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // extra field.
        central.extend_from_slice(&0u16.to_le_bytes()); // comment.
        central.extend_from_slice(&0u16.to_le_bytes()); // disk number.
        central.extend_from_slice(&0u16.to_le_bytes()); // internal attrs.
        central.extend_from_slice(&EXTERNAL_ATTRIBUTES.to_le_bytes());
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name);
    }

    let count = items.len() as u16;
    let central_offset = u32::try_from(out.len()).map_err(|_| too_big())?;
    let central_size = u32::try_from(central.len()).map_err(|_| too_big())?;
    out.extend_from_slice(&central);

    out.extend_from_slice(&SIGNATURE_END.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // this disk.
    out.extend_from_slice(&0u16.to_le_bytes()); // disk with central.
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&central_size.to_le_bytes());
    out.extend_from_slice(&central_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // comment length.

    Ok(out)
}

/// Bounds-checked little-endian reads.
struct Bytes<'a>(&'a [u8]);

impl Bytes<'_> {
    fn slice(&self, at: u64, len: u64) -> io::Result<&[u8]> {
        let start = usize::try_from(at).map_err(|_| truncated())?;
        let len = usize::try_from(len).map_err(|_| truncated())?;
        let end = start.checked_add(len).ok_or_else(truncated)?;
        self.0.get(start..end).ok_or_else(truncated)
    }

    fn u16(&self, at: u64) -> io::Result<u16> {
        let b = self.slice(at, 2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    fn u32(&self, at: u64) -> io::Result<u32> {
        let b = self.slice(at, 4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn u64(&self, at: u64) -> io::Result<u64> {
        let b = self.slice(at, 8)?;
        Ok(u64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]))
    }
}

fn truncated() -> io::Error {
    io::Error::new(io::ErrorKind::UnexpectedEof, "the archive is cut short or damaged")
}

/// Where the central directory is and how many entries it lists.
struct Directory {
    offset: u64,
    size: u64,
    count: u64,
}

/// The signature of an OLE compound file.
const OLE: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

fn find_directory(bytes: &Bytes) -> io::Result<Directory> {
    let len = bytes.0.len();
    if bytes.0.starts_with(&OLE) {
        return Err(invalid(
            "this is not a ZIP archive but an OLE file, which is what a password-protected \
             Office document or an old .doc, .xls or .ppt is",
        ));
    }
    if len < 22 {
        return Err(invalid("this is not a ZIP archive"));
    }
    let lowest = len.saturating_sub(22 + usize::from(u16::MAX));
    let end = (lowest..=len - 22)
        .rev()
        .find(|&at| {
            bytes.0[at..at + 4] == SIGNATURE_END.to_le_bytes()
                && at + 22 + usize::from(u16::from_le_bytes([bytes.0[at + 20], bytes.0[at + 21]])) == len
        })
        .ok_or_else(|| invalid("this is not a ZIP archive, or its end is missing"))? as u64;

    if bytes.u16(end + 4)? != 0 || bytes.u16(end + 6)? != 0 {
        return Err(invalid("archives split over several files are not supported"));
    }
    if bytes.u16(end + 8)? != bytes.u16(end + 10)? {
        return Err(invalid("the archive's end record contradicts itself"));
    }
    let mut directory = Directory {
        count: u64::from(bytes.u16(end + 10)?),
        size: u64::from(bytes.u32(end + 12)?),
        offset: u64::from(bytes.u32(end + 16)?),
    };

    let needs64 = directory.count == 0xFFFF
        || directory.size == 0xFFFF_FFFF
        || directory.offset == 0xFFFF_FFFF;
    if end >= 20 && bytes.u32(end - 20)? == SIGNATURE_LOCATOR64 {
        let record = bytes.u64(end - 12)?;
        if bytes.u32(record)? != SIGNATURE_END64 || bytes.u64(record + 24)? != bytes.u64(record + 32)? {
            return Err(invalid("the ZIP64 end record is missing or damaged"));
        }
        directory = Directory {
            count: bytes.u64(record + 32)?,
            size: bytes.u64(record + 40)?,
            offset: bytes.u64(record + 48)?,
        };
    } else if needs64 {
        return Err(invalid("the ZIP64 end record is missing"));
    }
    Ok(directory)
}

/// Names flagged UTF-8, or valid UTF-8 anyway, are UTF-8; the rest are CP437.
fn decode_name(raw: &[u8], flags: u16) -> String {
    if flags & FLAG_UTF8 != 0 || raw.is_ascii() {
        return String::from_utf8_lossy(raw).into_owned();
    }
    match std::str::from_utf8(raw) {
        Ok(text) => text.to_string(),
        Err(_) => raw.iter().map(|&b| cp437(b)).collect(),
    }
}

fn cp437(byte: u8) -> char {
    const HIGH: &str = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u{a0}";
    if byte < 0x80 {
        char::from(byte)
    } else {
        HIGH.chars().nth(usize::from(byte - 0x80)).unwrap_or('?')
    }
}

/// The 64-bit values a ZIP64 extra field carries, in the order the spec gives.
fn zip64_values(extra: &[u8], wanted: usize) -> io::Result<Vec<u64>> {
    let mut at = 0;
    while at + 4 <= extra.len() {
        let id = u16::from_le_bytes([extra[at], extra[at + 1]]);
        let size = usize::from(u16::from_le_bytes([extra[at + 2], extra[at + 3]]));
        let body = extra.get(at + 4..at + 4 + size).ok_or_else(truncated)?;
        if id == EXTRA_ZIP64 {
            if body.len() < wanted * 8 {
                return Err(invalid("a ZIP64 field is too short"));
            }
            return Ok(body
                .chunks_exact(8)
                .take(wanted)
                .map(|c| u64::from_le_bytes(c.try_into().expect("eight bytes")))
                .collect());
        }
        at += 4 + size;
    }
    Err(invalid("an entry needs ZIP64 values it does not carry"))
}

fn inflate(payload: &[u8], expected: u64) -> io::Result<Vec<u8>> {
    let mut out = Vec::with_capacity(usize::try_from(expected.min(64 << 20)).unwrap_or(0));
    // One byte past the expected size is enough to know it lied.
    DeflateDecoder::new(payload).take(expected + 1).read_to_end(&mut out)?;
    Ok(out)
}

/// Reads an archive through its central directory, refusing damage and encryption.
pub fn read_archive(bytes: &[u8]) -> io::Result<Vec<Entry>> {
    let bytes = Bytes(bytes);
    let directory = find_directory(&bytes)?;
    // Each central record is at least 46 bytes.
    if directory.count.saturating_mul(46) > directory.size {
        return Err(invalid("the central directory is shorter than its entries"));
    }
    bytes.slice(directory.offset, directory.size)?;

    let mut entries = Vec::new();
    let mut names = std::collections::HashSet::new();
    let mut total: u64 = 0;
    let mut at = directory.offset;

    for _ in 0..directory.count {
        if bytes.u32(at)? != SIGNATURE_CENTRAL {
            return Err(invalid("the central directory is damaged"));
        }
        let flags = bytes.u16(at + 8)?;
        let method = bytes.u16(at + 10)?;
        let crc = bytes.u32(at + 16)?;
        let mut packed = u64::from(bytes.u32(at + 20)?);
        let mut size = u64::from(bytes.u32(at + 24)?);
        let name_len = u64::from(bytes.u16(at + 28)?);
        let extra_len = u64::from(bytes.u16(at + 30)?);
        let comment_len = u64::from(bytes.u16(at + 32)?);
        let mut local = u64::from(bytes.u32(at + 42)?);
        let name = decode_name(bytes.slice(at + 46, name_len)?, flags);
        let extra = bytes.slice(at + 46 + name_len, extra_len)?;

        let wide = [size, packed, local].iter().filter(|&&v| v == 0xFFFF_FFFF).count();
        if wide > 0 {
            let mut values = zip64_values(extra, wide)?.into_iter();
            if size == 0xFFFF_FFFF {
                size = values.next().expect("counted");
            }
            if packed == 0xFFFF_FFFF {
                packed = values.next().expect("counted");
            }
            if local == 0xFFFF_FFFF {
                local = values.next().expect("counted");
            }
        }
        at += 46 + name_len + extra_len + comment_len;

        if flags & FLAG_ENCRYPTED != 0 {
            return Err(invalid(format!("{name} is encrypted")));
        }
        if !names.insert(name.clone()) {
            return Err(invalid(format!("the archive lists {name} twice")));
        }
        if size > MAX_ENTRY {
            return Err(invalid(format!("{name} is too large to open")));
        }
        total = total.saturating_add(size);
        if total > MAX_TOTAL {
            return Err(invalid("the archive is too large to open"));
        }

        if bytes.u32(local)? != SIGNATURE_LOCAL {
            return Err(invalid(format!("{name} points at nothing")));
        }
        let local_name = u64::from(bytes.u16(local + 26)?);
        let local_extra = u64::from(bytes.u16(local + 28)?);
        let payload = bytes.slice(local + 30 + local_name + local_extra, packed)?;

        let data = match method {
            METHOD_STORE => payload.to_vec(),
            METHOD_DEFLATE => inflate(payload, size).map_err(|e| invalid(format!("{name}: {e}")))?,
            other => return Err(invalid(format!("{name} uses compression method {other}, which is not supported"))),
        };
        if data.len() as u64 != size {
            return Err(invalid(format!("{name} is not the size the archive says")));
        }
        if crc32(&data) != crc {
            return Err(invalid(format!("{name} is damaged: its checksum does not match")));
        }
        entries.push(Entry { name, data });
    }
    if at != directory.offset + directory.size {
        return Err(invalid("the central directory is not the size the archive says"));
    }
    Ok(entries)
}

/// What could be read from an archive whose directory is lost or damaged.
#[derive(Debug)]
pub struct Recovered {
    pub entries: Vec<Entry>,
    /// Why the archive could not be read whole.
    pub damage: String,
}

/// Reads entries from the start up to the first one that cannot be read whole.
pub fn recover_archive(bytes: &[u8], damage: &io::Error) -> Option<Recovered> {
    let data = Bytes(bytes);
    let mut entries = Vec::new();
    let mut names = std::collections::HashSet::new();
    let mut total: u64 = 0;
    let mut at: u64 = 0;

    while let Ok(SIGNATURE_LOCAL) = data.u32(at) {
        let Some((entry, next)) = recover_entry(&data, at) else { break };
        total = total.saturating_add(entry.data.len() as u64);
        if total > MAX_TOTAL || !names.insert(entry.name.clone()) {
            break;
        }
        entries.push(entry);
        at = next;
    }
    if entries.is_empty() {
        return None;
    }
    Some(Recovered { entries, damage: damage.to_string() })
}

fn recover_entry(data: &Bytes, at: u64) -> Option<(Entry, u64)> {
    let flags = data.u16(at + 6).ok()?;
    let method = data.u16(at + 8).ok()?;
    let mut crc = data.u32(at + 14).ok()?;
    let mut packed = u64::from(data.u32(at + 18).ok()?);
    let mut size = u64::from(data.u32(at + 22).ok()?);
    let name_len = u64::from(data.u16(at + 26).ok()?);
    let extra_len = u64::from(data.u16(at + 28).ok()?);
    if flags & FLAG_ENCRYPTED != 0 {
        return None;
    }
    let name = decode_name(data.slice(at + 30, name_len).ok()?, flags);
    let start = at + 30 + name_len + extra_len;
    let streamed = flags & (1 << 3) != 0;

    let (payload_end, contents) = match method {
        METHOD_DEFLATE if streamed => {
            let rest = data.slice(start, data.0.len() as u64 - start).ok()?;
            let mut decoder = DeflateDecoder::new(rest);
            let mut out = Vec::new();
            (&mut decoder).take(MAX_ENTRY + 1).read_to_end(&mut out).ok()?;
            if out.len() as u64 > MAX_ENTRY {
                return None;
            }
            (start + decoder.total_in(), out)
        }
        METHOD_DEFLATE => (start + packed, inflate(data.slice(start, packed).ok()?, size).ok()?),
        METHOD_STORE if !streamed => (start + packed, data.slice(start, packed).ok()?.to_vec()),
        METHOD_STORE => {
            let end = stored_end(data, start)?;
            (end, data.slice(start, end - start).ok()?.to_vec())
        }
        _ => return None,
    };

    let mut next = payload_end;
    if streamed {
        let mut descriptor = payload_end;
        if data.u32(descriptor).ok()? == 0x0807_4b50 {
            descriptor += 4;
        }
        crc = data.u32(descriptor).ok()?;
        packed = u64::from(data.u32(descriptor + 4).ok()?);
        size = u64::from(data.u32(descriptor + 8).ok()?);
        next = descriptor + 12;
        if packed != payload_end - start {
            return None;
        }
    }
    if contents.len() as u64 != size || crc32(&contents) != crc {
        return None;
    }
    Some((Entry { name, data: contents }, next))
}

fn stored_end(data: &Bytes, start: u64) -> Option<u64> {
    let bytes = data.0;
    let first = usize::try_from(start).ok()?;
    let limit = bytes.len().min(first.saturating_add(usize::try_from(MAX_ENTRY).ok()?));
    let mut crc = Crc::new();
    let mut at = first;
    while at <= limit && at + 16 <= bytes.len() {
        if bytes[at..at + 4] == 0x0807_4b50u32.to_le_bytes() {
            let stored = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().ok()?);
            let length = u32::from_le_bytes(bytes[at + 12..at + 16].try_into().ok()?);
            if stored == crc.sum() && length as usize == at - first {
                return Some(at as u64);
            }
        }
        crc.update(&bytes[at..at + 1]);
        at += 1;
    }
    None
}
