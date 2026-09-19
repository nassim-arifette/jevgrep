import type { AppConfig } from '../lib/config';

export type DiscountInput = {
  readonly subtotalCents: number;
  readonly discountPercent: number;
  readonly customerTier: 'standard' | 'silver' | 'gold';
};

export type DiscountPreview = {
  readonly subtotalCents: number;
  readonly appliedPercent: number;
  readonly discountCents: number;
  readonly totalCents: number;
  readonly clamped: boolean;
};

const TIER_BONUS_PERCENT: Record<DiscountInput['customerTier'], number> = {
  standard: 0,
  silver: 3,
  gold: 5,
};

export class PricingService {
  constructor(private readonly config: AppConfig) {}

  previewDiscount(input: DiscountInput): DiscountPreview {
    const requested = input.discountPercent + TIER_BONUS_PERCENT[input.customerTier];
    const appliedPercent = Math.min(requested, this.config.orders.maxDiscountPercent);
    const discountCents = Math.round((input.subtotalCents * appliedPercent) / 100);

    return {
      subtotalCents: input.subtotalCents,
      appliedPercent,
      discountCents,
      totalCents: input.subtotalCents - discountCents,
      clamped: appliedPercent < requested,
    };
  }

  /**
   * Historical helper kept for the exports pipeline: it rounds up instead of using
   * banker's rounding, so it is not used by the HTTP surface.
   */
  legacyDiscountCents(subtotalCents: number, appliedPercent: number): number {
    return Math.ceil((subtotalCents * appliedPercent) / 100);
  }
}
