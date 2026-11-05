//! Just enough of the PDF syntax to read every object of a file and write them out again.

use std::collections::{BTreeMap, HashSet};
use std::io::Read;

use flate2::read::ZlibDecoder;


const MAX_DEPTH: usize = 100;
const MAX_SECTIONS: usize = 256;
/// The most an object or cross-reference stream may expand to.
const MAX_DECODED: u64 = 256 << 20;
/// The highest object number, as ISO 32000 limits it.
const MAX_OBJECT: u32 = 8_388_607;

/// One PDF object; numbers, names and unknown words keep the bytes they were written with.
#[derive(Debug, Clone, PartialEq)]
pub enum Obj {
    Null,
    Bool(bool),
    Number(Vec<u8>),
    Str(Vec<u8>),
    Name(Vec<u8>),
    Array(Vec<Obj>),
    Dict(Vec<(Vec<u8>, Obj)>),
    Ref(u32, u16),
    Word(Vec<u8>),
}

impl Obj {
    pub fn get(&self, key: &[u8]) -> Option<&Obj> {
        match self {
            Obj::Dict(pairs) => pairs.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn int(&self) -> Option<i64> {
        match self {
            Obj::Number(raw) => {
                let text = std::str::from_utf8(raw).ok()?;
                text.parse::<i64>().ok().or_else(|| text.parse::<f64>().ok().map(|v| v as i64))
            }
            _ => None,
        }
    }

    pub fn name(&self) -> Option<&[u8]> {
        match self {
            Obj::Name(name) => Some(name),
            _ => None,
        }
    }

    pub fn bytes(&self) -> Option<&[u8]> {
        match self {
            Obj::Str(bytes) => Some(bytes),
            _ => None,
        }
    }

    pub fn is_type(&self, wanted: &[u8]) -> bool {
        self.get(b"Type").and_then(Obj::name) == Some(wanted)
    }

    pub fn set(&mut self, key: &[u8], value: Obj) {
        if let Obj::Dict(pairs) = self {
            pairs.retain(|(k, _)| k != key);
            pairs.push((key.to_vec(), value));
        }
    }

    pub fn remove(&mut self, key: &[u8]) {
        if let Obj::Dict(pairs) = self {
            pairs.retain(|(k, _)| k != key);
        }
    }

    pub fn number(value: i64) -> Obj {
        Obj::Number(value.to_string().into_bytes())
    }
}

fn is_white(c: u8) -> bool {
    matches!(c, 0 | 9 | 10 | 12 | 13 | 32)
}

fn is_delimiter(c: u8) -> bool {
    matches!(c, b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%')
}

pub struct Lexer<'a> {
    pub bytes: &'a [u8],
    pub pos: usize,
}

impl<'a> Lexer<'a> {
    pub fn new(bytes: &'a [u8], pos: usize) -> Self {
        Lexer { bytes, pos }
    }

    fn at_end(&self) -> bool {
        self.pos >= self.bytes.len()
    }

    pub fn skip_space(&mut self) {
        while !self.at_end() {
            let c = self.bytes[self.pos];
            if is_white(c) {
                self.pos += 1;
            } else if c == b'%' {
                while !self.at_end() && !matches!(self.bytes[self.pos], b'\r' | b'\n') {
                    self.pos += 1;
                }
            } else {
                break;
            }
        }
    }

    fn starts_with(&self, word: &[u8]) -> bool {
        self.bytes[self.pos.min(self.bytes.len())..].starts_with(word)
    }

    /// The next regular word, without moving past it.
    fn peek_word(&mut self) -> &'a [u8] {
        self.skip_space();
        let start = self.pos;
        let mut end = start;
        while end < self.bytes.len() && !is_white(self.bytes[end]) && !is_delimiter(self.bytes[end]) {
            end += 1;
        }
        &self.bytes[start..end]
    }

    pub fn word(&mut self) -> &'a [u8] {
        let word = self.peek_word();
        self.pos += word.len();
        word
    }

