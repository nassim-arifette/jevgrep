import type { NextFunction, Request, Response } from 'express';

type Bucket = { count: number; resetAt: number };

export function rateLimit(options: { readonly windowMs: number; readonly maxRequests: number }) {
  const buckets = new Map<string, Bucket>();

  return (request: Request, response: Response, next: NextFunction): void => {
    const key = request.ip ?? 'unknown';
    const now = Date.now();
    const bucket = buckets.get(key);

    if (bucket === undefined || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > options.maxRequests) {
      response.status(429).json({ error: 'rate_limited', retryAfterMs: bucket.resetAt - now });
      return;
    }

    next();
  };
}
