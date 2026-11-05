//! PDF files with a password: the standard security handler, revisions 2 to 6.

mod syntax;

use aes::cipher::block_padding::NoPadding;
use aes::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use md5::{Digest, Md5};

use super::{damaged, random, LockError, Protection};
use syntax::{Document, Obj};

const PAD: [u8; 32] = [
    0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08, 0x2E, 0x2E, 0x00,
    0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
];

/// Every permission, as Acrobat writes it.
const ALL_ALLOWED: i32 = -4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Method {
    Identity,
    Rc4,
    Aes128,
    Aes256,
}

struct Handler {
    key: Vec<u8>,
    strings: Method,
    streams: Method,
    metadata: bool,
}

/// The PDF in the clear, opened with the password or with none when it only restricts editing; None when it is not protected.
pub fn unlock(bytes: &[u8], password: Option<&str>) -> Result<Option<Vec<u8>>, LockError> {
    if !bytes.windows(8).any(|window| window == b"/Encrypt") {
        return Ok(None);
    }
    let mut document = Document::load(bytes).map_err(damaged)?;
    let Some(encrypt) = document.trailer.get(b"Encrypt").cloned() else {
        return Ok(None);
    };
    let settings = document.resolve(&encrypt).clone();
    let id = first_id(&document.trailer);
    let handler = match password.filter(|p| !p.is_empty()) {
        Some(password) => Handler::open(&settings, &id, password)?,
        None => Handler::open(&settings, &id, "").map_err(|e| match e {
            LockError::WrongPassword => LockError::NeedsPassword(Protection::Pdf),
            other => other,
        })?,
    };
    let skip = match encrypt {
        Obj::Ref(number, _) => Some(number),
        _ => None,
    };
    for (&number, stored) in document.objects.iter_mut() {
        if Some(number) == skip || stored.obj.is_type(b"XRef") {
            continue;
        }
        let generation = stored.generation;
        handler.strings_in(&mut stored.obj, number, generation, false)?;
        if let Some(data) = &mut stored.stream {
            if handler.metadata || !stored.obj.is_type(b"Metadata") {
                *data = handler.crypt(handler.streams, number, generation, data, false)?;
            }
        }
    }
    if let Some(number) = skip {
        document.objects.remove(&number);
    }
    document.trailer.remove(b"Encrypt");
    document.unpack().map_err(LockError::Unsupported)?;
    Ok(Some(document.save()))
}

