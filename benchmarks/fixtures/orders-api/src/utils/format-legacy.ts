/**
 * Legacy export helpers. Kept because the nightly CSV export still imports them.
 */
export function money(cents: number, currency: string): string {
  const value = cents / 100;
  return `${value.toFixed(2)} ${currency.toUpperCase()}`;
}

export function formatOrderDateLegacy(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}-${day}`;
}