    pub fn integer(&mut self) -> Option<i64> {
        std::str::from_utf8(self.word()).ok()?.parse().ok()
    }

    pub fn parse(&mut self) -> Result<Obj, String> {
        self.parse_at(0)
    }

    fn parse_at(&mut self, depth: usize) -> Result<Obj, String> {
        if depth > MAX_DEPTH {
            return Err("objects nested too deeply".to_string());
        }
        self.skip_space();
        let Some(&c) = self.bytes.get(self.pos) else {
            return Err("the file ends inside an object".to_string());
        };
        match c {
            b'/' => {
                self.pos += 1;
                let start = self.pos;
                while !self.at_end() && !is_white(self.bytes[self.pos]) && !is_delimiter(self.bytes[self.pos]) {
                    self.pos += 1;
                }
                Ok(Obj::Name(self.bytes[start..self.pos].to_vec()))
            }
            b'(' => Ok(Obj::Str(self.literal())),
            b'<' if self.starts_with(b"<<") => {
                self.pos += 2;
                let mut pairs = Vec::new();
                loop {
                    self.skip_space();
                    if self.at_end() {
                        return Err("a dictionary is not closed".to_string());
                    }
                    if self.starts_with(b">>") {
                        self.pos += 2;
                        break;
                    }
                    let key = self.parse_at(depth + 1)?;
                    self.skip_space();
                    let value = if self.starts_with(b">>") { Obj::Null } else { self.parse_at(depth + 1)? };
                    if let Obj::Name(key) = key {
                        pairs.push((key, value));
                    }
                }
                Ok(Obj::Dict(pairs))
            }
            b'<' => Ok(Obj::Str(self.hex())),
            b'[' => {
                self.pos += 1;
                let mut items = Vec::new();
                loop {
                    self.skip_space();
                    if self.at_end() {
                        return Err("an array is not closed".to_string());
                    }
                    if self.bytes[self.pos] == b']' {
                        self.pos += 1;
                        break;
                    }
                    items.push(self.parse_at(depth + 1)?);
                }
                Ok(Obj::Array(items))
            }
            b'0'..=b'9' | b'+' | b'-' | b'.' => {
                let raw = self.word().to_vec();
                if raw.iter().all(u8::is_ascii_digit) {
                    let back = self.pos;
                    let generation = self.peek_word();
                    if !generation.is_empty() && generation.iter().all(u8::is_ascii_digit) {
                        self.pos += generation.len();
                        if self.peek_word() == b"R" {
                            self.pos += 1;
                            let number = std::str::from_utf8(&raw).ok().and_then(|t| t.parse().ok());
                            let generation = std::str::from_utf8(generation).ok().and_then(|t| t.parse().ok());
                            if let (Some(number), Some(generation)) = (number, generation) {
                                return Ok(Obj::Ref(number, generation));
                            }
                        }
                    }
                    self.pos = back;
                }
                Ok(Obj::Number(raw))
            }
            _ if is_delimiter(c) => {
                self.pos += 1;
                Ok(Obj::Word(vec![c]))
            }
            _ => {
                let word = self.word();
                Ok(match word {
                    b"true" => Obj::Bool(true),
                    b"false" => Obj::Bool(false),
                    b"null" => Obj::Null,
                    _ => Obj::Word(word.to_vec()),
                })
            }
        }
    }

    fn literal(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        let mut depth = 0usize;
        self.pos += 1;
        while let Some(&c) = self.bytes.get(self.pos) {
            self.pos += 1;
            match c {
                b'(' => {
                    depth += 1;
                    out.push(c);
                }
                b')' if depth == 0 => break,
                b')' => {
                    depth -= 1;
                    out.push(c);
                }
                b'\\' => {
                    let Some(&e) = self.bytes.get(self.pos) else { break };
                    self.pos += 1;
                    match e {
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'0'..=b'7' => {
                            let mut value = u32::from(e - b'0');
                            for _ in 0..2 {
                                match self.bytes.get(self.pos) {
                                    Some(&d @ b'0'..=b'7') => {
                                        value = value * 8 + u32::from(d - b'0');
                                        self.pos += 1;
                                    }
                                    _ => break,
                                }
                            }
                            out.push(value as u8);
                        }
                        b'\r' => {
                            if self.bytes.get(self.pos) == Some(&b'\n') {
                                self.pos += 1;
                            }
                        }
                        b'\n' => {}
                        other => out.push(other),
                    }
                }
                _ => out.push(c),
            }
        }
        out
    }

