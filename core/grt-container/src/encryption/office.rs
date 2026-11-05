//! Office files with a password: Agile and Standard Encryption ([MS-OFFCRYPTO]).

use std::io::{Cursor, Read, Write};

use aes::cipher::block_padding::NoPadding;
use aes::cipher::{BlockDecrypt, BlockDecryptMut, BlockEncryptMut, KeyInit, KeyIvInit};
use sha2::Digest;

use super::attrs::{element, get};
use super::{base64, damaged, random, to_base64, LockError};

const CFB_SIGNATURE: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
const SEGMENT: usize = 4096;
const SPIN_COUNT: u32 = 100_000;
const MAX_SPIN_COUNT: u32 = 10_000_000;

const BLOCK_VERIFIER_INPUT: [u8; 8] = [0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79];
const BLOCK_VERIFIER_VALUE: [u8; 8] = [0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e];
const BLOCK_KEY: [u8; 8] = [0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6];
const BLOCK_HMAC_KEY: [u8; 8] = [0x5f, 0xb2, 0xad, 0x01, 0x0c, 0xb9, 0xe1, 0xf6];
const BLOCK_HMAC_VALUE: [u8; 8] = [0xa0, 0x67, 0x7f, 0x02, 0xb2, 0x2c, 0x84, 0x33];

/// Whether the bytes are a compound file holding an encrypted package.
pub fn is_protected(bytes: &[u8]) -> bool {
    if bytes.len() < 512 || bytes[..8] != CFB_SIGNATURE {
        return false;
    }
    cfb::CompoundFile::open(Cursor::new(bytes))
        .map(|file| file.is_stream("/EncryptionInfo") && file.is_stream("/EncryptedPackage"))
        .unwrap_or(false)
}

#[derive(Clone, Copy)]
enum Hash {
    Sha1,
    Sha256,
    Sha384,
    Sha512,
}

impl Hash {
    fn from_name(name: &str) -> Result<Self, LockError> {
        match name {
            "SHA1" | "SHA-1" => Ok(Hash::Sha1),
            "SHA256" => Ok(Hash::Sha256),
            "SHA384" => Ok(Hash::Sha384),
            "SHA512" => Ok(Hash::Sha512),
            other => Err(LockError::Unsupported(format!("the {other} hash"))),
        }
    }

    fn of(self, parts: &[&[u8]]) -> Vec<u8> {
        fn run<D: Digest>(parts: &[&[u8]]) -> Vec<u8> {
            let mut digest = D::new();
            for part in parts {
                digest.update(part);
            }
            digest.finalize().to_vec()
        }
        match self {
            Hash::Sha1 => run::<sha1::Sha1>(parts),
            Hash::Sha256 => run::<sha2::Sha256>(parts),
            Hash::Sha384 => run::<sha2::Sha384>(parts),
            Hash::Sha512 => run::<sha2::Sha512>(parts),
        }
    }

    fn hmac(self, key: &[u8], data: &[u8]) -> Result<Vec<u8>, LockError> {
        use hmac::Mac;
        fn run<D>(key: &[u8], data: &[u8]) -> Result<Vec<u8>, LockError>
        where
            D: Digest + hmac::digest::core_api::BlockSizeUser + Clone,
            hmac::SimpleHmac<D>: Mac,
        {
            let mut mac = <hmac::SimpleHmac<D> as Mac>::new_from_slice(key).map_err(damaged)?;
            mac.update(data);
            Ok(mac.finalize().into_bytes().to_vec())
        }
        match self {
            Hash::Sha1 => run::<sha1::Sha1>(key, data),
            Hash::Sha256 => run::<sha2::Sha256>(key, data),
            Hash::Sha384 => run::<sha2::Sha384>(key, data),
            Hash::Sha512 => run::<sha2::Sha512>(key, data),
        }
    }
}

fn utf16(password: &str) -> Vec<u8> {
    password.encode_utf16().flat_map(u16::to_le_bytes).collect()
}

