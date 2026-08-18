// Contract test for the ignore boundary adoption ships into a consumer repo —
// the posture issue #29 makes mandatory: after adopting, the consumer's
// orchestration config (.sandcastle/config.ts first) is TRACKED in its repo, and
// only runtime artifacts (.env*, logs/, worktrees/, …) stay ignored. That is
// exactly the posture the Factory holds on itself (see the root .gitignore's
// comment); adoption now ships it instead of the pre-#29 whole-dir
// `.sandcastle/` line in `.git/info/exclude`, which kept every byte of the
// config — `labelBases`, `chainableBases`, queue labels — untracked, undiffable,
// and unrestorable: no `git checkout --` could bring a bad edit back, a fresh
// clone saw none of it, and an agent isolated in a linked worktree could not
// touch it at all (the config existed only in the main clone's working tree).
//
// The boundary lives in a NESTED `.sandcastle/.gitignore` — not appended to the
// consumer's root one — so adoption never edits a tracked consumer file: the
// nested file arrives with step 1's `git archive HEAD` copy, as just another
// tracked Factory file the consumer now owns (ADR-0002 clone-and-own). Scoped
// patterns (`.env*`, not `**/.env*`) also keep it from reaching outside
// `.sandcastle/` into project files the consumer ignores its own way.
//
// Two layers are pinned, in the order a regression would bite:
//   1. the pattern layer (pure): the shipped file's rules, read from disk and
//      asserted against a canonical artifact table — tracked-able vs ignored,
//      with the `.env*` ↔ `!.env*.example` negation pair called out, since that
//      pair is what keeps secrets out while the templates stay shippable;
//   2. the git layer (the suite's cross-process probe): real `git check-ignore`
//      against this repo, proving the patterns actually hold under git's
//      semantics — a negation that never fires, or a glob that over-matches,
//      reads fine in a table and fails only here. Same shell-out approach as
//      esm-shim.test.ts: gitignore matching is not worth re-deriving, and `git`
//      is already a Factory prerequisite.
//
// Run: npx tsx .sandcastle/consumer-ignore.test.ts   (also part of `npm test`)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { test, finish } from './test-harness.ts';

/** Repo root = process.cwd() under `npm test` (same anchor as esm-shim.test.ts). */
const REPO_ROOT = process.cwd();
/** The shipped nested ignore file — the boundary under test. */
const IGNORE_PATH = join(REPO_ROOT, '.sandcastle', '.gitignore');

// ---------------------------------------------------------------------------
// Layer 1 — the shipped pattern set (pure)
// ---------------------------------------------------------------------------

/** Read the shipped `.sandcastle/.gitignore`, asserting it exists first so a
 * missing file fails with the regression message, not an opaque ENOENT. */
function loadIgnoreFile(): string {
  assert.ok(
    existsSync(IGNORE_PATH),
    `${IGNORE_PATH} is missing — adoption has no artifact boundary to ship (issue #29)`,
  );
  return readFileSync(IGNORE_PATH, 'utf8');
}

/** Meaningful comment lines (trimmed, non-empty, starting with #). */
function commentLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('#'));
}

/** Ignore PATTERN lines: trimmed, non-empty, not a comment. */
function patternLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

test('the shipped boundary keeps only runtime artifacts ignored (the #29 posture)', () => {
  // The exact pattern set, as a set: `.env*` is the secret boundary, the
  // negation keeps the two example templates shippable, and the rest are the
  // artifacts a run materializes locally (or the Engine install / lockfiles it
  // writes out-of-tree — issue #22). Anything NOT matched is tracked-able.
  const patterns = new Set(patternLines(loadIgnoreFile()));
  const expected = [
    '.env*',
    '!.env*.example',
    'logs/',
    'worktrees/',
    'node_modules/',
    'pnpm-lock.yaml',
    'package-lock.json',
  ];
  for (const p of expected) {
    assert.ok(patterns.has(p), `expected pattern ${JSON.stringify(p)} in ${IGNORE_PATH}`);
  }
});

test('the negation is ordered AFTER the pattern it re-includes (git takes the LAST match)', () => {
  // `!.env*.example` must come after `.env*`; the reverse order re-ignores the
  // templates, and step 1's `git archive` copy would stop shipping them — the
  // README's `cp .sandcastle/.env.example …` instructions would go quiet.
  const lines = patternLines(loadIgnoreFile());
  const envIdx = lines.indexOf('.env*');
  const negIdx = lines.indexOf('!.env*.example');
  assert.ok(envIdx !== -1 && negIdx !== -1, 'both the .env* pattern and its negation must exist');
  assert.ok(negIdx > envIdx, '!.env*.example must be listed after .env*');
});

