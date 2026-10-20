//! How `SearchCards` orders a workspace's cards: meaning and words, fused.
//!
//! Meaning alone (a cosine against each card's embedded passage) finds a
//! card from a paraphrase but blurs short queries -- "kimi", "restart
//! daemon" -- into everything about agents or daemons. Words alone (BM25)
//! is the reverse. Measured on this repo's cards with the labelled queries
//! in `test-fixtures/card-search/queries.json`, meaning alone put the card
//! a query meant first for 28 of 40 queries (MRR 0.815); fusing the two by
//! reciprocal rank, meaning weighted 2:1, put it first for 32 (MRR 0.885)
//! and in the top ten for all 40. Equal weights and 3:1 were measured too;
//! 3:1 was a query better on that set and 2:1 kept, because an agent's
//! real queries are shorter and wordier than the paraphrases it holds.
//!
//! Pure functions over text, so the ranking is tested without a model.

use std::collections::HashMap;

/// Reciprocal-rank fusion's constant: how flat the bonus for rank is.
/// 60 is the value the method was published with, and the one measured.
const RRF_K: f32 = 60.0;
const MEANING_WEIGHT: f32 = 2.0;
const WORDS_WEIGHT: f32 = 1.0;

/// How many times a card's title and file name count against its body:
/// a word in the title says more about what a card is than the same word
/// in its notes.
const TITLE_REPEATS: usize = 3;

/// BM25's usual constants.
const K1: f32 = 1.2;
const B: f32 = 0.75;

/// Words too common to say what a card is about. A query in someone's own
/// words is full of them, and BM25 would otherwise reward the longest
/// card for repeating them.
const STOP_WORDS: &[&str] = &[
    "the", "to", "of", "and", "in", "on", "it", "is", "for", "an", "that", "when", "with", "its", "by", "be",
    "as", "at", "or", "from", "this", "not", "no", "every", "each", "how", "so", "what", "does", "do", "there",
    "into", "but", "are", "was", "has", "have", "can", "one", "all", "only",
];

/// A card's body without what gavin writes into every card it touches:
/// the auto-commit instructions (`app/src/lib/git/autoCommit.ts`) and any
/// other HTML comment. On this repo a third of the cards carry the same
/// auto-commit paragraph, which is words about committing in cards that
/// are about anything but.
pub fn strip_boilerplate(body: &str) -> String {
    const OPEN: &str = "<!-- gavin:auto-commit -->";
    const CLOSE: &str = "<!-- /gavin:auto-commit -->";
    let mut text = body.to_string();
    while let (Some(start), Some(end)) = (text.find(OPEN), text.find(CLOSE)) {
        if end < start {
            break;
        }
        text.replace_range(start..end + CLOSE.len(), "");
    }
    while let Some(start) = text.find("<!--") {
        let Some(len) = text[start..].find("-->") else { break };
        text.replace_range(start..start + len + 3, "");
    }
    text
}

/// Lowercased words of two or more letters, split on anything that is
/// not a letter or digit, with a trailing plural `s` dropped so "rails"
/// finds "rail".
pub fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() > 1)
        .map(|w| match w.strip_suffix('s') {
            Some(stem) if stem.chars().count() > 2 => stem.to_string(),
            _ => w.to_string(),
        })
        .collect()
}

/// What BM25 reads for one card: its title and file name, repeated, then
/// its body without the boilerplate.
pub fn lexical_text(title: &str, file_name: &str, body: &str) -> String {
    let heading = format!("{title} {} ", file_name.trim_end_matches(".md"));
    format!("{}{}", heading.repeat(TITLE_REPEATS), strip_boilerplate(body))
}

/// BM25 of `query` against each of `docs`, in order. Zero for a document
/// that shares no word with it.
pub fn bm25(query: &str, docs: &[String]) -> Vec<f32> {
    let docs: Vec<Vec<String>> = docs.iter().map(|d| words(d)).collect();
    let n = docs.len() as f32;
    if docs.is_empty() {
        return Vec::new();
    }
    let avg_len = docs.iter().map(Vec::len).sum::<usize>() as f32 / n;
    let mut terms: Vec<String> = words(query).into_iter().filter(|w| !STOP_WORDS.contains(&w.as_str())).collect();
    terms.sort();
    terms.dedup();
    let counts: Vec<HashMap<&str, f32>> = docs
        .iter()
        .map(|d| {
            let mut tf: HashMap<&str, f32> = HashMap::new();
            for w in d.iter().filter(|w| terms.contains(w)) {
                *tf.entry(w.as_str()).or_default() += 1.0;
            }
            tf
        })
        .collect();
    let idf: HashMap<&str, f32> = terms
        .iter()
        .map(|t| {
            let df = counts.iter().filter(|c| c.contains_key(t.as_str())).count() as f32;
            (t.as_str(), ((n - df + 0.5) / (df + 0.5) + 1.0).ln())
        })
        .collect();
    docs.iter()
        .zip(&counts)
        .map(|(doc, tf)| {
            let norm = K1 * (1.0 - B + B * doc.len() as f32 / avg_len.max(1.0));
            tf.iter().map(|(t, f)| idf[t] * f * (K1 + 1.0) / (f + norm)).sum()
        })
        .collect()
}