fn fit(mut bytes: Vec<u8>, len: usize, pad: u8) -> Vec<u8> {
    bytes.resize(len, pad);
    bytes
}

fn cbc_decrypt(key: &[u8], iv: &[u8], data: &[u8]) -> Result<Vec<u8>, LockError> {
    let len = data.len() - data.len() % 16;
    let mut buf = data[..len].to_vec();
    let iv = iv.get(..16).ok_or_else(|| damaged("an initialisation vector is too short"))?;
    let result = match key.len() {
        16 => cbc::Decryptor::<aes::Aes128>::new_from_slices(key, iv).map_err(damaged)?.decrypt_padded_mut::<NoPadding>(&mut buf).map(|_| ()),
        24 => cbc::Decryptor::<aes::Aes192>::new_from_slices(key, iv).map_err(damaged)?.decrypt_padded_mut::<NoPadding>(&mut buf).map(|_| ()),
        32 => cbc::Decryptor::<aes::Aes256>::new_from_slices(key, iv).map_err(damaged)?.decrypt_padded_mut::<NoPadding>(&mut buf).map(|_| ()),
        other => return Err(LockError::Unsupported(format!("a {}-bit key", other * 8))),
    };
    result.map_err(|_| damaged("a block is cut short"))?;
    Ok(buf)
}

fn cbc_encrypt(key: &[u8], iv: &[u8], data: &[u8]) -> Result<Vec<u8>, LockError> {
    let len = data.len().div_ceil(16) * 16;
    let mut buf = data.to_vec();
    buf.resize(len, 0);
    cbc::Encryptor::<aes::Aes256>::new_from_slices(key, &iv[..16])
        .map_err(damaged)?
        .encrypt_padded_mut::<NoPadding>(&mut buf, len)
        .map_err(|_| damaged("a block is cut short"))?;
    Ok(buf)
}

fn ecb_decrypt(key: &[u8], data: &[u8]) -> Result<Vec<u8>, LockError> {
    let mut out = data[..data.len() - data.len() % 16].to_vec();
    macro_rules! each {
        ($cipher:ty) => {{
            let cipher = <$cipher>::new_from_slice(key).map_err(damaged)?;
            for block in out.chunks_mut(16) {
                cipher.decrypt_block(aes::Block::from_mut_slice(block));
            }
        }};
    }
    match key.len() {
        16 => each!(aes::Aes128),
        24 => each!(aes::Aes192),
        32 => each!(aes::Aes256),
        other => return Err(LockError::Unsupported(format!("a {}-bit key", other * 8))),
    }
    Ok(out)
}

fn stream(file: &mut cfb::CompoundFile<Cursor<&[u8]>>, path: &str) -> Result<Vec<u8>, LockError> {
    let mut data = Vec::new();
    file.open_stream(path).map_err(damaged)?.read_to_end(&mut data).map_err(damaged)?;
    Ok(data)
}

/// The package inside a protected Office file, as a ZIP.
pub fn decrypt(bytes: &[u8], password: &str) -> Result<Vec<u8>, LockError> {
    let mut file = cfb::CompoundFile::open(Cursor::new(bytes)).map_err(damaged)?;
    let info = stream(&mut file, "/EncryptionInfo")?;
    let package = stream(&mut file, "/EncryptedPackage")?;
    if info.len() < 8 || package.len() < 8 {
        return Err(damaged("the encryption header is cut short"));
    }
    let major = u16::from_le_bytes([info[0], info[1]]);
    let minor = u16::from_le_bytes([info[2], info[3]]);
    match (major, minor) {
        (4, 4) => agile_decrypt(&info[8..], &package, password),
        (2..=4, 2) => standard_decrypt(&info, &package, password),
        _ => Err(LockError::Unsupported(format!("Office encryption version {major}.{minor}"))),
    }
}

