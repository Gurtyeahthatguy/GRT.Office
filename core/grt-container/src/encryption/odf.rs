//! OpenDocument files with a password (ODF 1.4 part 2, and the LibreOffice extensions).

use sha2::Digest;

use super::attrs::{elements, get};
use super::{argon2id, base64, damaged, deflate, inflate, open_gcm, random, seal_gcm, to_base64, LockError};
use crate::zip::{read_archive, write_zip, Entry, Item};

const MANIFEST: &str = "META-INF/manifest.xml";
const PACKAGE: &str = "encrypted-package";

const AES_GCM: &str = "http://www.w3.org/2009/xmlenc11#aes256-gcm";
const AES_CBC: &str = "http://www.w3.org/2001/04/xmlenc#aes256-cbc";
const BLOWFISH: &str = "Blowfish CFB";
const ARGON2ID: &str = "urn:org:documentfoundation:names:experimental:office:manifest:argon2id";

/// Argon2id settings LibreOffice writes: three passes over 64 MiB, four lanes.
const PASSES: u32 = 3;
const MEMORY: u32 = 65_536;
const LANES: u32 = 4;

/// Whether the manifest says that anything in the package is encrypted.
pub fn is_protected(entries: &[Entry]) -> bool {
    entries
        .iter()
        .find(|entry| entry.name == MANIFEST)
        .is_some_and(|entry| String::from_utf8_lossy(&entry.data).contains("encryption-data"))
}

/// How one part was sealed, as the manifest describes it.
struct Sealed {
    path: String,
    algorithm: String,
    iv: Vec<u8>,
    salt: Vec<u8>,
    derivation: String,
    iterations: u32,
    argon2: (u32, u32, u32),
    key_size: usize,
    start_sha256: bool,
    checksum_type: String,
    checksum: Vec<u8>,
}

fn sealed_parts(manifest: &str) -> Result<Vec<Sealed>, LockError> {
    let mut out = Vec::new();
    for block in manifest.split("<manifest:file-entry").skip(1) {
        if !block.contains("encryption-data") {
            continue;
        }
        let entry = &elements(&format!("<file-entry{block}"), "file-entry")[0];
        let path = get(entry, "full-path").ok_or_else(|| damaged("an encrypted part has no name"))?.to_string();
        let first = |name: &str| elements(block, name).into_iter().next().unwrap_or_default();
        let data = first("encryption-data");
        let algorithm = first("algorithm");
        let derivation = first("key-derivation");
        let start = first("start-key-generation");
        let number = |attrs: &[(String, String)], name: &str, default: u32| -> Result<u32, LockError> {
            get(attrs, name).map_or(Ok(default), |v| v.parse().map_err(|_| damaged(format!("{name} is not a number"))))
        };
        out.push(Sealed {
            path,
            algorithm: get(&algorithm, "algorithm-name").unwrap_or_default().to_string(),
            iv: base64(get(&algorithm, "initialisation-vector").unwrap_or_default())?,
            salt: base64(get(&derivation, "salt").unwrap_or_default())?,
            derivation: get(&derivation, "key-derivation-name").unwrap_or_default().to_string(),
            iterations: number(&derivation, "iteration-count", 0)?,
            argon2: (
                number(&derivation, "argon2-iterations", PASSES)?,
                number(&derivation, "argon2-memory", MEMORY)?,
                number(&derivation, "argon2-lanes", LANES)?,
            ),
            key_size: number(&derivation, "key-size", 16)? as usize,
            start_sha256: get(&start, "start-key-generation-name").is_some_and(|name| name.contains("sha256")),
            checksum_type: get(&data, "checksum-type").unwrap_or_default().to_string(),
            checksum: base64(get(&data, "checksum").unwrap_or_default())?,
        });
    }
    Ok(out)
}

fn derive_key(part: &Sealed, password: &str) -> Result<Vec<u8>, LockError> {
    if part.derivation == ARGON2ID {
        let (passes, memory, lanes) = part.argon2;
        return Ok(argon2id(password, &part.salt, passes, memory, lanes)?.to_vec());
    }
    if part.derivation != "PBKDF2" || part.iterations == 0 || part.iterations > 10_000_000 || !matches!(part.key_size, 16 | 32) {
        return Err(LockError::Unsupported(format!("the {} key derivation", part.derivation)));
    }
    let start = if part.start_sha256 {
        sha2::Sha256::digest(password.as_bytes()).to_vec()
    } else {
        sha1::Sha1::digest(password.as_bytes()).to_vec()
    };
    let mut key = vec![0u8; part.key_size];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(&start, &part.salt, part.iterations, &mut key);
    Ok(key)
}

