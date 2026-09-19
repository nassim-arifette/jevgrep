import { ConfigurationError } from './config.ts';

/** Remove this gate only with the provider, authorization and scheduler acceptance evidence. */
export function requireQualifiedLiveSearch(): never {
  throw new ConfigurationError('INVALID_CONFIG',
    'live search is not qualified yet: JG-004, JG-005, JG-008, JG-016 and JG-017 remain open; '
    + 'use the injected offline provider for development (docs/handoff.md)');
}
