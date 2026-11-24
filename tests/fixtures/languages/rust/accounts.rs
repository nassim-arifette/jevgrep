use std::collections::HashMap;

/// A stored account.
pub struct Account {
    pub id: String,
    pub email: String,
}

/// What a store can do.
pub trait Store {
    fn add(&mut self, email: &str) -> Account;
}

pub struct MemoryStore {
    accounts: HashMap<String, String>,
}

impl MemoryStore {
    pub fn new() -> Self {
        MemoryStore { accounts: HashMap::new() }
    }

    pub fn len(&self) -> usize {
        self.accounts.len()
    }
}

pub fn account_id(email: &str) -> String {
    email.trim().to_lowercase()
}
