/// Adds the values.
pub fn total(values: &[i64]) -> i64 {
    let mut total = 0;
    for value in values {
        total += value;
    }
    total
}

/// Broken is missing the closing parenthesis of its parameter list.
pub fn broken(values: &[i64] -> usize {
    values.len()
}

/// Averages the values.
pub fn mean(values: &[i64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    total(values) as f64 / values.len() as f64
}

/// Returns the largest value.
pub fn max(values: &[i64]) -> i64 {
    let mut best = values[0];
    for value in &values[1..] {
        if *value > best {
            best = *value;
        }
    }
    best
}
