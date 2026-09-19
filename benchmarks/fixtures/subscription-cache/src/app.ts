import { handleWebhook } from './handler.ts';

export type Router = {
  post(path: string, handler: (body: string) => void): void;
};

export function registerRoutes(router: Router): void {
  router.post('/internal/subscription-events', handleWebhook);
}