fn declared_size(package: &[u8]) -> Result<usize, LockError> {
    let size = u64::from_le_bytes(package[..8].try_into().expect("eight bytes"));
    if size > crate::zip::MAX_TOTAL || size as usize > package.len() - 8 {
        return Err(damaged("the package is not the size it says"));
    }
    Ok(size as usize)
}

fn agile_decrypt(xml: &[u8], package: &[u8], password: &str) -> Result<Vec<u8>, LockError> {
    let xml = String::from_utf8_lossy(xml);
    let (_, key_data) = element(&xml, 0, "keyData").ok_or_else(|| damaged("no keyData"))?;
    let (_, encrypted_key) = element(&xml, 0, "encryptedKey").ok_or_else(|| damaged("no password key"))?;
    let need = |attrs: &[(String, String)], name: &str| get(attrs, name).map(str::to_string).ok_or_else(|| damaged(format!("no {name}")));
    let number = |attrs: &[(String, String)], name: &str| need(attrs, name)?.parse::<u32>().map_err(|_| damaged(format!("{name} is not a number")));

    for attrs in [&key_data, &encrypted_key] {
        if need(attrs, "cipherAlgorithm")? != "AES" || need(attrs, "cipherChaining")? != "ChainingModeCBC" {
            return Err(LockError::Unsupported("a cipher other than AES-CBC".to_string()));
        }
    }
    let data_hash = Hash::from_name(&need(&key_data, "hashAlgorithm")?)?;
    let data_salt = base64(&need(&key_data, "saltValue")?)?;
    let block = number(&key_data, "blockSize")? as usize;
    let key_hash = Hash::from_name(&need(&encrypted_key, "hashAlgorithm")?)?;
    let spin = number(&encrypted_key, "spinCount")?;
    let key_bytes = number(&encrypted_key, "keyBits")? as usize / 8;
    let salt = base64(&need(&encrypted_key, "saltValue")?)?;
    if spin > MAX_SPIN_COUNT || !matches!(key_bytes, 16 | 24 | 32) || block != 16 {
        return Err(LockError::Unsupported("key settings out of range".to_string()));
    }

    let mut h = key_hash.of(&[&salt, &utf16(password)]);
    for i in 0..spin {
        h = key_hash.of(&[&i.to_le_bytes(), &h]);
    }
    let derive = |block_key: &[u8]| fit(key_hash.of(&[&h, block_key]), key_bytes, 0x36);

    let input = cbc_decrypt(&derive(&BLOCK_VERIFIER_INPUT), &salt, &base64(&need(&encrypted_key, "encryptedVerifierHashInput")?)?)?;
    let value = cbc_decrypt(&derive(&BLOCK_VERIFIER_VALUE), &salt, &base64(&need(&encrypted_key, "encryptedVerifierHashValue")?)?)?;
    let expected = key_hash.of(&[&input]);
    if value.get(..expected.len()) != Some(&expected[..]) {
        return Err(LockError::WrongPassword);
    }
    let secret = cbc_decrypt(&derive(&BLOCK_KEY), &salt, &base64(&need(&encrypted_key, "encryptedKeyValue")?)?)?;
    let secret = secret.get(..key_bytes).ok_or_else(|| damaged("the key is cut short"))?;

    // The integrity check, when the file has one, catches a package changed after it was sealed.
    if let Some((_, integrity)) = element(&xml, 0, "dataIntegrity") {
        let iv_key = data_hash.of(&[&data_salt, &BLOCK_HMAC_KEY]);
        let iv_value = data_hash.of(&[&data_salt, &BLOCK_HMAC_VALUE]);
        let size = data_hash.of(&[]).len();
        let hmac_key = cbc_decrypt(secret, &iv_key, &base64(&need(&integrity, "encryptedHmacKey")?)?)?;
        let hmac_value = cbc_decrypt(secret, &iv_value, &base64(&need(&integrity, "encryptedHmacValue")?)?)?;
        let computed = data_hash.hmac(hmac_key.get(..size).ok_or_else(|| damaged("the integrity key is cut short"))?, package)?;
        if hmac_value.get(..size) != Some(&computed[..]) {
            return Err(damaged("the package was changed after it was sealed"));
        }
    }

    let size = declared_size(package)?;
    let mut out = Vec::with_capacity(size);
    for (i, segment) in package[8..].chunks(SEGMENT).enumerate() {
        let iv = data_hash.of(&[&data_salt, &(i as u32).to_le_bytes()]);
        out.extend(cbc_decrypt(secret, &iv, segment)?);
        if out.len() >= size {
            break;
        }
    }
    out.truncate(size);
    Ok(out)
}

