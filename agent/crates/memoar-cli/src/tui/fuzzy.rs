//! Fuzzy matching for the command palette.
//!
//! Every character of the query must appear in order. Matches score higher
//! when they are consecutive, start a word, or start the text, which is the
//! ordering people expect from fzf and editor palettes.

/// The score of `query` against `text`, and the matched character positions,
/// or `None` when it does not match. An empty query matches everything.
pub(crate) fn score(query: &str, text: &str) -> Option<(i64, Vec<usize>)> {
    let query: Vec<char> = query
        .chars()
        .filter(|character| !character.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect();
    if query.is_empty() {
        return Some((0, Vec::new()));
    }
    let characters: Vec<char> = text.chars().collect();
    let lower: Vec<char> = characters
        .iter()
        .map(|character| character.to_lowercase().next().unwrap_or(*character))
        .collect();
    let mut positions = Vec::with_capacity(query.len());
    let mut score = 0_i64;
    let mut wanted = 0;
    let mut previous: Option<usize> = None;
    for (index, character) in lower.iter().enumerate() {
        if wanted == query.len() {
            break;
        }
        if *character != query[wanted] {
            continue;
        }
        let word_start = index == 0
            || !characters[index - 1].is_alphanumeric()
            || (characters[index].is_uppercase() && characters[index - 1].is_lowercase());
        score += 1;
        if previous == Some(index.wrapping_sub(1)) {
            score += 8;
        }
        if word_start {
            score += 6;
        }
        if index == 0 {
            score += 4;
        }
        if let Some(previous) = previous {
            score -= ((index - previous - 1) as i64).min(4);
        }
        positions.push(index);
        previous = Some(index);
        wanted += 1;
    }
    (wanted == query.len()).then_some((score - text.len() as i64 / 16, positions))
}
