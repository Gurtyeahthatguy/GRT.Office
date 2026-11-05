//! Documents protected with a password: Office, OpenDocument, PDF and GRT.

mod attrs;
mod grt;
mod odf;
mod office;
mod pdf;

use std::fmt;
use std::io::Read;

use flate2::read::DeflateDecoder;

use crate::zip::{read_archive, Entry, MAX_TOTAL};

/// How a file is protected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Protection {
    /// Agile Encryption of `.docx`, `.xlsx` and `.pptx`, and Standard when reading.
    Office,
    /// OpenDocument encryption, as LibreOffice 7.5 and later writes it; older kinds when reading.
    Odf,
    /// A `.grt` document sealed with AES-256-GCM.
    Grt,
    /// The standard security handler of PDF; AES-256 when writing.
    Pdf,
}

impl Protection {
    pub fn name(self) -> &'static str {
        match self {
            Protection::Office => "office",
            Protection::Odf => "odf",
            Protection::Grt => "grt",
            Protection::Pdf => "pdf",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "office" => Some(Protection::Office),
            "odf" => Some(Protection::Odf),
            "grt" => Some(Protection::Grt),
            "pdf" => Some(Protection::Pdf),
            _ => None,
        }
    }
}

/// Why a protected file did not open, or could not be sealed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LockError {
    NeedsPassword(Protection),
    WrongPassword,
    Unsupported(String),
    Damaged(String),
}

impl fmt::Display for LockError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LockError::NeedsPassword(_) => write!(f, "This file is protected with a password"),
            LockError::WrongPassword => write!(f, "The password is not right"),
            LockError::Unsupported(what) => write!(f, "This file is protected in a way GRT cannot open: {what}"),
            LockError::Damaged(what) => write!(f, "The protected file is damaged: {what}"),
        }
    }
}

impl std::error::Error for LockError {}

fn damaged(what: impl fmt::Display) -> LockError {
    LockError::Damaged(what.to_string())
}

/// What protects these bytes, or None when they are in the clear.
pub fn protection_of(bytes: &[u8]) -> Option<Protection> {
    if office::is_protected(bytes) {
        return Some(Protection::Office);
    }
    let entries = read_archive(bytes).ok()?;
    if grt::is_protected(&entries) {
        Some(Protection::Grt)
    } else if odf::is_protected(&entries) {
        Some(Protection::Odf)
    } else {
        None
    }
}

/// Opens protected bytes with a password, into the entries of the archive inside.
pub fn unlock(bytes: &[u8], password: &str) -> Result<(Protection, Vec<Entry>), LockError> {
    match protection_of(bytes) {
        Some(Protection::Office) => {
            let zip = office::decrypt(bytes, password)?;
            Ok((Protection::Office, read_archive(&zip).map_err(damaged)?))
        }
        Some(kind @ (Protection::Odf | Protection::Grt)) => {
            let outer = read_archive(bytes).map_err(damaged)?;
            let entries = if kind == Protection::Odf {
                odf::decrypt(&outer, password)?
            } else {
                read_archive(&grt::decrypt(&outer, password)?).map_err(damaged)?
            };
            Ok((kind, entries))
        }
        Some(Protection::Pdf) | None => Err(LockError::Unsupported("the file is not protected".to_string())),
    }
}

/// Seals a plain archive, or a PDF, with a password.
pub fn lock(zip: &[u8], protection: Protection, password: &str) -> Result<Vec<u8>, LockError> {
    if password.is_empty() {
        return Err(LockError::Unsupported("an empty password".to_string()));
    }
    match protection {
        Protection::Office => office::encrypt(zip, password),
        Protection::Odf => odf::encrypt(zip, password),
        Protection::Grt => grt::encrypt(zip, password),
        Protection::Pdf => pdf::lock(zip, password),
    }
}

/// A PDF in the clear, or None when it was not protected; without a password only one that restricts editing opens.
pub fn unlock_pdf(bytes: &[u8], password: Option<&str>) -> Result<Option<Vec<u8>>, LockError> {
    pdf::unlock(bytes, password)
}

/// Fresh random bytes from the operating system.
fn random(n: usize) -> Result<Vec<u8>, LockError> {
    let mut bytes = vec![0u8; n];
    getrandom::getrandom(&mut bytes).map_err(|e| LockError::Unsupported(format!("no randomness: {e}")))?;
    Ok(bytes)
}

/// Raw deflate, refusing anything that grows past the archive limit.
fn inflate(data: &[u8]) -> Result<Vec<u8>, LockError> {
    let mut out = Vec::new();
    DeflateDecoder::new(data)
        .take(MAX_TOTAL + 1)
        .read_to_end(&mut out)
        .map_err(damaged)?;
    if out.len() as u64 > MAX_TOTAL {
        return Err(damaged("it expands past the size GRT opens"));
    }
    Ok(out)
}

fn deflate(data: &[u8]) -> Result<Vec<u8>, LockError> {
    use std::io::Write;
    let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::new(6));
    encoder.write_all(data).map_err(damaged)?;
    encoder.finish().map_err(damaged)
}

fn base64(text: &str) -> Result<Vec<u8>, LockError> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(text.trim())
        .map_err(|_| damaged("a value is not base64"))
}

fn to_base64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Argon2id as LibreOffice uses it: the SHA-256 of the password, three passes, 64 MiB, four lanes.
fn argon2id(password: &str, salt: &[u8], passes: u32, memory: u32, lanes: u32) -> Result<[u8; 32], LockError> {
    use sha2::Digest;
    if passes == 0 || passes > 64 || memory > 1 << 21 || lanes == 0 || lanes > 64 {
        return Err(LockError::Unsupported("key derivation settings out of range".to_string()));
    }
    let start = sha2::Sha256::digest(password.as_bytes());
    let params = argon2::Params::new(memory, passes, lanes, Some(32))
        .map_err(|e| LockError::Unsupported(format!("key derivation: {e}")))?;
    let mut key = [0u8; 32];
    argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params)
        .hash_password_into(&start, salt, &mut key)
        .map_err(|e| LockError::Unsupported(format!("key derivation: {e}")))?;
    Ok(key)
}

/// AES-256-GCM with the nonce in front and the tag behind, as the W3C convention has it.
fn seal_gcm(key: &[u8; 32], plain: &[u8]) -> Result<(Vec<u8>, Vec<u8>), LockError> {
    use aes_gcm::aead::{Aead, KeyInit};
    let nonce = random(12)?;
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(key).map_err(damaged)?;
    let sealed = cipher
        .encrypt(aes_gcm::Nonce::from_slice(&nonce), plain)
        .map_err(|_| damaged("encryption failed"))?;
    let mut out = nonce.clone();
    out.extend(sealed);
    Ok((nonce, out))
}

fn open_gcm(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>, LockError> {
    use aes_gcm::aead::{Aead, KeyInit};
    if data.len() < 12 + 16 {
        return Err(damaged("the encrypted part is too short"));
    }
    let cipher = aes_gcm::Aes256Gcm::new_from_slice(key).map_err(damaged)?;
    cipher
        .decrypt(aes_gcm::Nonce::from_slice(&data[..12]), &data[12..])
        .map_err(|_| LockError::WrongPassword)
}