/// Office 2007's Standard Encryption: AES in ECB mode, SHA-1 with 50,000 rounds.
fn standard_decrypt(info: &[u8], package: &[u8], password: &str) -> Result<Vec<u8>, LockError> {
    let u32_at = |at: usize| -> Result<usize, LockError> {
        info.get(at..at + 4).map(|b| u32::from_le_bytes(b.try_into().expect("four bytes")) as usize).ok_or_else(|| damaged("the encryption header is cut short"))
    };
    let header_size = u32_at(8)?;
    let header = info.get(12..12 + header_size).ok_or_else(|| damaged("the encryption header is cut short"))?;
    let algorithm = u32::from_le_bytes(header.get(8..12).ok_or_else(|| damaged("no algorithm"))?.try_into().expect("four bytes"));
    let key_bits = u32::from_le_bytes(header.get(16..20).ok_or_else(|| damaged("no key size"))?.try_into().expect("four bytes")) as usize;
    if !(0x660E..=0x6610).contains(&algorithm) || !matches!(key_bits, 128 | 192 | 256) {
        return Err(LockError::Unsupported("RC4 or another cipher older than AES".to_string()));
    }
    let verifier = info.get(12 + header_size..).ok_or_else(|| damaged("no verifier"))?;
    let salt_size = verifier.get(..4).map(|b| u32::from_le_bytes(b.try_into().expect("four bytes")) as usize).ok_or_else(|| damaged("no salt"))?;
    let get = |from: usize, len: usize| verifier.get(from..from + len).ok_or_else(|| damaged("the verifier is cut short"));
    let salt = get(4, salt_size)?;
    let encrypted_verifier = get(4 + salt_size, 16)?;
    let hash_size = u32::from_le_bytes(get(20 + salt_size, 4)?.try_into().expect("four bytes")) as usize;
    let encrypted_hash = get(24 + salt_size, 32)?;

    let mut h = Hash::Sha1.of(&[salt, &utf16(password)]);
    for i in 0u32..50_000 {
        h = Hash::Sha1.of(&[&i.to_le_bytes(), &h]);
    }
    let h = Hash::Sha1.of(&[&h, &0u32.to_le_bytes()]);
    let mut inner = [0x36u8; 64];
    let mut outer = [0x5cu8; 64];
    for (i, byte) in h.iter().enumerate() {
        inner[i] ^= byte;
        outer[i] ^= byte;
    }
    let mut derived = Hash::Sha1.of(&[&inner]);
    derived.extend(Hash::Sha1.of(&[&outer]));
    let key = &derived[..key_bits / 8];

    let plain_verifier = ecb_decrypt(key, encrypted_verifier)?;
    let plain_hash = ecb_decrypt(key, encrypted_hash)?;
    if plain_hash.get(..hash_size) != Some(&Hash::Sha1.of(&[&plain_verifier])[..]) {
        return Err(LockError::WrongPassword);
    }
    let size = declared_size(package)?;
    let mut out = ecb_decrypt(key, &package[8..])?;
    out.truncate(size);
    Ok(out)
}

/// A length-prefixed UTF-16 string, padded to four bytes, as the data spaces write them.
fn prefixed(text: &str) -> Vec<u8> {
    let bytes = utf16(text);
    let mut out = (bytes.len() as u32).to_le_bytes().to_vec();
    out.extend(&bytes);
    out.resize(out.len().div_ceil(4) * 4, 0);
    out
}

