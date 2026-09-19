export type SubscriptionChanged = {
  readonly kind: 'subscription.changed';
  readonly userId: string;
  readonly plan: string;
};

export function decodeEvent(body: string): SubscriptionChanged {
  return JSON.parse(body) as SubscriptionChanged;
}
