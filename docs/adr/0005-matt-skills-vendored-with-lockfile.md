# Matt skills are vendored in the Factory, with skills-lock.json as manifest

**Status**: Accepted (2026-08-04)

**Amended by** [ADR-0006](0006-own-skills-live-outside-the-lock-scan.md): the lock covers the *vendored* tree; skills the Factory writes itself live in a top-level `skills/`, outside the scan.

The Matt Pocock skills are vendored directly into the Factory's `.claude/skills/`, and `skills-lock.json` is kept as the manifest of record (source, path, hash per skill). We vendor — rather than fetch-on-install via the lockfile, or load via the plugin system — because the Factory's value proposition is clone-and-start with zero network dependency, and consumers live on a private GitLab where GitHub access (the very thing the Webshare proxy exists to work around) is a known pain point. Per-project vendoring, the current source of drift, is replaced by centralising skills here; updating skills becomes an explicit Factory-maintenance task (fetch from GitHub into the Factory, commit, push), not silent per-project drift.

**Rejected**: skills-lock + GitHub fetch on install (Matt's canonical mechanism, but a hard GitHub dependency at clone time); plugin install (managed and auto-updating, but ties the Factory to the plugin runtime and a marketplace). Both remain documented as optional alternatives for a consumer who prefers them.