fn versions() -> Vec<u8> {
    [1u16, 0, 1, 0, 1, 0].iter().flat_map(|v| v.to_le_bytes()).collect()
}

/// The data spaces that tell Office the package is encrypted ([MS-OFFCRYPTO] 2.1).
fn data_spaces() -> Vec<(&'static str, Vec<u8>)> {
    let mut version = prefixed("Microsoft.Container.DataSpaces");
    version.extend(versions());

    let mut entry = 1u32.to_le_bytes().to_vec();
    entry.extend(0u32.to_le_bytes());
    entry.extend(prefixed("EncryptedPackage"));
    entry.extend(prefixed("StrongEncryptionDataSpace"));
    let mut map = 8u32.to_le_bytes().to_vec();
    map.extend(1u32.to_le_bytes());
    map.extend(((entry.len() + 4) as u32).to_le_bytes());
    map.extend(entry);

    let mut definition = 8u32.to_le_bytes().to_vec();
    definition.extend(1u32.to_le_bytes());
    definition.extend(prefixed("StrongEncryptionTransform"));

    let id = prefixed("{FF9A3F03-56EF-4613-BDD5-5A41C1D07246}");
    let mut header = 1u32.to_le_bytes().to_vec();
    header.extend(&id);
    let mut primary = ((header.len() + 4) as u32).to_le_bytes().to_vec();
    primary.extend(header);
    primary.extend(prefixed("Microsoft.Container.EncryptionTransform"));
    primary.extend(versions());
    primary.extend(prefixed(""));
    primary.extend([0u8; 8]);
    primary.extend(4u32.to_le_bytes());

    vec![
        ("/\u{6}DataSpaces/Version", version),
        ("/\u{6}DataSpaces/DataSpaceMap", map),
        ("/\u{6}DataSpaces/DataSpaceInfo/StrongEncryptionDataSpace", definition),
        ("/\u{6}DataSpaces/TransformInfo/StrongEncryptionTransform/\u{6}Primary", primary),
    ]
}