/// The PDF sealed with AES-256 under the password, as revision 6 of the standard handler has it.
pub fn lock(bytes: &[u8], password: &str) -> Result<Vec<u8>, LockError> {
    let mut document = Document::load(bytes).map_err(damaged)?;
    if document.trailer.get(b"Encrypt").is_some() {
        return Err(LockError::Unsupported("the PDF is protected already".to_string()));
    }
    document.unpack().map_err(LockError::Unsupported)?;
    let key = random(32)?;
    let handler = Handler { key: key.clone(), strings: Method::Aes256, streams: Method::Aes256, metadata: true };
    for (&number, stored) in document.objects.iter_mut() {
        let generation = stored.generation;
        handler.strings_in(&mut stored.obj, number, generation, true)?;
        if let Some(data) = &mut stored.stream {
            *data = handler.crypt(Method::Aes256, number, generation, data, true)?;
        }
    }

    let password = &password.as_bytes()[..password.len().min(127)];
    let user_salts = random(16)?;
    let mut user = hash6(password, &user_salts[..8], &[]);
    user.extend_from_slice(&user_salts);
    let user_key = aes_cbc(&hash6(password, &user_salts[8..], &[]), &[0; 16], &key, true)?;
    let owner_salts = random(16)?;
    let mut owner = hash6(password, &owner_salts[..8], &user);
    owner.extend_from_slice(&owner_salts);
    let owner_key = aes_cbc(&hash6(password, &owner_salts[8..], &user), &[0; 16], &key, true)?;
    let mut perms = ALL_ALLOWED.to_le_bytes().to_vec();
    perms.extend_from_slice(&[0xFF, 0xFF, 0xFF, 0xFF, b'T', b'a', b'd', b'b']);
    perms.extend_from_slice(&random(4)?);
    let perms = aes_cbc(&key, &[0; 16], &perms, true)?;

    let name = |text: &[u8]| Obj::Name(text.to_vec());
    let filter = Obj::Dict(vec![
        (b"AuthEvent".to_vec(), name(b"DocOpen")),
        (b"CFM".to_vec(), name(b"AESV3")),
        (b"Length".to_vec(), Obj::number(32)),
    ]);
    let settings = Obj::Dict(vec![
        (b"Filter".to_vec(), name(b"Standard")),
        (b"V".to_vec(), Obj::number(5)),
        (b"R".to_vec(), Obj::number(6)),
        (b"Length".to_vec(), Obj::number(256)),
        (b"CF".to_vec(), Obj::Dict(vec![(b"StdCF".to_vec(), filter)])),
        (b"StmF".to_vec(), name(b"StdCF")),
        (b"StrF".to_vec(), name(b"StdCF")),
        (b"O".to_vec(), Obj::Str(owner)),
        (b"U".to_vec(), Obj::Str(user)),
        (b"OE".to_vec(), Obj::Str(owner_key)),
        (b"UE".to_vec(), Obj::Str(user_key)),
        (b"Perms".to_vec(), Obj::Str(perms)),
        (b"P".to_vec(), Obj::number(i64::from(ALL_ALLOWED))),
        (b"EncryptMetadata".to_vec(), Obj::Bool(true)),
    ]);
    let number = document.objects.keys().next_back().map_or(1, |last| last + 1);
    document.objects.insert(number, syntax::Stored { generation: 0, obj: settings, stream: None });
    document.trailer.set(b"Encrypt", Obj::Ref(number, 0));
    if !matches!(document.trailer.get(b"ID"), Some(Obj::Array(items)) if !items.is_empty()) {
        let id = random(16)?;
        document.trailer.set(b"ID", Obj::Array(vec![Obj::Str(id.clone()), Obj::Str(id)]));
    }
    Ok(document.save())
}

fn first_id(trailer: &Obj) -> Vec<u8> {
    match trailer.get(b"ID") {
        Some(Obj::Array(items)) => items.first().and_then(Obj::bytes).unwrap_or_default().to_vec(),
        _ => Vec::new(),
    }
}

