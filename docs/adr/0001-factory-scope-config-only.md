# Factory scope is config-only; the Engine is an external dependency

**Status**: Accepted (2026-08-04)

The Factory repo holds the Sandcastle *config and orchestration* layer — the `.sandcastle/` loop, `.claude/` skills, and workflow docs — not the Engine itself. The Engine (`@ai-hero/sandcastle`, upstream `mattpocock/sandcastle`) stays an external pinned dependency installed per consumer via npm. We chose this because all four diverged instances differ only in the config layer; nobody forked the Engine, so vendoring it would mean maintaining an upstream fork forever for zero divergence benefit.

**Rejected**: bundling Engine + config together (the `ledahu05/sandcastle-kit` model) so `git clone` needs zero `npm install`. Heavier repo, owns an Engine fork — not worth it when the Engine never diverged.
