//! A `.grt` document with a password: the whole archive deflated and sealed with AES-256-GCM.

use super::{argon2id, base64, damaged, deflate, inflate, open_gcm, random, seal_gcm, to_base64, LockError};
use crate::zip::{write_zip, Entry, Item};
use crate::README_NAME;

const SETTINGS: &str = "protection.json";
const SEALED: &str = "document.sealed";

const PASSES: u32 = 3;
const MEMORY: u32 = 65_536;
const LANES: u32 = 4;

pub const README_PROTECTED: &str = "\
This file is a GRT document protected with a password.

It is an ordinary ZIP archive. Inside:

  protection.json   how the document is sealed
  document.sealed   the document itself, encrypted

The document is a complete GRT archive, deflated and then sealed with
AES-256-GCM. The key comes from the password through Argon2id, with the
settings and the salt written in protection.json. Without the password the
content cannot be read; with it, any implementation of these two standard
algorithms can open it.

GRT is free software, licensed under the MIT licence.
";

pub fn is_protected(entries: &[Entry]) -> bool {
    entries.iter().any(|entry| entry.name == SETTINGS) && entries.iter().any(|entry| entry.name == SEALED)
}

pub fn decrypt(entries: &[Entry], password: &str) -> Result<Vec<u8>, LockError> {
    let find = |name: &str| entries.iter().find(|entry| entry.name == name).map(|entry| &entry.data);
    let settings: serde_json::Value =
        serde_json::from_slice(find(SETTINGS).ok_or_else(|| damaged("no protection settings"))?).map_err(damaged)?;
    let text = |key: &str| settings.get(key).and_then(serde_json::Value::as_str).unwrap_or_default();
    if text("cipher") != "aes-256-gcm" || text("kdf") != "argon2id" {
        return Err(LockError::Unsupported(format!("{} with {}", text("cipher"), text("kdf"))));
    }
    let number = |key: &str| settings.get(key).and_then(serde_json::Value::as_u64).unwrap_or(0) as u32;
    let key = argon2id(password, &base64(text("salt"))?, number("passes"), number("memory"), number("lanes"))?;
    inflate(&open_gcm(&key, find(SEALED).ok_or_else(|| damaged("no sealed document"))?)?)
}

pub fn encrypt(zip: &[u8], password: &str) -> Result<Vec<u8>, LockError> {
    let salt = random(16)?;
    let key = argon2id(password, &salt, PASSES, MEMORY, LANES)?;
    let (_, sealed) = seal_gcm(&key, &deflate(zip)?)?;
    let settings = serde_json::json!({
        "cipher": "aes-256-gcm",
        "kdf": "argon2id",
        "passes": PASSES,
        "memory": MEMORY,
        "lanes": LANES,
        "salt": to_base64(&salt),
    });
    let settings = format!("{}\n", serde_json::to_string_pretty(&settings).map_err(damaged)?);
    write_zip(&[
        Item { name: README_NAME, data: README_PROTECTED.as_bytes(), store: false },
        Item { name: SEALED, data: &sealed, store: true },
        Item { name: SETTINGS, data: settings.as_bytes(), store: false },
    ])
    .map_err(damaged)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::zip::read_archive;

    #[test]
    fn a_sealed_document_opens_with_its_password_and_not_without() {
        let zip = crate::write_archive(vec![Entry::new("content/main.json", b"{\"text\":\"secret words\"}".to_vec())]).unwrap();
        let sealed = encrypt(&zip, "pässwörd 1").unwrap();
        assert!(!String::from_utf8_lossy(&sealed).contains("secret words"));
        let outer = read_archive(&sealed).unwrap();
        assert!(is_protected(&outer));
        assert_eq!(outer[0].name, README_NAME);
        assert_eq!(decrypt(&outer, "pässwörd 1").unwrap(), zip);
        assert_eq!(decrypt(&outer, "password 1"), Err(LockError::WrongPassword));
    }
}
