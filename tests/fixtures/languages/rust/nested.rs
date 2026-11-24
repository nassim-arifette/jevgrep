#![allow(dead_code)]

use std::collections::HashMap;

/// A ledger of postings per account.
#[derive(Debug, Default)]
pub struct Ledger {
    entries: HashMap<String, Vec<i64>>,
    closed: bool,
}

#[derive(Debug)]
pub enum PostError {
    Closed,
    Empty,
    OverLimit(i64),
}

impl Ledger {
    /// Validates and records one posting, then reports the new balance.
    pub fn post(&mut self, account: &str, amount: i64) -> Result<i64, PostError> {
        if self.closed {
            return Err(PostError::Closed);
        }
        match amount {
            0 => return Err(PostError::Empty),
            a if a > 1_000_000 => return Err(PostError::OverLimit(a)),
            a if a < -1_000_000 => return Err(PostError::OverLimit(a)),
            _ => {}
        }
        let entries = self.entries.entry(account.to_string()).or_default();
        entries.push(amount);
        let mut balance = 0;
        for entry in entries.iter() {
            if *entry > 0 {
                balance += entry;
            } else {
                balance -= -entry;
            }
        }
        Ok(balance)
    }

    /// Stops further postings.
    pub fn close(&mut self) {
        self.closed = true;
    }
}

macro_rules! posting {
    ($ledger:expr, $account:expr, $amount:expr) => {
        $ledger.post($account, $amount)
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_postings() {
        let mut ledger = Ledger::default();
        assert!(matches!(posting!(ledger, "cash", 0), Err(PostError::Empty)));
    }

    #[test]
    fn rejects_postings_after_close() {
        let mut ledger = Ledger::default();
        ledger.close();
        assert!(matches!(posting!(ledger, "cash", 5), Err(PostError::Closed)));
    }
}
