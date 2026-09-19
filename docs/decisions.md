# JevGrep decisions and alternatives

Prepared 2026-09-19. This register records the user's confirmed choices, the accepted engineering baseline, and facts that must be measured. The [specification](specification.md) describes the complete design, and the [implementation plan](implementation-plan.md) orders the work.

## Confirmed by the user

| ID | Choice | Alternatives considered | Why this fits |
| --- | --- | --- | --- |
| D1 | Personal MVP first | Public developer tool; production team tool | Validate usefulness before packaging, support, and multiuser operations |
| D2 | Target repositories up to approximately 100,000 lines | Approximately one million lines; larger monorepos | A practical first benchmark workload for exhaustive evaluation; not a hardcoded size cap |
| D3 | TypeScript | Python | One runtime for the core, CLI, MCP, and JS/TS syntax parser; official Jev SDK available |
| D4 | Require the scope to fit configured limits by default | Partial scan by default | A zero-call preflight rejection is clearer than a silently incomplete prefix; partial mode remains explicit |
| D5 | Optional spending and total-scan caps off by default | Configurable caps enabled by default | Avoid arbitrary product restrictions; the operator chooses limits when useful |
| D6 | Adjustable timeout and per-call response budget remain | Fixed hardcoded timeout/spend tier; no execution control | Matches client lifecycle and the caller's context needs while allowing longer runs |
| D7 | Use the recommended technical baseline below | Choose each technical detail individually | The user accepted the baseline after reviewing the alternatives |

D6 is included in the user's acceptance of the optional-cap policy. The concrete starting timeout and response-token defaults below remain proposed values, not separately confirmed performance requirements.

## Established by the supplied brief

The tool is on-demand and returns original excerpts. The coding agent retains reasoning and editing. The engine is shared by CLI and local MCP. Jev evaluation is remote. Scan and response budgets are distinct. V1 uses no grep/embedding relevance prefilter, emphasizes JS/TS, handles top-level/configuration evidence, distinguishes failed evaluation from irrelevance, and reuses only identical evaluations. The product hypothesis must be benchmarked using the whole task.

These are the project foundations; they are not reopened as questions in this draft.

## Accepted engineering baseline and alternatives

The user accepted the recommended technical baseline as a group. The table retains the alternatives and reasoning so the choices remain reviewable. Small numerical tuning values are configuration and benchmark variables, and provider behavior still requires the experiments below.

| ID | Topic | Recommendation | Other viable solution and trade-off |
| --- | --- | --- | --- |
| E1 | Own engine or reuse `jev_rank` | Build a small shared engine; use `Brainwires/jevwire` as an attributed baseline and inspect reusable utilities | Wrap/fork its ranking engine for a faster start, but adapt shared-state batching, reference-only output, and accounting; preserve MIT attribution for copied code |
| E2 | JS/TS parsing | TypeScript compiler syntax parser with original-source slicing | Tree-sitter is attractive for several languages but adds grammar/runtime packaging and per-language rules |
| E3 | Non-JS/TS files | Include common config, Markdown, and SQL through line-window fallback | JS/TS only is simpler but can miss the configuration and migrations the brief explicitly values |
| E4 | Jev transport | Narrow official-SDK adapter with SDK retries/logging controlled by us | Direct HTTP offers more control over each attempt if SDK cancellation/limits prove troublesome |
| E5 | MCP result | One JSON text block with internal schema validation | Structured content plus text improves formal MCP typing but can duplicate model-visible excerpts; verify before adopting |
| E6 | Response accounting | A pinned local reference tokenizer; count the entire rendered result | A character/byte estimate is simpler but less precise; exact Codex billing cannot be guaranteed from inside this tool |
| E7 | Cache | Persistent local numeric scores and fingerprints only; 7-day/100-MiB configurable starting policy | Memory-only simplifies persistence/privacy but loses reuse between processes; SQLite may help later if file-cache profiling warrants it |
| E8 | Changed selected files | Omit stale source and report partial results | Return the captured excerpt with a stale label to preserve potentially useful historical evidence, at the cost of more caller interpretation |
| E9 | Deduplication | Merge overlaps in the same file; retain different paths | Cross-file content dedup reduces tokens but can erase meaningful provenance; add only after measuring |
| E10 | Authorization | Trusted external config, one root per process, link traversal disabled | Multi-root/link-aware policy is more flexible and substantially harder to verify across Windows/POSIX |
| E11 | Batch scheduling | Deterministic batches; concurrency starts at 4; one active search per process | More simultaneous searches may lower queueing but complicate resource sharing and personal-MVP accounting |
| E12 | Selection | Threshold plus descending score, overlap merge, and fit; threshold starts at 0.50 for experiments | Diversity/MMR/role-aware selection may help complementary evidence but needs a baseline and can suppress useful matches |
| E13 | Platform and distribution | Windows first-class, Linux CI, local package installation | Windows-only saves CI setup; public npm/multi-platform release adds support work before the hypothesis is proven |
| E14 | Success criterion | Protect task success, measure both total cost and latency, and treat the first study as exploratory | Optimize a single metric early; useful later, but too easy to choose a flattering metric before pilot results |