/// 1-based rank of each score, best first. Ties keep their input order.
fn ranks(scores: &[f32]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..scores.len()).collect();
    order.sort_by(|&a, &b| scores[b].total_cmp(&scores[a]));
    let mut rank = vec![0; scores.len()];
    for (position, &i) in order.iter().enumerate() {
        rank[i] = position + 1;
    }
    rank
}

/// The order to return cards in, best first, given each card's cosine to
/// the query and its BM25. A card sharing no word with the query gets
/// nothing from the words side -- its rank there would be an accident of
/// the order the cards were read in.
pub fn fuse(meaning: &[f32], lexical: &[f32]) -> Vec<usize> {
    let meaning_rank = ranks(meaning);
    let lexical_rank = ranks(lexical);
    let fused: Vec<f32> = (0..meaning.len())
        .map(|i| {
            let words = if lexical[i] > 0.0 { WORDS_WEIGHT / (RRF_K + lexical_rank[i] as f32) } else { 0.0 };
            MEANING_WEIGHT / (RRF_K + meaning_rank[i] as f32) + words
        })
        .collect();
    let mut order: Vec<usize> = (0..meaning.len()).collect();
    order.sort_by(|&a, &b| fused[b].total_cmp(&fused[a]).then(meaning[b].total_cmp(&meaning[a])));
    order
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boilerplate_goes_and_the_card_s_own_words_stay() {
        let body = "Fix the login flow.\n\n<!-- gavin:auto-commit -->\nWhen done, commit it.\n<!-- /gavin:auto-commit -->\nThen <!-- a note --> ship.";
        assert_eq!(strip_boilerplate(body), "Fix the login flow.\n\n\nThen  ship.");
        assert_eq!(strip_boilerplate("an <!-- unterminated comment"), "an <!-- unterminated comment");
    }

    #[test]
    fn words_split_on_punctuation_and_drop_a_plural() {
        assert_eq!(words("Rails' get_tree: 2 a.md"), vec!["rail", "get", "tree", "md"]);
        assert_eq!(words("its bus"), vec!["its", "bus"], "too short to be a plural");
    }

    #[test]
    fn a_rare_word_outweighs_a_common_one_and_the_title_outweighs_the_body() {
        let docs = vec![
            lexical_text("Kimi integration", "feat-kimi.md", "Launch kimi with the agent profile."),
            lexical_text("Agent profiles", "profiles.md", "Every agent has a profile; kimi is one of them."),
            lexical_text("Agent settings", "settings.md", "The agent's model and effort."),
        ];
        let scores = bm25("kimi agent", &docs);
        assert!(scores[0] > scores[1], "{scores:?}");
        assert!(scores[1] > scores[2], "{scores:?}");
        assert_eq!(bm25("the of and", &docs), vec![0.0; 3], "stop words score nothing");
        assert!(bm25("x", &[]).is_empty());
    }

    #[test]
    fn meaning_leads_and_words_break_its_near_ties() {
        // Card 1 is a hair behind card 0 on meaning but the only one
        // sharing a word with the query; card 2 is far behind on both.
        let order = fuse(&[0.80, 0.79, 0.60], &[0.0, 3.0, 0.0]);
        assert_eq!(order, vec![1, 0, 2]);
        // But a word match does not lift a card from the bottom of the
        // meaning order past its top: at 2:1 a card needs to be within
        // the best 61 on meaning for a word match to outrank the leader.
        let meaning: Vec<f32> = (0..70).map(|i| 1.0 - i as f32 / 100.0).collect();
        let mut lexical = vec![0.0; 70];
        lexical[69] = 5.0;
        let order = fuse(&meaning, &lexical);
        assert_eq!(order[0], 0);
        assert!(order.iter().position(|&i| i == 69).unwrap() > 1, "{order:?}");
    }

    #[test]
    fn with_no_word_in_common_the_order_is_meaning_s() {
        assert_eq!(fuse(&[0.1, 0.5, 0.3], &[0.0, 0.0, 0.0]), vec![1, 2, 0]);
    }
}