fn decrypt_part(part: &Sealed, key: &[u8], data: &[u8]) -> Result<Vec<u8>, LockError> {
    let plain = match part.algorithm.as_str() {
        AES_GCM => {
            let key: [u8; 32] = key.try_into().map_err(|_| damaged("the key is not 256 bits"))?;
            return open_gcm(&key, data);
        }
        AES_CBC => {
            use aes::cipher::block_padding::NoPadding;
            use aes::cipher::{BlockDecryptMut, KeyIvInit};
            if !data.len().is_multiple_of(16) || data.is_empty() {
                return Err(damaged("an encrypted part is cut short"));
            }
            let mut buf = data.to_vec();
            cbc::Decryptor::<aes::Aes256>::new_from_slices(key, &part.iv)
                .map_err(|_| damaged("the key or vector has the wrong size"))?
                .decrypt_padded_mut::<NoPadding>(&mut buf)
                .map_err(|_| damaged("an encrypted part is cut short"))?;
            // W3C padding: the last byte says how many bytes were added.
            let pad = usize::from(*buf.last().expect("not empty"));
            if pad == 0 || pad > 16 {
                return Err(LockError::WrongPassword);
            }
            buf.truncate(buf.len() - pad);
            buf
        }
        BLOWFISH => {
            use cfb_mode::cipher::{AsyncStreamCipher, KeyIvInit};
            let mut buf = data.to_vec();
            cfb_mode::Decryptor::<blowfish::Blowfish>::new_from_slices(key, &part.iv)
                .map_err(|_| damaged("the key or vector has the wrong size"))?
                .decrypt(&mut buf);
            buf
        }
        other => return Err(LockError::Unsupported(format!("the {other} cipher"))),
    };
    let head = &plain[..plain.len().min(1024)];
    let sum = if part.checksum_type.to_ascii_lowercase().contains("sha256") {
        sha2::Sha256::digest(head).to_vec()
    } else {
        sha1::Sha1::digest(head).to_vec()
    };
    if sum != part.checksum {
        return Err(LockError::WrongPassword);
    }
    Ok(plain)
}

/// The parts of a protected OpenDocument package, in the clear.
pub fn decrypt(entries: &[Entry], password: &str) -> Result<Vec<Entry>, LockError> {
    let manifest = entries
        .iter()
        .find(|entry| entry.name == MANIFEST)
        .map(|entry| String::from_utf8_lossy(&entry.data).to_string())
        .ok_or_else(|| damaged("no manifest"))?;
    let parts = sealed_parts(&manifest)?;

    // LibreOffice 7.5 and later seal the whole package as one part.
    if let Some(part) = parts.iter().find(|part| part.path == PACKAGE) {
        let data = &entries.iter().find(|entry| entry.name == PACKAGE).ok_or_else(|| damaged("the sealed package is missing"))?.data;
        let key = derive_key(part, password)?;
        let inner = inflate(&decrypt_part(part, &key, data)?)?;
        return read_archive(&inner).map_err(damaged);
    }

    // Older files seal each part on its own, every one with the same password.
    let mut keys: Vec<(Vec<u8>, u32, Vec<u8>)> = Vec::new();
    let mut out = Vec::with_capacity(entries.len());
    for entry in entries {
        let Some(part) = parts.iter().find(|part| part.path == entry.name) else {
            out.push(entry.clone());
            continue;
        };
        let cached = keys.iter().find(|(salt, n, _)| *salt == part.salt && *n == part.iterations).map(|(_, _, key)| key.clone());
        let key = match cached {
            Some(key) => key,
            None => {
                let key = derive_key(part, password)?;
                keys.push((part.salt.clone(), part.iterations, key.clone()));
                key
            }
        };
        out.push(Entry::new(entry.name.clone(), inflate(&decrypt_part(part, &key, &entry.data)?)?));
    }
    // The parts are in the clear now, so the manifest stops saying otherwise.
    let plain_manifest = strip_encryption(&manifest);
    for entry in &mut out {
        if entry.name == MANIFEST {
            entry.data = plain_manifest.clone().into_bytes();
        }
    }
    Ok(out)
}