    fn hex(&mut self) -> Vec<u8> {
        self.pos += 1;
        let mut digits = Vec::new();
        while let Some(&c) = self.bytes.get(self.pos) {
            self.pos += 1;
            if c == b'>' {
                break;
            }
            if let Some(d) = (c as char).to_digit(16) {
                digits.push(d as u8);
            }
        }
        if digits.len() % 2 == 1 {
            digits.push(0);
        }
        digits.chunks(2).map(|pair| pair[0] << 4 | pair[1]).collect()
    }
}

/// Writes an object back as PDF syntax; strings always as hexadecimal.
pub fn write_obj(obj: &Obj, out: &mut Vec<u8>) {
    match obj {
        Obj::Null => out.extend_from_slice(b"null"),
        Obj::Bool(value) => out.extend_from_slice(if *value { b"true" } else { b"false" }),
        Obj::Number(raw) | Obj::Word(raw) => out.extend_from_slice(raw),
        Obj::Str(bytes) => {
            out.push(b'<');
            for byte in bytes {
                out.extend_from_slice(format!("{byte:02X}").as_bytes());
            }
            out.push(b'>');
        }
        Obj::Name(name) => {
            out.push(b'/');
            out.extend_from_slice(name);
        }
        Obj::Array(items) => {
            out.push(b'[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(b' ');
                }
                write_obj(item, out);
            }
            out.push(b']');
        }
        Obj::Dict(pairs) => {
            out.extend_from_slice(b"<<");
            for (key, value) in pairs {
                out.push(b'/');
                out.extend_from_slice(key);
                out.push(b' ');
                write_obj(value, out);
            }
            out.extend_from_slice(b">>");
        }
        Obj::Ref(number, generation) => out.extend_from_slice(format!("{number} {generation} R").as_bytes()),
    }
}

/// An object as the file holds it: the dictionary or value, and the bytes of its stream.
#[derive(Debug, Clone, PartialEq)]
pub struct Stored {
    pub generation: u16,
    pub obj: Obj,
    pub stream: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Place {
    Free,
    At(usize),
    Inside(u32, u32),
}

/// Every object of a file, its trailer, and the objects still packed in object streams.
#[derive(Debug, Clone, PartialEq)]
pub struct Document {
    pub version: Vec<u8>,
    pub objects: BTreeMap<u32, Stored>,
    pub trailer: Obj,
    packed: BTreeMap<u32, (u32, u32)>,
}

impl Document {
    pub fn load(bytes: &[u8]) -> Result<Document, String> {
        let start = find(bytes, b"%PDF-").filter(|&at| at < 1024).ok_or("this is not a PDF file")?;
        let version_end = (start..bytes.len()).find(|&i| matches!(bytes[i], b'\r' | b'\n')).unwrap_or(bytes.len());
        let version = bytes[start..version_end.min(start + 16)].to_vec();

        let (places, trailer) = read_xref(bytes).unwrap_or_else(|| (BTreeMap::new(), Obj::Null));
        let mut scanned = None;
        let mut objects = BTreeMap::new();
        let mut packed = BTreeMap::new();
        for (&number, &place) in places.range(..=MAX_OBJECT) {
            match place {
                Place::Free => {}
                Place::Inside(stream, index) => {
                    packed.insert(number, (stream, index));
                }
                Place::At(offset) => {
                    let found = read_object(bytes, offset, number).or_else(|| {
                        let at = *scanned.get_or_insert_with(|| scan(bytes)).get(&number)?;
                        read_object(bytes, at, number)
                    });
                    if let Some(stored) = found {
                        objects.insert(number, stored);
                    }
                }
            }
        }

        let mut trailer = trailer;
        if objects.is_empty() || trailer.get(b"Root").is_none() {
            let all = scanned.get_or_insert_with(|| scan(bytes));
            objects.clear();
            packed.clear();
            for (&number, &at) in all.range(..=MAX_OBJECT) {
                if let Some(stored) = read_object(bytes, at, number) {
                    objects.insert(number, stored);
                }
            }
            trailer = scan_trailer(bytes, &objects).ok_or("the file has no trailer")?;
        }

        let mut document = Document { version, objects, trailer, packed };
        document.resolve_lengths();
        Ok(document)
    }

