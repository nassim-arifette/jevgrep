package accounts

import (
    "crypto/sha256"
    "encoding/hex"
    "strings"
)

// Account is a stored account.
type Account struct {
    ID    string
    Email string
}

// Store keeps accounts in memory.
type Store interface {
    Add(email string) Account
    Find(id string) (Account, bool)
}

// AccountID derives a stable identifier from an email address.
func AccountID(email string) string {
    sum := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(email))))
    return hex.EncodeToString(sum[:])[:12]
}

func newAccount(email string) Account {
    return Account{ID: AccountID(email), Email: email}
}
