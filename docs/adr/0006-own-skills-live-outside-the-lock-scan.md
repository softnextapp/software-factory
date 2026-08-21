# Our own skills live outside the skills-lock scan

**Status**: Accepted (2026-08-21)

Skills the Factory *writes itself* live in a top-level `skills/` directory (flat: `skills/<name>/SKILL.md`), deliberately outside `.claude/skills/` — the tree `skills-lock.ts` scans. `npm run skills:check` therefore stays green across every edit to one of them, with no code changed and no lock entry added. The first of them is `skills/sandcastle-run/` (issue #42), the operator skill that translates "traite le ticket #42 en AFK" into correct gestures on a Factory instance; it is installed on a workstation by hand (`cp -r skills/sandcastle-run ~/.claude/skills/`), documented in the README and in `adopt.ts`'s epilogue, and shipped to no consumer — `adopt.ts` copies `.sandcastle/` only.

**Rejected**: amending `skills-lock.ts` to tolerate an `own` class of skill (hashed but exempt from the drift verdict, or hashed with the lock regenerated on each edit). The hash exists to detect drift **against an upstream**, and a skill we author has no upstream: every deliberate edit would present itself as tampering, and the only honest response — regenerate the lock — makes the check a formality. A second rejected option was `.claude/skills/own/`, which keeps the skill inside the scan and buys nothing but a category name.

Amends [ADR-0005](0005-matt-skills-vendored-with-lockfile.md), which made `.claude/skills/` and the lock synonymous. They are no longer: the lock covers the *vendored* tree, which remains the whole of `.claude/skills/`.