    /// Streams whose /Length points at another object are read again once that object is known.
    fn resolve_lengths(&mut self) {
        let lengths: Vec<(u32, Option<i64>)> = self
            .objects
            .iter()
            .filter(|(_, stored)| stored.stream.is_some())
            .map(|(&number, stored)| match stored.obj.get(b"Length") {
                Some(Obj::Ref(target, _)) => (number, self.objects.get(target).and_then(|t| t.obj.int())),
                _ => (number, None),
            })
            .collect();
        for (number, length) in lengths {
            let Some(length) = length.and_then(|l| usize::try_from(l).ok()) else { continue };
            if let Some(stored) = self.objects.get_mut(&number) {
                if let Some(stream) = &mut stored.stream {
                    if length < stream.len() {
                        stream.truncate(length);
                    }
                }
            }
        }
    }

    /// Unpacks the object streams, which must already be readable, and drops them and the cross-reference streams.
    pub fn unpack(&mut self) -> Result<(), String> {
        let mut streams: BTreeMap<u32, Vec<(u32, Obj)>> = BTreeMap::new();
        let wanted: HashSet<u32> = self.packed.values().map(|(stream, _)| *stream).collect();
        for number in wanted {
            let Some(stored) = self.objects.get(&number) else { continue };
            let data = decode(&stored.obj, stored.stream.as_deref().unwrap_or_default())?;
            let count = stored.obj.get(b"N").and_then(Obj::int).unwrap_or(0).max(0) as usize;
            let first = stored.obj.get(b"First").and_then(Obj::int).unwrap_or(0).max(0) as usize;
            let mut header = Lexer::new(&data, 0);
            let mut inside = Vec::new();
            for _ in 0..count {
                let (Some(n), Some(offset)) = (header.integer(), header.integer()) else { break };
                let Ok(n) = u32::try_from(n) else { continue };
                let mut lexer = Lexer::new(&data, first.saturating_add(offset.max(0) as usize));
                if let Ok(obj) = lexer.parse() {
                    inside.push((n, obj));
                }
            }
            streams.insert(number, inside);
        }
        for (&number, &(stream, index)) in &self.packed {
            if self.objects.contains_key(&number) {
                continue;
            }
            let found = streams.get(&stream).and_then(|inside| {
                inside.get(index as usize).filter(|(n, _)| *n == number).or_else(|| inside.iter().find(|(n, _)| *n == number))
            });
            if let Some((_, obj)) = found {
                self.objects.insert(number, Stored { generation: 0, obj: obj.clone(), stream: None });
            }
        }
        self.packed.clear();
        self.objects
            .retain(|_, stored| !(stored.stream.is_some() && (stored.obj.is_type(b"ObjStm") || stored.obj.is_type(b"XRef"))));
        Ok(())
    }

    /// The object a value points at, or the value itself.
    pub fn resolve<'a>(&'a self, obj: &'a Obj) -> &'a Obj {
        match obj {
            Obj::Ref(number, _) => self.objects.get(number).map_or(&Obj::Null, |stored| &stored.obj),
            other => other,
        }
    }

