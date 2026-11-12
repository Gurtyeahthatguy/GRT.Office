//! Writing tools that read dictionaries: synonyms from MyThes files, hyphenation patterns, and Hanja for Hangul.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde_json::{json, Value};

use crate::gz;

const THES_IT: &[u8] = include_bytes!("../../dictionaries/th_it_IT_v2.dat.gz");
const THES_EN: &[u8] = include_bytes!("../../dictionaries/th_en_US_v2.dat.gz");
const HYPH_IT: &str = include_str!("../../dictionaries/hyph_it_IT.dic");
const HYPH_EN: &[u8] = include_bytes!("../../dictionaries/hyph_en_US.dic.gz");
const HANJA: &[u8] = include_bytes!("../../dictionaries/hanja.txt.gz");

/// The most meanings and words given back for one look-up.
const MAX_MEANINGS: usize = 40;
const MAX_WORD: usize = 100;

fn language(lang: &str) -> Option<&'static str> {
    match lang.split(['-', '_']).next()?.to_ascii_lowercase().as_str() {
        "it" => Some("it"),
        "en" => Some("en"),
        _ => None,
    }
}

/// A MyThes file: its text, and where each word's meanings start, by the word in lower case.
pub struct Thesaurus {
    text: String,
    index: HashMap<String, (usize, usize)>,
}

impl Thesaurus {
    pub fn parse(text: String) -> Thesaurus {
        let mut index = HashMap::new();
        let mut at = 0;
        let mut lines = text.split_inclusive('\n');
        // The first line names the encoding; only UTF-8 files are built in.
        if let Some(first) = lines.next() {
            at += first.len();
        }
        let mut pending: Option<(String, usize, usize)> = None;
        for line in lines {
            at += line.len();
            if let Some((word, from, left)) = pending.take() {
                if left > 1 {
                    pending = Some((word, from, left - 1));
                } else {
                    index.entry(word).or_insert((from, at));
                }
                continue;
            }
            let entry = line.trim_end();
            if let Some((word, count)) = entry.rsplit_once('|') {
                if let Ok(count) = count.parse::<usize>() {
                    if count > 0 && count < 1000 {
                        pending = Some((word.to_lowercase(), at, count));
                    }
                }
            }
        }
        Thesaurus { text, index }
    }

    /// The meanings of a word: each with its part of speech and its words, the notes in brackets kept.
    pub fn lookup(&self, word: &str) -> Vec<Value> {
        let word = word.trim().to_lowercase();
        if word.is_empty() || word.chars().count() > MAX_WORD {
            return Vec::new();
        }
        let Some(&(from, to)) = self.index.get(&word) else { return Vec::new() };
        self.text[from..to]
            .lines()
            .take(MAX_MEANINGS)
            .filter_map(|line| {
                let mut parts = line.split('|');
                let pos = parts.next()?.trim().trim_start_matches('(').trim_end_matches(')').to_string();
                let words: Vec<String> = parts.map(|w| w.trim().to_string()).filter(|w| !w.is_empty()).take(60).collect();
                (!words.is_empty()).then(|| json!({ "pos": if pos == "-" { String::new() } else { pos }, "words": words }))
            })
            .collect()
    }
}

fn thesaurus(name: &str) -> Result<&'static Thesaurus, String> {
    static IT: OnceLock<Result<Thesaurus, String>> = OnceLock::new();
    static EN: OnceLock<Result<Thesaurus, String>> = OnceLock::new();
    let (cell, bytes) = match name {
        "it" => (&IT, THES_IT),
        "en" => (&EN, THES_EN),
        _ => return Err("No synonyms for that language".to_string()),
    };
    cell.get_or_init(|| gz::text(bytes).map(Thesaurus::parse)).as_ref().map_err(Clone::clone)
}

/// Hangul words and the Hanja they are written with, both ways.
pub struct Hanja {
    by_hangul: HashMap<String, Vec<(String, String)>>,
    by_hanja: HashMap<String, Vec<String>>,
}

impl Hanja {
    pub fn parse(text: &str) -> Hanja {
        let mut by_hangul: HashMap<String, Vec<(String, String)>> = HashMap::new();
        let mut by_hanja: HashMap<String, Vec<String>> = HashMap::new();
        for line in text.lines().filter(|l| !l.starts_with('#')) {
            let mut parts = line.splitn(3, ':');
            let (Some(hangul), Some(hanja)) = (parts.next(), parts.next()) else { continue };
            if hangul.is_empty() || hanja.is_empty() || hangul == hanja {
                continue;
            }
            let meaning = parts.next().unwrap_or("").to_string();
            by_hangul.entry(hangul.to_string()).or_default().push((hanja.to_string(), meaning));
            by_hanja.entry(hanja.to_string()).or_default().push(hangul.to_string());
        }
        Hanja { by_hangul, by_hanja }
    }

    /// The Hanja a Hangul word may be written with, most common first as the list gives them.
    pub fn hanja_for(&self, hangul: &str) -> Vec<Value> {
        self.by_hangul
            .get(hangul.trim())
            .map(|list| list.iter().take(MAX_MEANINGS).map(|(hanja, meaning)| json!({ "text": hanja, "meaning": meaning })).collect())
            .unwrap_or_default()
    }

