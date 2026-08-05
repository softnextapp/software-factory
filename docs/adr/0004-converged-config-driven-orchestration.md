# One config-driven canonical Orchestration with optional modules

**Status**: Accepted (2026-08-04)

The four diverged `.sandcastle/main.ts` converge into a single canonical `main.ts` whose behaviour is driven by a config/env surface: `SANDCASTLE_PROFILE`, `SANDCASTLE_CHAIN`, `MAX_PARALLEL`, the `PROVIDERS` table, commit style, git host, base-branch policy, and `MERGE_STRATEGY`. Modes that are structurally deep — Chained, Merger — live as optional modules (`chain.ts`, `merger.ts`) the config enables, not as boolean flags. `MERGE_STRATEGY=agent|human` is a first-class option because it encodes two genuine process philosophies (ccsnoop's agent Merger vs Omniris's human draft-MR review), not a cosmetic toggle.

The v0.1 baseline is `design-system`'s `main.ts` — the most evolved instance — with ccsnoop's Merger and Opus profile ported as the first follow-up modules.

**Rejected**: a family of separate scripts per philosophy (minimal convergence — just centralised drift); a fully composable base+modules with no canonical `main.ts` (more assembly work, no single testable spine).