    /// The whole file again, every object in the open, with a classic cross-reference table.
    pub fn save(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&self.version);
        out.extend_from_slice(b"\n%\xE2\xE3\xCF\xD3\n");
        let size = self.objects.keys().next_back().map_or(1, |last| last + 1);
        let mut offsets = vec![None; size as usize];
        for (&number, stored) in &self.objects {
            offsets[number as usize] = Some((out.len(), stored.generation));
            out.extend_from_slice(format!("{number} {} obj\n", stored.generation).as_bytes());
            match &stored.stream {
                Some(data) => {
                    let mut dict = stored.obj.clone();
                    dict.set(b"Length", Obj::number(data.len() as i64));
                    write_obj(&dict, &mut out);
                    out.extend_from_slice(b"\nstream\n");
                    out.extend_from_slice(data);
                    out.extend_from_slice(b"\nendstream");
                }
                None => write_obj(&stored.obj, &mut out),
            }
            out.extend_from_slice(b"\nendobj\n");
        }
        let table = out.len();
        out.extend_from_slice(format!("xref\n0 {size}\n").as_bytes());
        for offset in offsets {
            match offset {
                Some((at, generation)) => out.extend_from_slice(format!("{at:010} {generation:05} n\r\n").as_bytes()),
                None => out.extend_from_slice(b"0000000000 65535 f\r\n"),
            }
        }
        let mut trailer = Obj::Dict(Vec::new());
        trailer.set(b"Size", Obj::number(i64::from(size)));
        for key in [&b"Root"[..], b"Info", b"ID", b"Encrypt"] {
            if let Some(value) = self.trailer.get(key) {
                trailer.set(key, value.clone());
            }
        }
        out.extend_from_slice(b"trailer\n");
        write_obj(&trailer, &mut out);
        out.extend_from_slice(format!("\nstartxref\n{table}\n%%EOF\n").as_bytes());
        out
    }
}

fn find(bytes: &[u8], word: &[u8]) -> Option<usize> {
    bytes.windows(word.len()).position(|window| window == word)
}

fn rfind(bytes: &[u8], word: &[u8]) -> Option<usize> {
    bytes.windows(word.len()).rposition(|window| window == word)
}

/// Reads `number generation obj ... endobj` at an offset, with its stream if it has one.
fn read_object(bytes: &[u8], offset: usize, number: u32) -> Option<Stored> {
    let mut lexer = Lexer::new(bytes, offset);
    let found = lexer.integer()?;
    let generation = lexer.integer()?;
    if found != i64::from(number) || lexer.word() != b"obj" {
        return None;
    }
    let obj = lexer.parse().ok()?;
    let mut stream = None;
    if lexer.peek_word() == b"stream" {
        lexer.pos += 6;
        if bytes.get(lexer.pos) == Some(&b'\r') {
            lexer.pos += 1;
        }
        if bytes.get(lexer.pos) == Some(&b'\n') {
            lexer.pos += 1;
        }
        let start = lexer.pos;
        let declared = obj.get(b"Length").and_then(Obj::int).and_then(|l| usize::try_from(l).ok());
        let fits = declared.filter(|&length| {
            start.checked_add(length).is_some_and(|end| {
                end <= bytes.len() && {
                    let mut after = Lexer::new(bytes, end);
                    after.peek_word() == b"endstream"
                }
            })
        });
        let end = match fits {
            Some(length) => start + length,
            None => {
                let mut end = start + find(&bytes[start..], b"endstream")?;
                if end > start && bytes[end - 1] == b'\n' {
                    end -= 1;
                }
                if end > start && bytes[end - 1] == b'\r' {
                    end -= 1;
                }
                end
            }
        };
        stream = Some(bytes[start..end].to_vec());
    }
    Some(Stored { generation: u16::try_from(generation).ok()?, obj, stream })
}