impl Handler {
    fn open(settings: &Obj, id: &[u8], password: &str) -> Result<Handler, LockError> {
        let filter = settings.get(b"Filter").and_then(Obj::name).unwrap_or_default();
        if filter != b"Standard" {
            return Err(LockError::Unsupported(format!("the {} security handler", String::from_utf8_lossy(filter))));
        }
        let int = |key: &[u8]| settings.get(key).and_then(Obj::int);
        let bytes = |key: &[u8]| settings.get(key).and_then(Obj::bytes).unwrap_or_default().to_vec();
        let (version, revision) = (int(b"V").unwrap_or(0), int(b"R").unwrap_or(0));
        let metadata = !matches!(settings.get(b"EncryptMetadata"), Some(Obj::Bool(false)));
        let method = |name: &[u8]| -> Result<Method, LockError> {
            if name == b"Identity" {
                return Ok(Method::Identity);
            }
            let filter = settings.get(b"CF").and_then(|cf| cf.get(name));
            match filter.and_then(|f| f.get(b"CFM")).and_then(Obj::name) {
                Some(b"V2") => Ok(Method::Rc4),
                Some(b"AESV2") => Ok(Method::Aes128),
                Some(b"AESV3") => Ok(Method::Aes256),
                Some(b"None") | None => Ok(Method::Identity),
                Some(other) => Err(LockError::Unsupported(format!("the {} cipher", String::from_utf8_lossy(other)))),
            }
        };
        let (strings, streams) = if version >= 4 {
            let pick = |key: &[u8]| settings.get(key).and_then(Obj::name).unwrap_or(b"Identity").to_vec();
            (method(&pick(b"StrF"))?, method(&pick(b"StmF"))?)
        } else {
            (Method::Rc4, Method::Rc4)
        };
        let (owner, user) = (bytes(b"O"), bytes(b"U"));

        if revision >= 5 {
            let password = &password.as_bytes()[..password.len().min(127)];
            if owner.len() < 48 || user.len() < 48 {
                return Err(damaged("the password checks are too short"));
            }
            let hash = |salt: &[u8], extra: &[u8]| if revision == 5 { sha256(&[password, salt, extra]) } else { hash6(password, salt, extra) };
            let key = if hash(&user[32..40], &[]) == user[..32] {
                aes_cbc(&hash(&user[40..48], &[]), &[0; 16], &bytes(b"UE"), false)?
            } else if hash(&owner[32..40], &user[..48]) == owner[..32] {
                aes_cbc(&hash(&owner[40..48], &user[..48]), &[0; 16], &bytes(b"OE"), false)?
            } else {
                return Err(LockError::WrongPassword);
            };
            if key.len() != 32 {
                return Err(damaged("the file key is the wrong size"));
            }
            return Ok(Handler { key, strings, streams, metadata });
        }
        if !(2..=4).contains(&revision) || owner.len() < 32 || user.len() < 16 {
            return Err(LockError::Unsupported(format!("revision {revision} of the standard handler")));
        }

        let mut bits = if version >= 4 {
            let name = settings.get(b"StmF").and_then(Obj::name).unwrap_or_default();
            settings.get(b"CF").and_then(|cf| cf.get(name)).and_then(|f| f.get(b"Length")).and_then(Obj::int).unwrap_or(128)
        } else {
            int(b"Length").unwrap_or(40)
        };
        if bits < 40 {
            bits *= 8;
        }
        let length = if revision == 2 { 5 } else { (bits / 8).clamp(5, 16) as usize };
        let p = int(b"P").unwrap_or(0) as i32;
        let latin: Vec<u8> = password.chars().map(|c| u8::try_from(u32::from(c)).unwrap_or(b'?')).collect();

        let derive = |padded: &[u8; 32]| -> Vec<u8> {
            let mut md5 = Md5::new();
            md5.update(padded);
            md5.update(&owner[..32]);
            md5.update(p.to_le_bytes());
            md5.update(id);
            if revision >= 4 && !metadata {
                md5.update([0xFF; 4]);
            }
            let mut hash = md5.finalize().to_vec();
            if revision >= 3 {
                for _ in 0..50 {
                    hash = Md5::digest(&hash[..length]).to_vec();
                }
            }
            hash.truncate(length);
            hash
        };
        let opens = |key: &[u8]| -> bool {
            if revision == 2 {
                return rc4(key, &PAD) == user[..32];
            }
            let mut md5 = Md5::new();
            md5.update(PAD);
            md5.update(id);
            let mut check = rc4(key, &md5.finalize());
            for i in 1..=19u8 {
                check = rc4(&xor(key, i), &check);
            }
            check[..16] == user[..16]
        };

        let key = derive(&padded(&latin));
        if opens(&key) {
            return Ok(Handler { key, strings, streams, metadata });
        }
        let mut hash = Md5::digest(padded(&latin)).to_vec();
        if revision >= 3 {
            for _ in 0..50 {
                hash = Md5::digest(&hash).to_vec();
            }
        }
        let owner_key = &hash[..length];
        let mut user_password = owner[..32].to_vec();
        if revision == 2 {
            user_password = rc4(owner_key, &user_password);
        } else {
            for i in (0..=19u8).rev() {
                user_password = rc4(&xor(owner_key, i), &user_password);
            }
        }
        let key = derive(&padded(&user_password));
        if opens(&key) {
            return Ok(Handler { key, strings, streams, metadata });
        }
        Err(LockError::WrongPassword)
    }

