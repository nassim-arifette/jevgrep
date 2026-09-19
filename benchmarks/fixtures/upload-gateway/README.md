# Upload gateway fixture

Synthetic TypeScript source for private upload quarantine and scan-gated publication.
An operator supplies policy and storage/scanner ports to the route.
The sample policy is data; this fixture does not implement a configuration loader.

The adapter assumes copy/delete operations succeed atomically individually. It does
not make promotion transactional; cleanup errors can replace an earlier exception.
Client-supplied media type is a policy hint, not content signature verification.