/// Where every object starts, found by looking for `n g obj` through the whole file; the last one wins.
fn scan(bytes: &[u8]) -> BTreeMap<u32, usize> {
    let mut found = BTreeMap::new();
    let mut at = 0;
    while let Some(next) = find(&bytes[at..], b"obj") {
        let end = at + next;
        at = end + 3;
        if bytes.get(end + 3).is_some_and(|&c| !is_white(c) && !is_delimiter(c)) {
            continue;
        }
        let mut i = end;
        let mut fields = [(0usize, 0usize); 2];
        let mut ok = true;
        for field in fields.iter_mut().rev() {
            let stop = i;
            while i > 0 && is_white(bytes[i - 1]) {
                i -= 1;
            }
            if i == stop {
                ok = false;
                break;
            }
            let digits_end = i;
            while i > 0 && bytes[i - 1].is_ascii_digit() {
                i -= 1;
            }
            if i == digits_end {
                ok = false;
                break;
            }
            *field = (i, digits_end);
        }
        if !ok || (i > 0 && !is_white(bytes[i - 1]) && !is_delimiter(bytes[i - 1])) {
            continue;
        }
        let number = std::str::from_utf8(&bytes[fields[0].0..fields[0].1]).ok().and_then(|t| t.parse().ok());
        if let Some(number) = number {
            found.insert(number, fields[0].0);
        }
    }
    found
}

fn scan_trailer(bytes: &[u8], objects: &BTreeMap<u32, Stored>) -> Option<Obj> {
    let mut at = bytes.len();
    while let Some(found) = rfind(&bytes[..at], b"trailer") {
        let mut lexer = Lexer::new(bytes, found + 7);
        if let Ok(trailer @ Obj::Dict(_)) = lexer.parse() {
            if trailer.get(b"Root").is_some() {
                return Some(trailer);
            }
        }
        at = found;
    }
    objects.values().rev().find(|stored| stored.obj.is_type(b"XRef") && stored.obj.get(b"Root").is_some()).map(|stored| stored.obj.clone()).or_else(|| {
        let root = objects.iter().find(|(_, stored)| stored.obj.is_type(b"Catalog"))?;
        let mut trailer = Obj::Dict(Vec::new());
        trailer.set(b"Root", Obj::Ref(*root.0, root.1.generation));
        Some(trailer)
    })
}

/// The cross-reference sections from the last one back, newer entries first, and the newest trailer.
fn read_xref(bytes: &[u8]) -> Option<(BTreeMap<u32, Place>, Obj)> {
    let at = rfind(bytes, b"startxref")?;
    let mut lexer = Lexer::new(bytes, at + 9);
    let mut next = usize::try_from(lexer.integer()?).ok();
    let mut places = BTreeMap::new();
    let mut trailer = None;
    let mut seen = HashSet::new();
    let mut pending_streams = Vec::new();
    while let Some(offset) = next.take() {
        if !seen.insert(offset) || seen.len() > MAX_SECTIONS || offset >= bytes.len() {
            break;
        }
        let mut lexer = Lexer::new(bytes, offset);
        let section = if lexer.peek_word() == b"xref" {
            lexer.word();
            read_table(&mut lexer, &mut places)?
        } else {
            read_stream_section(bytes, offset, &mut places)?
        };
        if let Some(at) = section.get(b"XRefStm").and_then(Obj::int).and_then(|v| usize::try_from(v).ok()) {
            pending_streams.push(at);
        }
        next = section.get(b"Prev").and_then(Obj::int).and_then(|v| usize::try_from(v).ok());
        trailer.get_or_insert(section);
        for at in pending_streams.drain(..) {
            if seen.insert(at) {
                let mut extra = BTreeMap::new();
                if read_stream_section(bytes, at, &mut extra).is_some() {
                    for (number, place) in extra {
                        places.entry(number).or_insert(place);
                    }
                }
            }
        }
    }
    Some((places, trailer?))
}

