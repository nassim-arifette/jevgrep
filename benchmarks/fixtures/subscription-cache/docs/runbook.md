# Cache incident runbook

If subscription updates appear stale, verify delivery to `/internal/subscription-events`
before clearing the cache. Profile updates are queued and deduplicated; draining the
refresh queue returns users in stable identifier order.