/// Seals a ZIP package as Office 2010 and later does: Agile Encryption with AES-256 and SHA-512.
pub fn encrypt(zip: &[u8], password: &str) -> Result<Vec<u8>, LockError> {
    let hash = Hash::Sha512;
    let secret = random(32)?;
    let data_salt = random(16)?;
    let salt = random(16)?;

    let mut package = (zip.len() as u64).to_le_bytes().to_vec();
    for (i, segment) in zip.chunks(SEGMENT).enumerate() {
        let iv = hash.of(&[&data_salt, &(i as u32).to_le_bytes()]);
        package.extend(cbc_encrypt(&secret, &iv, segment)?);
    }

    let mut h = hash.of(&[&salt, &utf16(password)]);
    for i in 0..SPIN_COUNT {
        h = hash.of(&[&i.to_le_bytes(), &h]);
    }
    let derive = |block_key: &[u8]| fit(hash.of(&[&h, block_key]), 32, 0x36);
    let input = random(16)?;
    let encrypted_input = cbc_encrypt(&derive(&BLOCK_VERIFIER_INPUT), &salt, &input)?;
    let encrypted_value = cbc_encrypt(&derive(&BLOCK_VERIFIER_VALUE), &salt, &hash.of(&[&input]))?;
    let encrypted_key = cbc_encrypt(&derive(&BLOCK_KEY), &salt, &secret)?;

    let hmac_key = random(64)?;
    let hmac_value = hash.hmac(&hmac_key, &package)?;
    let encrypted_hmac_key = cbc_encrypt(&secret, &hash.of(&[&data_salt, &BLOCK_HMAC_KEY]), &hmac_key)?;
    let encrypted_hmac_value = cbc_encrypt(&secret, &hash.of(&[&data_salt, &BLOCK_HMAC_VALUE]), &hmac_value)?;

    let common = r#"saltSize="16" blockSize="16" keyBits="256" hashSize="64" cipherAlgorithm="AES" cipherChaining="ChainingModeCBC" hashAlgorithm="SHA512""#;
    let xml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n\
         <encryption xmlns=\"http://schemas.microsoft.com/office/2006/encryption\" \
         xmlns:p=\"http://schemas.microsoft.com/office/2006/keyEncryptor/password\" \
         xmlns:c=\"http://schemas.microsoft.com/office/2006/keyEncryptor/certificate\">\
         <keyData {common} saltValue=\"{}\"/>\
         <dataIntegrity encryptedHmacKey=\"{}\" encryptedHmacValue=\"{}\"/>\
         <keyEncryptors><keyEncryptor uri=\"http://schemas.microsoft.com/office/2006/keyEncryptor/password\">\
         <p:encryptedKey spinCount=\"{SPIN_COUNT}\" {common} saltValue=\"{}\" encryptedVerifierHashInput=\"{}\" \
         encryptedVerifierHashValue=\"{}\" encryptedKeyValue=\"{}\"/>\
         </keyEncryptor></keyEncryptors></encryption>",
        to_base64(&data_salt),
        to_base64(&encrypted_hmac_key),
        to_base64(&encrypted_hmac_value),
        to_base64(&salt),
        to_base64(&encrypted_input),
        to_base64(&encrypted_value),
        to_base64(&encrypted_key),
    );
    let mut info = vec![4, 0, 4, 0, 0x40, 0, 0, 0];
    info.extend(xml.as_bytes());

    // Version 3, with 512-byte sectors, is what Office writes; LibreOffice refuses version 4 here.
    let mut file = cfb::CompoundFile::create_with_version(cfb::Version::V3, Cursor::new(Vec::new())).map_err(damaged)?;
    for storage in [
        "/\u{6}DataSpaces",
        "/\u{6}DataSpaces/DataSpaceInfo",
        "/\u{6}DataSpaces/TransformInfo",
        "/\u{6}DataSpaces/TransformInfo/StrongEncryptionTransform",
    ] {
        file.create_storage(storage).map_err(damaged)?;
    }
    for (path, data) in data_spaces() {
        file.create_stream(path).map_err(damaged)?.write_all(&data).map_err(damaged)?;
    }
    file.create_stream("/EncryptionInfo").map_err(damaged)?.write_all(&info).map_err(damaged)?;
    file.create_stream("/EncryptedPackage").map_err(damaged)?.write_all(&package).map_err(damaged)?;
    file.flush().map_err(damaged)?;
    Ok(file.into_inner().into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_data_spaces_are_the_sizes_office_writes() {
        let sizes: Vec<usize> = data_spaces().iter().map(|(_, data)| data.len()).collect();
        assert_eq!(sizes, vec![76, 112, 64, 200]);
    }

    #[test]
    fn a_sealed_package_opens_with_its_password_and_not_without() {
        let zip = b"PK\x05\x06 a stand-in for a package, long enough to cross a segment".repeat(200);
        let sealed = encrypt(&zip, "pässwörd 1").unwrap();
        assert!(is_protected(&sealed));
        assert_eq!(decrypt(&sealed, "pässwörd 1").unwrap(), zip);
        assert_eq!(decrypt(&sealed, "password 1"), Err(LockError::WrongPassword));
    }

    #[test]
    fn a_changed_package_is_caught() {
        let sealed = encrypt(&[7u8; 9000], "secret").unwrap();
        let mut file = cfb::CompoundFile::open(Cursor::new(sealed.clone())).unwrap();
        let mut package = Vec::new();
        file.open_stream("/EncryptedPackage").unwrap().read_to_end(&mut package).unwrap();
        let at = sealed.windows(64).position(|w| w == &package[100..164]).unwrap();
        let mut changed = sealed;
        changed[at + 10] ^= 1;
        assert!(matches!(decrypt(&changed, "secret"), Err(LockError::Damaged(_))));
    }
}
