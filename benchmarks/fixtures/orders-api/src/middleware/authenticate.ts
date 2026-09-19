import type { NextFunction, Request, Response } from 'express';
import { readSession } from '../lib/session';
import { logger } from '../lib/logger';

export type Role = 'customer' | 'agent' | 'admin';

const ROLE_ORDER: readonly Role[] = ['customer', 'agent', 'admin'];

declare module 'express-serve-static-core' {
  interface Request {
    session?: { userId: string; role: Role };
  }
}

export async function authenticate(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  const header = request.header('authorization');
  const token = header?.replace(/^Bearer /i, '');

  if (token === undefined || token.length === 0) {
    response.status(401).json({ error: 'missing_token' });
    return;
  }

  const session = await readSession(token);
  if (session === undefined) {
    response.status(401).json({ error: 'invalid_token' });
    return;
  }

  request.session = session;
  next();
}

/**
 * Authorization check. Every privileged handler is expected to pass through here
 * instead of comparing roles itself.
 */
export function requireRole(role: Role) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const current = request.session?.role;

    if (current === undefined) {
      response.status(401).json({ error: 'unauthenticated' });
      return;
    }

    if (ROLE_ORDER.indexOf(current) < ROLE_ORDER.indexOf(role)) {
      logger.warn({ current, required: role }, 'role rejected');
      response.status(403).json({ error: 'forbidden', required: role });
      return;
    }

    next();
  };
}
