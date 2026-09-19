# JG-003 — Senior integration review

Reviewed the simulator introduced by `6834b58` after JG-002 was stabilized in `3e63154`. Date: 2026-09-19. Reference: specification §11.1 and all five JG-003 acceptance criteria.

## Findings and corrections

- The ignored `access-gateway/generated/roles.ts` fixture existed locally but was absent from Git. A clean checkout could not reproduce the fixture test. The harmless synthetic file is now explicitly versioned while its fixture `.gitignore` still excludes it from searches.
- `Buffer.slice()` retained caller-owned memory, allowing a later buffer edit to change recorded request bytes. Requests now become owned `Uint8Array` copies; returned observations are also copies.
- Steps and response objects were shared with the caller, so delayed results could change after constructing a scenario. Scenarios and returned responses are now copied with `structuredClone`, preserving malformed data such as `NaN` and explicit unknown usage without normalization.
- Simulator tests lacked the offline preload used by CLI subprocesses. They now arm the same network guard and verify that a fetch attempt fails.
- A finite delay could overflow the current clock into an infinite deadline. The clock rejects it before allocating a pending timer.

## Acceptance evidence

Ten simulator tests cover ordering, exact bytes, malformed/out-of-order scores, known/null usage, HTTP failure, deterministic replay, cancellation before/after dispatch, ownership of data, network rejection and timer overflow. The repository-shape test covers implementation, tests, JSON/SQL, malformed syntax, ignored output and inert instruction-like text. All fixture contents are synthetic and carry no real credential.

Eleven tests passed from a fresh Git index archive (`7c95e2e341b2603dfb675ba914cdab2fa0b4ac12`), with no local ignored files or installed provider dependency. `npm run typecheck` also passed on Node 24.15.0 / Windows.

The fake deliberately returns raw response data: JG-013 owns provider normalization. It performs no remote I/O and does not claim to establish the live SDK contract. All JG-003 criteria pass against the stabilized shared contracts; issue ready for dependent implementation work.
