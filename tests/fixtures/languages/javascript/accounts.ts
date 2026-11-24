import { createHash } from 'node:crypto';

/** A stored account. */
export interface Account {
  readonly id: string;
  readonly email: string;
}

export type AccountId = Account['id'];

// Stable identifiers for test accounts.
export function accountId(email: string): AccountId {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 12);
}

export class AccountStore {
  readonly #accounts = new Map<AccountId, Account>();

  add(email: string): Account {
    const account = { id: accountId(email), email };
    this.#accounts.set(account.id, account);
    return account;
  }

  find(id: AccountId): Account | undefined {
    return this.#accounts.get(id);
  }
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();