fn read_table(lexer: &mut Lexer, places: &mut BTreeMap<u32, Place>) -> Option<Obj> {
    loop {
        if lexer.peek_word() == b"trailer" {
            lexer.word();
            return lexer.parse().ok();
        }
        let first = u32::try_from(lexer.integer()?).ok()?;
        let count = u32::try_from(lexer.integer()?).ok()?;
        for i in 0..count {
            let offset = lexer.integer()?;
            let _generation = lexer.integer()?;
            let kind = lexer.word();
            let place = match kind {
                b"n" => Place::At(usize::try_from(offset).ok()?),
                b"f" => Place::Free,
                _ => return None,
            };
            places.entry(first.checked_add(i)?).or_insert(place);
        }
    }
}

fn read_stream_section(bytes: &[u8], offset: usize, places: &mut BTreeMap<u32, Place>) -> Option<Obj> {
    let mut lexer = Lexer::new(bytes, offset);
    let number = u32::try_from(lexer.integer()?).ok()?;
    let stored = read_object(bytes, offset, number)?;
    if !stored.obj.is_type(b"XRef") {
        return None;
    }
    let data = decode(&stored.obj, stored.stream.as_deref()?).ok()?;
    let widths: Vec<usize> = match stored.obj.get(b"W")? {
        Obj::Array(items) => items.iter().map(|w| w.int().and_then(|v| usize::try_from(v).ok())).collect::<Option<_>>()?,
        _ => return None,
    };
    if widths.len() < 3 || widths.iter().any(|&w| w > 8) {
        return None;
    }
    let size = stored.obj.get(b"Size").and_then(Obj::int).unwrap_or(0);
    let index: Vec<i64> = match stored.obj.get(b"Index") {
        Some(Obj::Array(items)) => items.iter().filter_map(Obj::int).collect(),
        _ => vec![0, size],
    };
    let row = widths.iter().sum::<usize>();
    if row == 0 {
        return None;
    }
    let field = |bytes: &[u8]| bytes.iter().fold(0u64, |value, &b| value << 8 | u64::from(b));
    let mut rows = data.chunks_exact(row);
    for pair in index.chunks(2) {
        let [first, count] = pair else { break };
        for i in 0..(*count).max(0) {
            let Some(entry) = rows.next() else { break };
            let (a, rest) = entry.split_at(widths[0]);
            let (b, c) = rest.split_at(widths[1]);
            let kind = if widths[0] == 0 { 1 } else { field(a) };
            let place = match kind {
                0 => Place::Free,
                1 => Place::At(usize::try_from(field(b)).ok()?),
                2 => Place::Inside(u32::try_from(field(b)).ok()?, u32::try_from(field(&c[..widths[2]])).ok()?),
                _ => continue,
            };
            let Ok(number) = u32::try_from(first + i) else { continue };
            places.entry(number).or_insert(place);
        }
    }
    Some(stored.obj)
}

/// The bytes of a stream with its filters undone; only what object and cross-reference streams use.
pub fn decode(dict: &Obj, data: &[u8]) -> Result<Vec<u8>, String> {
    let filters: Vec<&[u8]> = match dict.get(b"Filter") {
        None => Vec::new(),
        Some(Obj::Name(name)) => vec![name],
        Some(Obj::Array(items)) => items.iter().filter_map(Obj::name).collect(),
        Some(_) => return Err("a stream has a filter that is not a name".to_string()),
    };
    let params = match dict.get(b"DecodeParms") {
        Some(Obj::Array(items)) => items.first().cloned(),
        other => other.cloned(),
    };
    let mut data = data.to_vec();
    for filter in filters {
        if filter != b"FlateDecode" && filter != b"Fl" {
            return Err(format!("a {} stream", String::from_utf8_lossy(filter)));
        }
        let mut out = Vec::new();
        let read = ZlibDecoder::new(&data[..]).take(MAX_DECODED + 1).read_to_end(&mut out);
        if read.is_err() && out.is_empty() {
            return Err("a compressed stream is damaged".to_string());
        }
        if out.len() as u64 > MAX_DECODED {
            return Err("a stream expands past the size GRT opens".to_string());
        }
        data = out;
    }
    if let Some(params) = params {
        let predictor = params.get(b"Predictor").and_then(Obj::int).unwrap_or(1);
        if predictor >= 10 {
            let columns = params.get(b"Columns").and_then(Obj::int).unwrap_or(1).max(1) as usize;
            let colors = params.get(b"Colors").and_then(Obj::int).unwrap_or(1).max(1) as usize;
            let bits = params.get(b"BitsPerComponent").and_then(Obj::int).unwrap_or(8).max(1) as usize;
            data = unpredict(&data, columns, colors, bits);
        } else if predictor == 2 {
            return Err("a stream with the TIFF predictor".to_string());
        }
    }
    Ok(data)
}