The provider request layout is not chosen by preference alone. E4's adapter and E12's threshold must be validated by experiments; see F1–F5 below. No unsupported option is exposed as a working configuration toggle.

## Provisional tuning values

The specification's configuration section is the single source of truth for numeric defaults. Suggested starting points are a 4,000-reference-token response, a 60-second adjustable deadline, a 30-second measurement target, bounded fragment sizes, and small provider batches. They are adjustable settings, not promises that every target repository can be scanned in that time.

Optional per-search spending/input/bytes/attempt/file-count/fragment-count caps are null in normal configuration. A separate benchmark profile can enable limits to make experiments comparable. Provider per-request context restrictions require batching regardless of whether a total scan cap is enabled.

There is no hardcoded line-count usage tier. The configurable per-file eligibility size rule and unsupported long-line handling are disclosed separately; they can exclude content and therefore must appear in the report.

## Facts and experiments to resolve during implementation

| ID | Unknown | Proposed way to resolve it | Consequence if unfavorable |
| --- | --- | --- | --- |
| F1 | Does the brief's excerpt-per-question layout retrieve useful code? | Compare against isolated excerpt/state and jevwire layout on frozen synthetic/public fixtures | Use the better supported layout and record its latency/cost trade-off; revisit viability if all fail |
| F2 | What model/version/usage does the account actually return? | Small synthetic provider contract test; record requested and returned identities | Disable persistent reuse under unresolved aliases; do not invent usage/model identity |
| F3 | Real performance on ~100,000-line repositories | Measure cold and warm scans by tokens, fragments, batches, latency and memory | Recommend narrower scopes/longer configured timeout; avoid a full-repository performance promise |
| F4 | Which SDK/protocol/tokenizer versions work with the user's Codex? | Pin versions after child-process and actual-host compatibility checks | Adjust the narrow adapter, not the core search contract |
| F5 | Is the tool a net benefit for coding tasks? | Paired normal-tools versus normal-tools-plus-JevGrep evaluation | Narrow supported use cases, revise the hypothesis, or keep it experimental |
| F6 | Account-specific limits and source-retention agreement | Read the actual account settings/agreement when integrating | Document applicable limits/terms; no general zero-retention or exact-billing promise |

These are empirical questions. Asking the user to guess the answers would not resolve them. They are planned validation work; no live Jev calls were made during this specification task.

## Decisions intentionally left for a later phase

Public license, npm publication, team deployment, other language parsers, multiple repository roots, streaming/resume semantics, and a new relevance prefilter are outside the confirmed personal MVP. Choose them only when needed, with the relevant trade-offs visible. No implementation or external publication is implied by this planning document.