    /// The Hangul a Hanja word is read as.
    pub fn hangul_for(&self, hanja: &str) -> Vec<Value> {
        self.by_hanja
            .get(hanja.trim())
            .map(|list| list.iter().take(MAX_MEANINGS).map(|hangul| json!({ "text": hangul, "meaning": "" })).collect())
            .unwrap_or_default()
    }

    /// The longest word in the list that starts `text`, in either script, so a sentence can be gone through word by word.
    pub fn longest_at(&self, text: &str, to_hanja: bool) -> usize {
        let chars: Vec<char> = text.chars().take(12).collect();
        for len in (1..=chars.len()).rev() {
            let piece: String = chars[..len].iter().collect();
            let known = if to_hanja { self.by_hangul.contains_key(&piece) } else { self.by_hanja.contains_key(&piece) };
            if known {
                return len;
            }
        }
        0
    }
}

fn hanja() -> Result<&'static Hanja, String> {
    static HANJA_LIST: OnceLock<Result<Hanja, String>> = OnceLock::new();
    HANJA_LIST.get_or_init(|| gz::text(HANJA).map(|t| Hanja::parse(&t))).as_ref().map_err(Clone::clone)
}

#[tauri::command(async)]
pub fn thesaurus_lookup(lang: String, word: String) -> Result<Vec<Value>, String> {
    let Some(name) = language(&lang) else { return Ok(Vec::new()) };
    Ok(thesaurus(name)?.lookup(&word))
}

/// The hyphenation patterns of a language, as the file holds them, for the page to apply.
#[tauri::command(async)]
pub fn hyphenation_patterns(lang: String) -> Result<Option<String>, String> {
    match language(&lang) {
        Some("it") => Ok(Some(HYPH_IT.to_string())),
        Some("en") => gz::text(HYPH_EN).map(Some),
        _ => Ok(None),
    }
}

/// The words of a stretch of Hangul or Hanja and what each may become, for the conversion dialog.
#[tauri::command(async)]
pub fn hanja_words(text: String, to_hanja: bool) -> Result<Vec<Value>, String> {
    let list = hanja()?;
    let mut out = Vec::new();
    let mut at = 0;
    let chars: Vec<char> = text.chars().take(20_000).collect();
    while at < chars.len() {
        let rest: String = chars[at..].iter().take(12).collect();
        let len = list.longest_at(&rest, to_hanja);
        if len == 0 {
            at += 1;
            continue;
        }
        let word: String = chars[at..at + len].iter().collect();
        let choices = if to_hanja { list.hanja_for(&word) } else { list.hangul_for(&word) };
        out.push(json!({ "from": at, "to": at + len, "word": word, "choices": choices }));
        at += len;
        if out.len() >= 2000 {
            break;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_synonyms_in_both_languages() {
        let it = thesaurus("it").unwrap().lookup("Casa");
        assert!(it.iter().any(|m| m["words"].as_array().unwrap().iter().any(|w| w == "abitazione")));
        let en = thesaurus("en").unwrap().lookup("happy");
        assert_eq!(en[0]["pos"], "adj");
        assert!(en[0]["words"].as_array().unwrap().iter().any(|w| w == "blissful (similar term)"));
        assert!(thesaurus("it").unwrap().lookup("parolachenonce").is_empty());
        assert!(thesaurus_lookup("de".into(), "Haus".into()).unwrap().is_empty());
    }

    #[test]
    fn reads_a_small_thesaurus_exactly() {
        let t = Thesaurus::parse("UTF-8\nuno|1\n(a)|primo|iniziale\ndue|2\n-|coppia\n(b)|paio\nrotto|abc\n".to_string());
        assert_eq!(t.lookup("uno"), vec![json!({ "pos": "a", "words": ["primo", "iniziale"] })]);
        assert_eq!(t.lookup("due"), vec![json!({ "pos": "", "words": ["coppia"] }), json!({ "pos": "b", "words": ["paio"] })]);
        assert!(t.lookup("rotto").is_empty());
    }

    #[test]
    fn gives_hyphenation_patterns() {
        assert!(hyphenation_patterns("it-IT".into()).unwrap().unwrap().starts_with("UTF-8"));
        assert!(hyphenation_patterns("en".into()).unwrap().unwrap().contains("LEFTHYPHENMIN"));
        assert_eq!(hyphenation_patterns("fr".into()).unwrap(), None);
    }

    #[test]
    fn goes_through_hangul_and_hanja_by_the_longest_word() {
        let words = hanja_words("한국 사람".into(), true).unwrap();
        assert_eq!(words[0]["word"], "한국");
        assert!(words[0]["choices"].as_array().unwrap().iter().any(|c| c["text"] == "韓國"));
        let back = hanja_words("韓國".into(), false).unwrap();
        assert!(back[0]["choices"].as_array().unwrap().iter().any(|c| c["text"] == "한국"));
        assert!(hanja_words("plain".into(), true).unwrap().is_empty());
    }
}
