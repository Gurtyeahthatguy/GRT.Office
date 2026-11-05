//! The attributes of an element in a small XML text, found by local names.

/// The attributes of the first element whose local name is `element`, from `from` on.
pub fn element(xml: &str, from: usize, element: &str) -> Option<(usize, Vec<(String, String)>)> {
    let mut at = from;
    while let Some(found) = xml[at..].find('<') {
        let start = at + found + 1;
        let rest = &xml[start..];
        let name_end = rest.find(|c: char| c.is_whitespace() || c == '>' || c == '/').unwrap_or(rest.len());
        let name = &rest[..name_end];
        let local = name.rsplit(':').next().unwrap_or(name);
        if local == element && !name.starts_with('/') {
            let end = start + rest.find('>')?;
            return Some((end, attributes(&xml[start + name_end..end])));
        }
        at = start;
    }
    None
}

/// Every element with a local name, in order.
pub fn elements(xml: &str, element_name: &str) -> Vec<Vec<(String, String)>> {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some((end, attrs)) = element(xml, at, element_name) {
        out.push(attrs);
        at = end;
    }
    out
}

fn attributes(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(eq) = rest.find('=') {
        let name = rest[..eq].trim().trim_end_matches('/').trim();
        let after = rest[eq + 1..].trim_start();
        let Some(quote) = after.chars().next().filter(|c| *c == '"' || *c == '\'') else { break };
        let Some(close) = after[1..].find(quote) else { break };
        let value = &after[1..1 + close];
        out.push((name.to_string(), unescape(value)));
        rest = &after[close + 2..];
    }
    out
}

fn unescape(text: &str) -> String {
    text.replace("&quot;", "\"").replace("&apos;", "'").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

/// An attribute by local name.
pub fn get<'a>(attrs: &'a [(String, String)], name: &str) -> Option<&'a str> {
    attrs
        .iter()
        .find(|(key, _)| key.rsplit(':').next() == Some(name))
        .map(|(_, value)| value.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_an_element_by_local_name_whatever_its_prefix() {
        let xml = r#"<a><p:encryptedKey spinCount="100000" saltValue='c2FsdA=='/><keyData x="1"/></a>"#;
        let (_, attrs) = element(xml, 0, "encryptedKey").unwrap();
        assert_eq!(get(&attrs, "spinCount"), Some("100000"));
        assert_eq!(get(&attrs, "saltValue"), Some("c2FsdA=="));
        assert!(element(xml, 0, "missing").is_none());
    }

    #[test]
    fn lists_every_element_of_a_name() {
        let xml = r#"<m><manifest:file-entry manifest:full-path="a"/><manifest:file-entry manifest:full-path="b &amp; c"/></m>"#;
        let all = elements(xml, "file-entry");
        assert_eq!(all.len(), 2);
        assert_eq!(get(&all[1], "full-path"), Some("b & c"));
    }
}