/// Undoes the PNG predictors, row by row.
fn unpredict(data: &[u8], columns: usize, colors: usize, bits: usize) -> Vec<u8> {
    let pixel = (colors * bits).div_ceil(8).max(1);
    let width = (colors * bits * columns).div_ceil(8);
    let mut out = Vec::with_capacity(data.len());
    let mut previous = vec![0u8; width];
    for chunk in data.chunks(width + 1) {
        let (kind, row) = (chunk[0], &chunk[1..]);
        let mut line = vec![0u8; width];
        for i in 0..row.len() {
            let left = if i >= pixel { line[i - pixel] } else { 0 };
            let up = previous[i];
            let corner = if i >= pixel { previous[i - pixel] } else { 0 };
            line[i] = match kind {
                1 => row[i].wrapping_add(left),
                2 => row[i].wrapping_add(up),
                3 => row[i].wrapping_add(((u16::from(left) + u16::from(up)) / 2) as u8),
                4 => {
                    let p = i16::from(left) + i16::from(up) - i16::from(corner);
                    let (pa, pb, pc) = ((p - i16::from(left)).abs(), (p - i16::from(up)).abs(), (p - i16::from(corner)).abs());
                    let guess = if pa <= pb && pa <= pc { left } else if pb <= pc { up } else { corner };
                    row[i].wrapping_add(guess)
                }
                _ => row[i],
            };
        }
        out.extend_from_slice(&line[..row.len()]);
        previous = line;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Obj {
        Lexer::new(text.as_bytes(), 0).parse().unwrap()
    }

    #[test]
    fn objects_read_and_write_back() {
        let obj = parse("<< /Type /Page /Kids [1 0 R 2 0 R] /N -3.5 /S (a\\(b\\)\\101\\\nc) /H <48 6 > /B true >>");
        assert_eq!(obj.get(b"Kids"), Some(&Obj::Array(vec![Obj::Ref(1, 0), Obj::Ref(2, 0)])));
        assert_eq!(obj.get(b"S").and_then(Obj::bytes), Some(&b"a(b)Ac"[..]));
        assert_eq!(obj.get(b"H").and_then(Obj::bytes), Some(&b"H`"[..]));
        let mut out = Vec::new();
        write_obj(&obj, &mut out);
        assert_eq!(parse(std::str::from_utf8(&out).unwrap()), obj);
    }

    #[test]
    fn deep_nesting_is_refused() {
        let text = "[".repeat(1000);
        assert!(Lexer::new(text.as_bytes(), 0).parse().is_err());
    }

    #[test]
    fn a_file_without_a_table_is_found_by_scanning() {
        let text = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n";
        let document = Document::load(text).unwrap();
        assert_eq!(document.objects.len(), 2);
        assert_eq!(document.trailer.get(b"Root"), Some(&Obj::Ref(1, 0)));
        let again = Document::load(&document.save()).unwrap();
        assert_eq!(again.objects, document.objects);
    }

    #[test]
    fn png_predictors_come_undone() {
        let rows = [2u8, 1, 2, 2, 1, 1];
        assert_eq!(unpredict(&rows, 2, 1, 8), vec![1, 2, 2, 3]);
    }
}
