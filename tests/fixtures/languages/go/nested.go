//go:build linux

package ledger

/*
#include <stdlib.h>
*/
import "C"

import (
    "errors"
    "fmt"
)

// ErrClosed is returned after Close.
var ErrClosed = errors.New("ledger closed")

// Ledger records postings per account.
type Ledger struct {
    entries map[string][]int
    closed  bool
}

// Post validates and records one posting, then reports the new balance.
func (l *Ledger) Post(account string, amount int) (int, error) {
    if l.closed {
        return 0, ErrClosed
    }
    if amount == 0 {
        return 0, errors.New("empty posting")
    }
    switch {
    case amount > 1_000_000:
        return 0, fmt.Errorf("posting %d over the limit", amount)
    case amount < -1_000_000:
        return 0, fmt.Errorf("posting %d under the limit", amount)
    }
    entries := l.entries[account]
    entries = append(entries, amount)
    l.entries[account] = entries
    balance := 0
    for _, entry := range entries {
        if entry > 0 {
            balance += entry
        } else {
            balance -= -entry
        }
    }
    return balance, nil
}

var report = func(l *Ledger) string {
    total := 0
    for account, entries := range l.entries {
        for _, entry := range entries {
            total += entry
        }
        fmt.Println(account, len(entries))
    }
    return fmt.Sprint(total)
}

// Close stops further postings.
func (l *Ledger) Close() { l.closed = true }
