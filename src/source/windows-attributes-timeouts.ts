// PowerShell and its JSON module can cold-start slowly on loaded Windows hosts.
// Only the first request includes that startup allowance; all waits stay bounded.
export const ATTRIBUTE_STARTUP_TIMEOUT_MS = 30_000;
export const ATTRIBUTE_REQUEST_TIMEOUT_MS = 8_000;
export const ATTRIBUTE_WORKER_GRACE_MS = 2_000;
