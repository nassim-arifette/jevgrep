/**
 * Formatting helpers shared by the HTTP and export surfaces.
 */
export function formatMoney(cents: number, currency: string): string {
  const value = cents / 100;
  return `${value.toFixed(2)} ${currency.toUpperCase()}`;
}

export function formatOrderDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function formatSku(sku: string): string {
  return sku.trim().toUpperCase();
}