fn strip_encryption(manifest: &str) -> String {
    let mut out = String::with_capacity(manifest.len());
    let mut rest = manifest;
    while let Some(start) = rest.find("<manifest:encryption-data") {
        out.push_str(rest[..start].trim_end_matches([' ', '\n', '\r', '\t']));
        let Some(end) = rest[start..].find("</manifest:encryption-data>") else { break };
        rest = &rest[start + end + "</manifest:encryption-data>".len()..];
    }
    out.push_str(rest);
    out
}

/// Seals an OpenDocument package as LibreOffice 7.5 and later does: deflated whole, AES-256-GCM, Argon2id.
pub fn encrypt(zip: &[u8], password: &str) -> Result<Vec<u8>, LockError> {
    let entries = read_archive(zip).map_err(damaged)?;
    let media_type = entries
        .iter()
        .find(|entry| entry.name == "mimetype")
        .map(|entry| String::from_utf8_lossy(&entry.data).trim().to_string())
        .ok_or_else(|| damaged("the package has no mimetype"))?;
    let salt = random(16)?;
    let key = argon2id(password, &salt, PASSES, MEMORY, LANES)?;
    let (nonce, sealed) = seal_gcm(&key, &deflate(zip)?)?;
    let escape = |text: &str| text.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;");
    let manifest = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <manifest:manifest xmlns:manifest=\"urn:oasis:names:tc:opendocument:xmlns:manifest:1.0\" manifest:version=\"1.4\" \
         xmlns:loext=\"urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0\">\n \
         <manifest:file-entry manifest:full-path=\"{PACKAGE}\" manifest:media-type=\"{}\" manifest:size=\"{}\">\n  \
         <manifest:encryption-data>\n   \
         <manifest:algorithm manifest:algorithm-name=\"{AES_GCM}\" manifest:initialisation-vector=\"{}\"/>\n   \
         <manifest:start-key-generation manifest:start-key-generation-name=\"http://www.w3.org/2001/04/xmlenc#sha256\" manifest:key-size=\"32\"/>\n   \
         <manifest:key-derivation manifest:key-derivation-name=\"{ARGON2ID}\" loext:argon2-iterations=\"{PASSES}\" loext:argon2-memory=\"{MEMORY}\" \
         loext:argon2-lanes=\"{LANES}\" manifest:salt=\"{}\" manifest:key-size=\"32\"/>\n  \
         </manifest:encryption-data>\n \
         </manifest:file-entry>\n\
         </manifest:manifest>\n",
        escape(&media_type),
        zip.len(),
        to_base64(&nonce),
        to_base64(&salt),
    );
    write_zip(&[
        Item { name: "mimetype", data: media_type.as_bytes(), store: true },
        Item { name: PACKAGE, data: &sealed, store: true },
        Item { name: MANIFEST, data: manifest.as_bytes(), store: false },
    ])
    .map_err(damaged)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn odt() -> Vec<u8> {
        write_zip(&[
            Item { name: "mimetype", data: b"application/vnd.oasis.opendocument.text", store: true },
            Item { name: "content.xml", data: b"<office:document-content>secret words</office:document-content>", store: false },
            Item { name: MANIFEST, data: b"<manifest:manifest/>", store: false },
        ])
        .unwrap()
    }

    #[test]
    fn a_sealed_package_opens_with_its_password_and_not_without() {
        let sealed = encrypt(&odt(), "pässwörd 1").unwrap();
        let outer = read_archive(&sealed).unwrap();
        assert!(is_protected(&outer));
        assert!(!String::from_utf8_lossy(&sealed).contains("secret words"));
        let plain = decrypt(&outer, "pässwörd 1").unwrap();
        assert_eq!(plain, read_archive(&odt()).unwrap());
        assert_eq!(decrypt(&outer, "password 1"), Err(LockError::WrongPassword));
    }

    #[test]
    fn the_manifest_loses_its_encryption_data_and_nothing_else() {
        let manifest = "<m>\n <manifest:file-entry manifest:full-path=\"a\">\n  <manifest:encryption-data x=\"1\">\n   <manifest:algorithm/>\n  </manifest:encryption-data>\n </manifest:file-entry>\n</m>";
        assert_eq!(strip_encryption(manifest), "<m>\n <manifest:file-entry manifest:full-path=\"a\">\n </manifest:file-entry>\n</m>");
    }
}
