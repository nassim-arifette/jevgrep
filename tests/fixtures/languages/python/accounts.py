"""Account storage."""

import hashlib
from dataclasses import dataclass


@dataclass(frozen=True)
class Account:
    id: str
    email: str


def account_id(email: str) -> str:
    """Stable identifier for an email address."""
    return hashlib.sha256(email.strip().lower().encode()).hexdigest()[:12]


class AccountStore:
    def __init__(self) -> None:
        self._accounts: dict[str, Account] = {}

    def add(self, email: str) -> Account:
        account = Account(account_id(email), email)
        self._accounts[account.id] = account
        return account

    def find(self, id: str) -> Account | None:
        return self._accounts.get(id)
