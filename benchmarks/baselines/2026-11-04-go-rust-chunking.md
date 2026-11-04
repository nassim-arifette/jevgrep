# Go/Rust chunking, 2026-11-04

Roadmap section 12: Tree-sitter syntax chunking for Go and Rust (production
`recursive` arm) against plain line windows for Go/Rust files
(`go-rust-line-windows`). Every other language keeps the production chunker in both
arms. Raw summary: [go-rust-chunking-2026-11-04.json](go-rust-chunking-2026-11-04.json).

## Setup

- Tasks: [`swe-bench-multilingual-go-rust-1`](../real-tasks/README.md#go-and-rust-tasks),
  25 tasks and 34 queries. Dev: `caddyserver/caddy` and `sharkdp/bat` (21 queries).
  Held-out: `gin-gonic/gin` and `tokio-rs/axum` (13 queries, frozen manifest).
- Provider: `typesafe-direct` / `jev-1.13.0`, score cache disabled. Four
  repetitions per arm and split. Earlier partial passes made through the Vercel
  gateway (`typesafe-ai/jev`) were stopped by a budget cap and are not mixed in.
- Default search settings (threshold 0.5, 4,000-token response budget).

```sh
npm run bench:real -- --go-rust --chunker go-rust-line-windows --config <trusted-config> --split dev
npm run bench:real -- --go-rust --chunker recursive --config <trusted-config> --split heldout --frozen <freeze.json>
```

## Results

Mean of four runs (± population standard deviation where it is not zero):

| Split | Arm | R@1 | R@5 | MRR | File recall | Input tokens/run | Median latency |
|---|---|---:|---:|---:|---:|---:|---:|
| dev | `go-rust-line-windows` | 0.649 ± 0.024 | 0.749 ± 0.021 | 0.788 ± 0.019 | 0.905 | 2.99M | 6.8 s |
| dev | `recursive` (production) | 0.573 ± 0.020 | 0.761 | 0.760 ± 0.013 | 0.952 | 2.82M | 3.8 s |
| held-out | `go-rust-line-windows` | 0.462 | 0.538 | 0.500 | 0.788 | 1.57M | 3.0 s |
| held-out | `recursive` (production) | 0.462 | 0.623 ± 0.013 | 0.519 ± 0.003 | 0.817 | 1.45M | 2.2 s |

Offline (`npm run bench:chunking`, no provider call) on the 778 exported files:
syntax chunking makes 3,339 fragments (line windows: 3,539), keeps evidence inside
one fragment slightly more often (0.963 against 0.951) and names the enclosing symbol
on 0.797 of fragments (line windows: none).

Per query (mean over the four runs, differences above 0.05):

- Dev R@1: line windows are better on 4 queries (largest `sharkdp__bat-562:change`,
  +1.00), syntax chunks on 2. Several of these are near-tied fragments where the
  answer moves between rank 1 and 2.
- Dev R@5: syntax chunks win `caddyserver__caddy-5995:change` (+1.00); line windows
  win 2 code-understanding queries (+0.50, +0.25).
- Held-out: R@1 is identical on every query; syntax chunks win R@5 on
  `gin-gonic__gin-3820:change` (+1.00) and `tokio-rs__axum-1934:change` (+0.10).

## Decision

Keep Tree-sitter syntax chunking for Go and Rust. It matches or beats line windows on
every held-out metric (R@5 +0.085), sends 6–8 % fewer input tokens, has lower latency
and higher file recall. The dev R@1 gain of line windows (+0.076) comes from four
queries and does not carry over to the held-out split. With 34 queries both
directions remain small; revisit with a larger Go/Rust task set before tuning
boundaries further.
