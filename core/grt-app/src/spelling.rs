//! Spelling: Italian and English Hunspell dictionaries, read by spellbook, and the words the person adds.

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use spellbook::Dictionary;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::{gz, is_ephemeral, lock};

const ITALIAN: (&[u8], &[u8]) = (include_bytes!("../../dictionaries/it_IT.aff.gz"), include_bytes!("../../dictionaries/it_IT.dic.gz"));
const ENGLISH: (&[u8], &[u8]) = (include_bytes!("../../dictionaries/en_US.aff.gz"), include_bytes!("../../dictionaries/en_US.dic.gz"));

/// The most words one call checks, the longest word looked at, and the most words a person adds.
pub const MAX_WORDS: usize = 20_000;
pub const MAX_WORD: usize = 100;
pub const MAX_ADDED: usize = 20_000;

/// The dictionary a language tag uses: it-IT, it-CH and it all use the Italian one.
pub fn dictionary_for(lang: &str) -> Option<&'static str> {
    match lang.split(['-', '_']).next()?.to_ascii_lowercase().as_str() {
        "it" => Some("it"),
        "en" => Some("en"),
        _ => None,
    }
}

fn load(name: &str) -> Result<&'static Dictionary, String> {
    static IT: OnceLock<Result<Dictionary, String>> = OnceLock::new();
    static EN: OnceLock<Result<Dictionary, String>> = OnceLock::new();
    let (cell, (aff, dic)) = match name {
        "it" => (&IT, ITALIAN),
        "en" => (&EN, ENGLISH),
        _ => return Err("No dictionary for that language".to_string()),
    };
    cell.get_or_init(|| {
        let aff = gz::text(aff)?;
        let dic = gz::text(dic)?;
        Dictionary::new(&aff, &dic).map_err(|e| format!("A dictionary could not be read: {e}"))
    })
    .as_ref()
    .map_err(Clone::clone)
}

/// A word worth checking: letters, with apostrophes, hyphens and full stops inside; not too long.
fn checkable(word: &str) -> bool {
    !word.is_empty() && word.chars().count() <= MAX_WORD && word.chars().any(char::is_alphabetic) && !word.chars().any(|c| c.is_ascii_digit())
}

/// Whether each word is spelled right; words in no dictionary's language count as right.
pub fn check(lang: &str, words: &[String], added: &BTreeSet<String>) -> Result<Vec<bool>, String> {
    let Some(name) = dictionary_for(lang) else { return Ok(vec![true; words.len()]) };
    let dictionary = load(name)?;
    Ok(words
        .iter()
        .take(MAX_WORDS)
        .map(|word| {
            // A typographic apostrophe is the one the dictionaries write straight.
            let word = word.replace('\u{2019}', "'");
            !checkable(&word) || added.contains(&word) || added.contains(&word.to_lowercase()) || dictionary.check(&word)
        })
        .collect())
}

pub fn suggest(lang: &str, word: &str) -> Result<Vec<String>, String> {
    let Some(name) = dictionary_for(lang) else { return Ok(Vec::new()) };
    let word = word.replace('\u{2019}', "'");
    if !checkable(&word) {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    load(name)?.suggest(&word, &mut out);
    rank(&word, &mut out);
    // A word written with a typographic apostrophe gets suggestions written the same way.
    if word != word.replace('\'', "\u{2019}") {
        out = out.into_iter().map(|s| s.replace('\'', "\u{2019}")).collect();
    }
    out.truncate(10);
    Ok(out)
}

/// Edits between two words, a swap of neighbours counting as one, letter case aside.
fn distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.to_lowercase().chars().collect();
    let b: Vec<char> = b.to_lowercase().chars().collect();
    let mut rows = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for (i, row) in rows.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, cell) in rows[0].iter_mut().enumerate() {
        *cell = j;
    }
    for i in 1..=a.len() {
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut best = (rows[i - 1][j] + 1).min(rows[i][j - 1] + 1).min(rows[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                best = best.min(rows[i - 2][j - 2] + 1);
            }
            rows[i][j] = best;
        }
    }
    rows[a.len()][b.len()]
}

/// The nearest suggestions first; splitting a word in two counts as one more edit, and at the same distance
/// one that drops no letter comes first, since typing leaves letters out more than it adds them.
fn rank(word: &str, list: &mut [String]) {
    let length = word.chars().count();
    let splits = |s: &str| usize::from(s.contains([' ', '-']) && !word.contains([' ', '-']));
    list.sort_by_key(|s| (distance(word, s) + splits(s), usize::from(s.chars().count() < length)));
}

/// The words the person added, kept in the program's settings folder; in ephemeral mode, only for the session.
#[derive(Default)]
pub struct Spelling(Mutex<Option<BTreeSet<String>>>);

fn words_file<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    if is_ephemeral() {
        return None;
    }
    app.path().app_config_dir().ok().map(|dir| dir.join("added-words.txt"))
}

