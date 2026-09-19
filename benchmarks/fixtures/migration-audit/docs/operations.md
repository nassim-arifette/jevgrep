# Audit retention operations

The retention job runs daily at 03:00 UTC. It selects old records, excludes legal
holds, sorts identifiers for repeatability, and deletes them in configured batches.
An empty batch performs no repository deletion.
