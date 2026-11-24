package com.example.accounts;

import java.util.HashMap;
import java.util.Map;
import java.util.Optional;

/** Accounts kept in memory. */
public final class AccountStore {
    private final Map<String, Account> accounts = new HashMap<>();

    public Account add(String email) {
        Account account = new Account(Accounts.id(email), email);
        accounts.put(account.id(), account);
        return account;
    }

    public Optional<Account> find(String id) {
        return Optional.ofNullable(accounts.get(id));
    }

    public int size() {
        return accounts.size();
    }
}