    fn object_key(&self, method: Method, number: u32, generation: u16) -> Vec<u8> {
        if method == Method::Aes256 {
            return self.key.clone();
        }
        let mut md5 = Md5::new();
        md5.update(&self.key);
        md5.update(&number.to_le_bytes()[..3]);
        md5.update(generation.to_le_bytes());
        if method == Method::Aes128 {
            md5.update(b"sAlT");
        }
        let mut key = md5.finalize().to_vec();
        key.truncate((self.key.len() + 5).min(16));
        key
    }

    fn crypt(&self, method: Method, number: u32, generation: u16, data: &[u8], seal: bool) -> Result<Vec<u8>, LockError> {
        let key = self.object_key(method, number, generation);
        match method {
            Method::Identity => Ok(data.to_vec()),
            Method::Rc4 => Ok(rc4(&key, data)),
            Method::Aes128 | Method::Aes256 if seal => {
                let iv = random(16)?;
                let fill = 16 - data.len() % 16;
                let mut plain = data.to_vec();
                plain.extend(std::iter::repeat_n(fill as u8, fill));
                let mut out = iv.clone();
                out.extend(aes_cbc(&key, &iv, &plain, true)?);
                Ok(out)
            }
            Method::Aes128 | Method::Aes256 => {
                if data.len() < 32 {
                    return Ok(Vec::new());
                }
                let body = &data[16..16 + (data.len() - 16) / 16 * 16];
                let mut plain = aes_cbc(&key, &data[..16], body, false)?;
                let fill = usize::from(*plain.last().unwrap_or(&0));
                if (1..=16).contains(&fill) && plain[plain.len() - fill..].iter().all(|&b| usize::from(b) == fill) {
                    plain.truncate(plain.len() - fill);
                }
                Ok(plain)
            }
        }
    }