test('the file says WHY config is tracked — a reviewer reads the boundary, not just the rules', () => {
  // The Factory's own root .gitignore carries the same kind of comment. A bare
  // pattern list invites the next reader to "fix" it back to `.sandcastle/`.
  const comments = commentLines(loadIgnoreFile()).join('\n');
  assert.ok(
    /track/i.test(comments) && /config/i.test(comments),
    'the shipped .gitignore must explain that the config is tracked and only artifacts are ignored',
  );
});

test('no pattern re-ignores the whole directory (that was the pre-#29 posture)', () => {
  // The one line this issue exists to remove. If it ever reappears here, the
  // nested file undoes #29 for every consumer that adopts it.
  const lines = patternLines(loadIgnoreFile());
  assert.ok(
    !lines.includes('.sandcastle/') && !lines.includes('.sandcastle'),
    'the shipped boundary must not ignore the whole .sandcastle/ directory',
  );
});

// ---------------------------------------------------------------------------
// Layer 2 — does git agree? (cross-process probe, mirroring esm-shim.test.ts)
// ---------------------------------------------------------------------------

/** Exit-code probe of git's ignore decision. `git check-ignore -q` exits 0 when
 * the path IS ignored, 1 when it is not — works on paths that do not exist, so
 * the probe covers the boundary a fresh clone would enforce, not just the files
 * this checkout happens to hold. */
function gitIgnores(relPath: string): boolean {
  try {
    execFileSync('git', ['-C', REPO_ROOT, 'check-ignore', '--quiet', '--', relPath], {
      stdio: 'pipe',
    });
    return true; // exit 0 → ignored
  } catch {
    return false; // non-zero → not ignored
  }
}

/** The artifact boundary as a table: every path a consumer's run materializes
 * under `.sandcastle/` locally, which must NEVER enter a commit. `logs/` and
 * `worktrees/` are the Factory-documented artifacts; `.env` / `.env.secrets`
 * are the documented secret files (README "Auth token isolation"); `.env.local`
 * stands for any `.env*` variant a consumer might create — the glob, not the
 * enumeration, is the boundary. The node_modules path is the out-of-tree Engine
 * install (issue #22). */
const MUST_BE_IGNORED: { path: string; why: string }[] = [
  { path: '.sandcastle/.env', why: 'the host-CLI token file — a real secret' },
  { path: '.sandcastle/.env.secrets', why: 'the provider-token fallback file — a real secret' },
  { path: '.sandcastle/.env.local', why: 'any .env* variant a consumer creates must fall on the ignored side' },
  { path: '.sandcastle/logs/round-1.log', why: 'runtime logs' },
  { path: '.sandcastle/worktrees/issue-9/README.md', why: 'agent worktrees forked by the Engine' },
  { path: '.sandcastle/node_modules/@ai-hero/sandcastle/package.json', why: 'the out-of-tree Engine install (#22)' },
  { path: '.sandcastle/pnpm-lock.yaml', why: 'the standalone Engine-install lockfile (#23)' },
];

/** What must stay trackABLE — i.e. NOT ignored: the orchestration config (the
 * deliverable #29 versions), the entry point, and the two example templates the
 * negation exists to keep shippable. */
const MUST_NOT_BE_IGNORED: { path: string; why: string }[] = [
  { path: '.sandcastle/config.ts', why: 'the orchestration config — the project deliverable #29 tracks' },
  { path: '.sandcastle/main.ts', why: 'the Orchestration entry point' },
  { path: '.sandcastle/.env.example', why: 'the .env template — un-ignored by the negation pair' },
  { path: '.sandcastle/.env.secrets.example', why: 'the .env.secrets template — un-ignored by the negation pair' },
];

test('git agrees the config layer is trackable (not ignored — issue #29)', () => {
  for (const { path, why } of MUST_NOT_BE_IGNORED) {
    assert.equal(
      gitIgnores(path),
      false,
      `${path} is ignored — ${why}; adoption cannot put it under git`,
    );
  }
});

test('git agrees every runtime artifact stays ignored (the secret boundary holds)', () => {
  for (const { path, why } of MUST_BE_IGNORED) {
    assert.equal(gitIgnores(path), true, `${path} is NOT ignored — ${why}`);
  }
});

test('the shipped boundary is itself tracked (it travels with the copy, not the clone)', () => {
  // A nested .gitignore that only lived in the Factory's clone would ship via
  // `git archive` — and then be an untracked one-off in the consumer. Tracked,
  // it is versioned with the config it protects, in every consumer alike.
  let tracked = false;
  try {
    execFileSync(
      'git',
      ['-C', REPO_ROOT, 'ls-files', '--error-unmatch', '--', '.sandcastle/.gitignore'],
      { stdio: 'pipe' },
    );
    tracked = true;
  } catch {
    tracked = false;
  }
  assert.equal(tracked, true, '.sandcastle/.gitignore must be a tracked Factory file');
});

finish();
