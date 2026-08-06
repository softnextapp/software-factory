// Keep generated package-manager artifacts out of the Engine's "uncommitted changes"
// check in agent worktrees. Issue #20.
//
// At publish time the Engine cleans an agent worktree up only when `git status
// --porcelain` is empty; otherwise it preserves the worktree and warns `Run succeeded
// but worktree has uncommitted changes at <path>`. A pnpm consumer's sandbox-setup runs
// `pnpm install`, which materializes a local `.pnpm-store/` in the worktree. Untracked,
// it trips that check — cosmetic noise (the committed diff is still published) that reads
// like the implementer left work behind.
//
// Fix: write the generated-dir patterns into the repo's SHARED `.git/info/exclude`, which
// every linked worktree honors (verified — a worktree's own `.git/worktrees/<name>/info/
// exclude` is NOT honored, the common one is). The consumer's tracked `.gitignore` is
// untouched, so this never shows up as a diff and never collides with a consumer's own
// ignore rules. A genuinely uncommitted TRACKED change still appears in `git status
// --porcelain`, so real left-behind work still warns — the second acceptance criterion.
//
// The patterns are a ProjectConfig knob (`worktreeExclude`), defaulting to the pnpm local
// store; a yarn/npm consumer extends the list in config.ts. main.ts calls
// ensureWorktreeExclude() once at startup, before any sandbox is forked.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Idempotent patch for the shared `.git/info/exclude`: append every pattern from
 * `patterns` that is not already present as its own trimmed line. Returns the text to
 * append and whether to append at all. Pure — no fs — so it is unit-tested in isolation.
 *
 * Dedupe is exact-line (trimmed): a stored `.pnpm-store/` makes a `.pnpm-store/` input
 * skip, but a stored `.pnpm-store` (no slash) does NOT — the two are different ignore
 * rules and we only suppress what we ourselves would add. We never fuzzy-match: a
 * redundant-but-different line is harmless, a silently-merged one is surprising.
 */
export function buildWorktreeExcludePatch(
  current: string | null,
  patterns: readonly string[],
): { append: boolean; content: string } {
  const existing = new Set(
    (current ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
  // Trim + drop blanks, then keep only patterns not already present. `existing` holds
  // trimmed lines, so compare against the trimmed pattern.
  const missing: string[] = [];
  for (const raw of patterns) {
    const p = raw.trim();
    if (p !== '' && !existing.has(p)) missing.push(p);
  }
  if (missing.length === 0) return { append: false, content: '' };
  // Avoid a leading blank line when the file has content but no trailing newline; an
  // empty/missing file (current === null or '') needs no separator.
  const sep = current && current.length > 0 && !current.endsWith('\n') ? '\n' : '';
  return { append: true, content: sep + missing.join('\n') + '\n' };
}

/**
 * Ensure every pattern in `patterns` is ignored in `repoDir`'s shared `.git/info/exclude`,
 * so generated artifacts (`.pnpm-store/`, …) do not trip the Engine's uncommitted-changes
 * check in any worktree forked from this repo. Idempotent and best-effort: a missing
 * exclude file (not a git repo, unusual layout) is warned about and left alone — mirroring
 * adopt.ts's own `.git/info/exclude` handling — rather than creating a stray `.git/`.
 */
export function ensureWorktreeExclude(repoDir: string, patterns: readonly string[]): void {
  if (patterns.length === 0) return;
  const excludePath = join(repoDir, '.git', 'info', 'exclude');
  if (!existsSync(excludePath)) {
    console.warn(
      `[worktree-exclude] no ${excludePath} — not a git repo, or an unusual layout; ` +
        `generated dirs (e.g. .pnpm-store/) may warn as uncommitted (issue #20).`,
    );
    return;
  }
  const current = readFileSync(excludePath, 'utf8');
  const patch = buildWorktreeExcludePatch(current, patterns);
  if (patch.append) writeFileSync(excludePath, current + patch.content);
}