fn clean_word(word: &str) -> Option<String> {
    let word = word.trim().replace('\u{2019}', "'");
    (checkable(&word) && !word.contains(char::is_whitespace)).then_some(word)
}

fn added<'a, R: Runtime>(app: &AppHandle<R>, state: &'a State<'_, Spelling>) -> std::sync::MutexGuard<'a, Option<BTreeSet<String>>> {
    let mut held = lock(&state.0);
    if held.is_none() {
        let words = words_file(app)
            .and_then(|file| fs::read_to_string(file).ok())
            .map(|text| text.lines().filter_map(clean_word).take(MAX_ADDED).collect())
            .unwrap_or_default();
        *held = Some(words);
    }
    held
}

fn store<R: Runtime>(app: &AppHandle<R>, words: &BTreeSet<String>) -> Result<(), String> {
    let Some(file) = words_file(app) else { return Ok(()) };
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Cannot keep the added words: {e}"))?;
    }
    let text: String = words.iter().map(|w| format!("{w}\n")).collect();
    crate::package::write_atomically(&file, text.as_bytes()).map_err(|e| format!("Cannot keep the added words: {e}"))
}

#[tauri::command(async)]
pub fn spell_check<R: Runtime>(app: AppHandle<R>, state: State<'_, Spelling>, lang: String, words: Vec<String>) -> Result<Vec<bool>, String> {
    let held = added(&app, &state);
    check(&lang, &words, held.as_ref().ok_or("No word list")?)
}

#[tauri::command(async)]
pub fn spell_suggest(lang: String, word: String) -> Result<Vec<String>, String> {
    suggest(&lang, &word)
}

/// The languages there is a dictionary for, as tags.
#[tauri::command]
pub fn spell_languages() -> Vec<&'static str> {
    vec!["it", "en"]
}

#[tauri::command]
pub fn spell_added<R: Runtime>(app: AppHandle<R>, state: State<'_, Spelling>) -> Vec<String> {
    added(&app, &state).as_ref().map(|w| w.iter().cloned().collect()).unwrap_or_default()
}

#[tauri::command]
pub fn spell_add<R: Runtime>(app: AppHandle<R>, state: State<'_, Spelling>, word: String) -> Result<(), String> {
    let word = clean_word(&word).ok_or("That is not a word to add")?;
    let mut held = added(&app, &state);
    let words = held.as_mut().ok_or("No word list")?;
    if words.len() >= MAX_ADDED {
        return Err("The list of added words is full".to_string());
    }
    words.insert(word);
    store(&app, words)
}

#[tauri::command]
pub fn spell_remove<R: Runtime>(app: AppHandle<R>, state: State<'_, Spelling>, word: String) -> Result<(), String> {
    let mut held = added(&app, &state);
    let words = held.as_mut().ok_or("No word list")?;
    words.remove(word.trim());
    store(&app, words)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(list: &[&str]) -> Vec<String> {
        list.iter().map(|w| w.to_string()).collect()
    }

    #[test]
    fn checks_italian_and_english_and_leaves_other_languages() {
        let none = BTreeSet::new();
        assert_eq!(check("it-IT", &words(&["perché", "perchè", "dell’albero", "Bologna", "2026", "qzx"]), &none).unwrap(), vec![true, false, true, true, true, false]);
        assert_eq!(check("en-GB", &words(&["receive", "recieve", "don’t"]), &none).unwrap(), vec![true, false, true]);
        assert_eq!(check("fr-FR", &words(&["bonjourr"]), &none).unwrap(), vec![true]);
        assert_eq!(check("it", &words(&[&"a".repeat(200)]), &none).unwrap(), vec![true]);
    }

    #[test]
    fn added_words_count_as_right() {
        let mut list = BTreeSet::new();
        list.insert("Bolognina".to_string());
        list.insert("grt".to_string());
        assert_eq!(check("it", &words(&["Bolognina", "Grt", "Bologninaa"]), &list).unwrap(), vec![true, true, false]);
        assert_eq!(clean_word("  due parole "), None);
        assert_eq!(clean_word("l’altro"), Some("l'altro".to_string()));
    }

    #[test]
    fn puts_the_nearest_suggestion_first() {
        assert_eq!(distance("erore", "errore"), 1);
        assert_eq!(distance("teh", "the"), 1);
        assert_eq!(suggest("it", "erore").unwrap().first().map(String::as_str), Some("errore"));
        assert_eq!(suggest("it", "sbagliatta").unwrap().first().map(String::as_str), Some("sbagliata"));
        assert_eq!(suggest("en", "recive").unwrap().first().map(String::as_str), Some("receive"));
    }

    #[test]
    fn suggests_and_keeps_the_apostrophe_it_was_given() {
        assert_eq!(suggest("it", "perchè").unwrap().first().map(String::as_str), Some("perché"));
        assert!(suggest("en", "recieve").unwrap().contains(&"receive".to_string()));
        assert!(suggest("it", "qual’è").unwrap().iter().all(|s| !s.contains('\'')));
        assert!(suggest("de", "Hallo").unwrap().is_empty());
    }
}
