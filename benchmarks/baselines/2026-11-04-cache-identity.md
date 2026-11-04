# Cache identity: location-independent evaluation input (2026-11-04)

Roadmap: additional cache-identity investigation. The score cache keyed every
judgment by path and line range, because the model saw both (`File:` and `Lines:`
headers, and question keys such as `src/a.ts#L65-L128`). Adding a line above a
function therefore discarded the cached score of every unit below it.

## Reuse across real commits

[`scripts/bench-cache-identity.ts`](../../scripts/bench-cache-identity.ts) chunks
every source file touched by consecutive first-parent commits, before and after, and
counts the fragments of the new version a cache could reuse. Raw results:
[cache-identity-reuse-2026-11-04.json](cache-identity-reuse-2026-11-04.json).

| Repository | Commits | Touched files | Fragments | Path + lines (before) | Path, no lines | No path, no lines |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cobra (Go) | 110 | 286 | 3,810 | 56.8 % | 82.9 % | 82.9 % |
| walkdir (Rust) | 96 | 154 | 2,016 | 39.8 % | 56.9 % | 57.5 % |
| clap (Rust) | 60 | 82 | 519 | 51.6 % | 80.2 % | 80.2 % |

Dropping the line range recovers most of the lost reuse; dropping the path as well
adds almost nothing.

## Quality

Every captured candidate of the E2/E8 pools (65 searches, 5,009 candidates) was
judged live through TypeSafe direct (`jev-1.13.0`) under each layout on identical
chunks, then replayed with the default selection
([layouts report](cache-identity-layouts-2026-11-04.json)). The reference is the
`layout-a-1` rerun on the same provider; the captured pool scores (Vercel, same model)
are a second layout-A sample and give the noise floor.

| Arm | R@1 | R@5 | MRR | Counterevidence | Negatives | mean abs. score delta | Threshold crossings | Changed searches |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| captured layout-a-1 (noise floor) | 0.759 | 0.916 | 0.911 | 1.000 | 1.000 | 0.0189 | 60 | 13 |
| `layout-a-1` rerun (reference) | 0.737 | 0.893 | 0.889 | 1.000 | 1.000 | 0 | 0 | 0 |
| `layout-a-nolines-1` | 0.759 | 0.916 | 0.911 | 1.000 | 1.000 | 0.0097 | 27 | 7 |
| `layout-a-noloc-1` | 0.737 | 0.893 | 0.889 | 0.929 | 1.000 | 0.0291 | 69 | 14 |

`layout-a-nolines-1` keeps the path and structure label, drops the `Lines:` header
and keys questions by position (`e1`, `e2`, ...), so no line number reaches the model.
It stays inside the noise floor on every group (synthetic, real dev, real held-out,
false premise) and costs 1.6 % fewer input tokens. `layout-a-noloc-1` also drops the
path; it loses counterevidence on one false-premise search and moves scores more than
the noise floor, so it is not adopted. (Its run still keyed questions by fragment
id, which carries the path and line range.)

## Decision

`layout-a-nolines-1` is the production layout. The cache identity of a line-free
layout leaves out the line range; returned provenance still carries the real paths and
line numbers. Changing the layout version invalidates existing cached scores once.

Single run per arm on 65 searches; the gain is in reuse, not in retrieval quality.