    fn strings_in(&self, obj: &mut Obj, number: u32, generation: u16, seal: bool) -> Result<(), LockError> {
        match obj {
            Obj::Str(bytes) => *bytes = self.crypt(self.strings, number, generation, bytes, seal)?,
            Obj::Array(items) => {
                for item in items {
                    self.strings_in(item, number, generation, seal)?;
                }
            }
            Obj::Dict(pairs) => {
                for (_, value) in pairs {
                    self.strings_in(value, number, generation, seal)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
}

fn padded(password: &[u8]) -> [u8; 32] {
    let mut out = PAD;
    let n = password.len().min(32);
    out[..n].copy_from_slice(&password[..n]);
    out[n..].copy_from_slice(&PAD[..32 - n]);
    out
}

fn xor(key: &[u8], value: u8) -> Vec<u8> {
    key.iter().map(|b| b ^ value).collect()
}

fn rc4(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut state: [u8; 256] = std::array::from_fn(|i| i as u8);
    let mut j = 0u8;
    for i in 0..256 {
        j = j.wrapping_add(state[i]).wrapping_add(key[i % key.len()]);
        state.swap(i, usize::from(j));
    }
    let (mut i, mut j) = (0u8, 0u8);
    data.iter()
        .map(|&byte| {
            i = i.wrapping_add(1);
            j = j.wrapping_add(state[usize::from(i)]);
            state.swap(usize::from(i), usize::from(j));
            byte ^ state[usize::from(state[usize::from(i)].wrapping_add(state[usize::from(j)]))]
        })
        .collect()
}

/// AES-CBC without padding, with a 128 or 256 bit key.
fn aes_cbc(key: &[u8], iv: &[u8], data: &[u8], encrypt: bool) -> Result<Vec<u8>, LockError> {
    let mut buf = data[..data.len() / 16 * 16].to_vec();
    let len = buf.len();
    let done = match (key.len(), encrypt) {
        (16, true) => cbc::Encryptor::<aes::Aes128>::new_from_slices(key, iv).map_err(damaged)?.encrypt_padded_mut::<NoPadding>(&mut buf, len).map(|_| ()).map_err(|_| ()),
        (32, true) => cbc::Encryptor::<aes::Aes256>::new_from_slices(key, iv).map_err(damaged)?.encrypt_padded_mut::<NoPadding>(&mut buf, len).map(|_| ()).map_err(|_| ()),
        (16, false) => cbc::Decryptor::<aes::Aes128>::new_from_slices(key, iv).map_err(damaged)?.decrypt_padded_mut::<NoPadding>(&mut buf).map(|_| ()).map_err(|_| ()),
        (32, false) => cbc::Decryptor::<aes::Aes256>::new_from_slices(key, iv).map_err(damaged)?.decrypt_padded_mut::<NoPadding>(&mut buf).map(|_| ()).map_err(|_| ()),
        _ => return Err(damaged("a key of the wrong size")),
    };
    done.map_err(|_| damaged("an encrypted part is cut short"))?;
    Ok(buf)
}

fn sha256(parts: &[&[u8]]) -> Vec<u8> {
    let mut hash = sha2::Sha256::new();
    for part in parts {
        hash.update(part);
    }
    hash.finalize().to_vec()
}

/// The password hash of revision 6, algorithm 2.B of ISO 32000-2.
fn hash6(password: &[u8], salt: &[u8], extra: &[u8]) -> Vec<u8> {
    let mut k = sha256(&[password, salt, extra]);
    let mut round = 0usize;
    loop {
        let mut once = Vec::with_capacity(password.len() + k.len() + extra.len());
        once.extend_from_slice(password);
        once.extend_from_slice(&k);
        once.extend_from_slice(extra);
        let k1 = once.repeat(64);
        let e = aes_cbc(&k[..16], &k[16..32], &k1, true).expect("a whole number of blocks");
        k = match e[..16].iter().map(|&b| u32::from(b)).sum::<u32>() % 3 {
            0 => sha2::Sha256::digest(&e).to_vec(),
            1 => sha2::Sha384::digest(&e).to_vec(),
            _ => sha2::Sha512::digest(&e).to_vec(),
        };
        round += 1;
        if round >= 64 && usize::from(*e.last().expect("not empty")) + 32 <= round {
            break;
        }
    }
    k.truncate(32);
    k
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLAIN: &[u8] = b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length 44 >>\nstream\nBT /F1 12 Tf 20 100 Td (Secret words) Tj ET\n\nendstream\nendobj\n5 0 obj\n<< /Title (Secret title) >>\nendobj\ntrailer\n<< /Root 1 0 R /Info 5 0 R >>\n";

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/encrypted").join(name)).unwrap()
    }

    fn text(bytes: &[u8]) -> String {
        match bytes.strip_prefix(&[0xFE, 0xFF]) {
            Some(wide) => String::from_utf16_lossy(&wide.chunks(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect::<Vec<_>>()),
            None => String::from_utf8_lossy(bytes).to_string(),
        }
    }

    /// Opens the result again: no protection left, the Info strings readable, every compressed stream whole.
    fn info_of(open: &[u8]) -> String {
        let document = Document::load(open).unwrap();
        assert!(document.trailer.get(b"Encrypt").is_none());
        let mut streams = 0;
        for stored in document.objects.values() {
            if let Some(data) = &stored.stream {
                if stored.obj.get(b"Filter").and_then(Obj::name) == Some(b"FlateDecode") {
                    assert!(!syntax::decode(&stored.obj, data).unwrap().is_empty());
                    streams += 1;
                }
            }
        }
        assert!(streams > 0);
        let info = document.trailer.get(b"Info").map_or(&Obj::Null, |info| document.resolve(info));
        let mut found: Vec<String> = ["Producer", "Title"].iter().filter_map(|key| info.get(key.as_bytes()).and_then(Obj::bytes)).map(text).collect();
        let catalog = document.resolve(document.trailer.get(b"Root").unwrap());
        if let Some(Obj::Ref(number, _)) = catalog.get(b"Metadata") {
            let stored = &document.objects[number];
            found.push(text(&syntax::decode(&stored.obj, stored.stream.as_deref().unwrap()).unwrap()));
        }
        found.join("|")
    }

    #[test]
    fn files_from_libreoffice_and_others_open() {
        for (file, needs, right, info) in [
            ("pdf-owner-rc4.pdf", false, "own", "LibreOffice"),
            ("pdf-user-rc4.pdf", true, "usr", "LibreOffice"),
            ("pdf-user-aes256.pdf", true, "usr", "LibreOffice"),
            ("pdf-aes128.pdf", true, "usr4", "LibreOffice"),
            ("pdf-aes128.pdf", true, "own4", "LibreOffice"),
            ("pdf-packed-rc4.pdf", true, "usr3", "Packed title"),
            ("pdf-packed-rc4.pdf", true, "own3", "Packed title"),
        ] {
            let bytes = fixture(file);
            let without = unlock(&bytes, None);
            if needs {
                assert_eq!(without, Err(LockError::NeedsPassword(Protection::Pdf)), "{file}");
                assert_eq!(unlock(&bytes, Some("not it")), Err(LockError::WrongPassword), "{file}");
            } else {
                assert!(info_of(&without.unwrap().unwrap()).contains(info), "{file}");
            }
            let open = unlock(&bytes, Some(right)).unwrap().unwrap();
            assert!(info_of(&open).contains(info), "{file} with {right}");
        }
    }

    #[test]
    fn what_is_opened_seals_again_and_opens_the_same() {
        let open = unlock(&fixture("pdf-packed-rc4.pdf"), Some("usr3")).unwrap().unwrap();
        let sealed = lock(&open, "again").unwrap();
        let again = unlock(&sealed, Some("again")).unwrap().unwrap();
        assert_eq!(Document::load(&again).unwrap().objects, Document::load(&open).unwrap().objects);
    }

    #[test]
    fn cut_or_broken_files_give_an_error_and_never_a_panic() {
        let bytes = fixture("pdf-aes128.pdf");
        for cut in (0..bytes.len()).step_by(97) {
            let _ = unlock(&bytes[..cut], Some("usr4"));
        }
        let mut broken = bytes.clone();
        for i in (0..broken.len()).step_by(53) {
            broken[i] ^= 0x5A;
        }
        let _ = unlock(&broken, Some("usr4"));
        let _ = unlock(b"%PDF-1.7\n1 0 obj << /Encrypt 99999999 0 R >> endobj trailer << /Root 1 0 R /Encrypt 1 0 R >>", None);
    }

    #[test]
    fn rc4_matches_the_published_vector() {
        assert_eq!(rc4(b"Key", b"Plaintext"), [0xBB, 0xF3, 0x16, 0xE8, 0xD9, 0x40, 0xAF, 0x0A, 0xD3]);
    }

    #[test]
    fn a_pdf_in_the_clear_is_left_alone() {
        assert_eq!(unlock(PLAIN, None), Ok(None));
    }

    #[test]
    fn sealed_with_aes_256_it_opens_only_with_the_password() {
        let sealed = lock(PLAIN, "pässword").unwrap();
        let text = String::from_utf8_lossy(&sealed);
        assert!(!text.contains("Secret"));
        assert!(text.contains("/R 6"));
        assert_eq!(unlock(&sealed, None), Err(LockError::NeedsPassword(Protection::Pdf)));
        assert_eq!(unlock(&sealed, Some("password")), Err(LockError::WrongPassword));
        let open = unlock(&sealed, Some("pässword")).unwrap().unwrap();
        let document = Document::load(&open).unwrap();
        assert!(document.trailer.get(b"Encrypt").is_none());
        assert_eq!(document.objects[&5].obj.get(b"Title").and_then(Obj::bytes), Some(&b"Secret title"[..]));
        assert!(document.objects[&4].stream.as_deref().unwrap().starts_with(b"BT /F1 12 Tf 20 100 Td (Secret words) Tj ET"));
    }
}
