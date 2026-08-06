// Contract tests for the worktree-exclude module (issue #20).
//
// The Engine cleans an agent worktree up only when `git status --porcelain` is empty;
// a pnpm consumer's `pnpm install` materializes a local `.pnpm-store/` that, untracked,
// makes the Engine preserve the worktree and warn "uncommitted changes" — cosmetic noise
// that reads like left-behind work. The fix writes the generated-dir patterns into the
// repo's shared `.git/info/exclude` (honored by every linked worktree — proven in the
// integration test below), so the Engine no longer flags them, while a genuinely
// uncommitted TRACKED change still does.
//
// Pure: the buildWorktreeExcludePatch seam has no fs. The ensureWorktreeExclude
// integration case spins up a throwaway git repo in the os tmpdir and tears it down.
//
// Run: npx tsx .sandcastle/worktree-exclude.test.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWorktreeExcludePatch, ensureWorktreeExclude } from './worktree-exclude.ts';
import { test, finish } from './test-harness.ts';

// A throwaway root that holds the repo AND its linked worktrees as siblings, so the lot
// is torn down with one rmSync. (git worktree add needs a sibling path anyway.)
function freshRoot(): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), 'wt-exc-'));
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  return { root, repo };
}

// ---------------------------------------------------------------------------
// buildWorktreeExcludePatch — the pure seam
// ---------------------------------------------------------------------------

test('null current + patterns → append all, joined, trailing newline, no leading sep', () => {
  const p = buildWorktreeExcludePatch(null, ['.pnpm-store/', '.yarn/cache/']);
  assert.equal(p.append, true);
  assert.equal(p.content, '.pnpm-store/\n.yarn/cache/\n');
});

test('empty current string behaves like null', () => {
  const p = buildWorktreeExcludePatch('', ['.pnpm-store/']);
  assert.equal(p.content, '.pnpm-store/\n');
});

test('current not ending in newline → prepend a separating newline', () => {
  const p = buildWorktreeExcludePatch('existing-rule', ['.pnpm-store/']);
  assert.equal(p.content, '\n.pnpm-store/\n');
});

test('current ending in newline → no separating newline', () => {
  const p = buildWorktreeExcludePatch('existing-rule\n', ['.pnpm-store/']);
  assert.equal(p.content, '.pnpm-store/\n');
});

test('a pattern already present (exact trimmed line) is not re-appended', () => {
  const p = buildWorktreeExcludePatch('.pnpm-store/\n', ['.pnpm-store/']);
  assert.equal(p.append, false);
  assert.equal(p.content, '');
});

test('all patterns already present → append:false', () => {
  const current = '.pnpm-store/\n.yarn/cache\n';
  const p = buildWorktreeExcludePatch(current, ['.pnpm-store/', '.yarn/cache/']);
  // '.yarn/cache' (no slash) is a DIFFERENT line from '.yarn/cache/' — only exact-line
  // dedupe applies; we never fuzzy-match, so the slashed one is still missing.
  assert.equal(p.append, true);
  assert.equal(p.content, '.yarn/cache/\n');
});

test('partial: only the missing patterns are appended, in input order', () => {
  const current = '.pnpm-store/\n';
  const p = buildWorktreeExcludePatch(current, ['.turbo/', '.pnpm-store/', '.cache/']);
  assert.equal(p.content, '.turbo/\n.cache/\n');
});

test('blank/whitespace-only patterns are ignored', () => {
  const p = buildWorktreeExcludePatch(null, ['', '   ', '.pnpm-store/']);
  assert.equal(p.content, '.pnpm-store/\n');
});

test('patterns are trimmed in the output', () => {
  const p = buildWorktreeExcludePatch(null, ['  .pnpm-store/  ']);
  assert.equal(p.content, '.pnpm-store/\n');
});

test('empty pattern list → append:false (nothing to do)', () => {
  const p = buildWorktreeExcludePatch('whatever\n', []);
  assert.equal(p.append, false);
  assert.equal(p.content, '');
});

test('idempotent: feeding the produced content back yields append:false', () => {
  const first = buildWorktreeExcludePatch(null, ['.pnpm-store/', '.cache/']);
  // Simulate the file now holding exactly what the first patch would have appended.
  const second = buildWorktreeExcludePatch(first.content, ['.pnpm-store/', '.cache/']);
  assert.equal(second.append, false);
});

// ---------------------------------------------------------------------------
// ensureWorktreeExclude — integration over a throwaway git repo
// ---------------------------------------------------------------------------

// Minimal git argv helper against a cwd (no shell), mirroring main.ts's discipline.
function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

test('ensureWorktreeExclude writes the patterns into the shared .git/info/exclude (idempotent)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'wt-exc-'));
  try {
    git(['init', '-q'], repo);
    git(['config', 'user.email', 't@t.t'], repo);
    git(['config', 'user.name', 't'], repo);
    writeFileSync(join(repo, 'README.md'), 'x\n');
    git(['add', 'README.md'], repo);
    git(['commit', '-qm', 'init'], repo);

    ensureWorktreeExclude(repo, ['.pnpm-store/']);
    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    assert.ok(exclude.includes('.pnpm-store/'), 'exclude should list .pnpm-store/');

    // Second call is a no-op (idempotent): the entry is not duplicated.
    ensureWorktreeExclude(repo, ['.pnpm-store/']);
    const after = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    assert.equal((after.match(/\.pnpm-store\//g) ?? []).length, 1, 'pattern must appear exactly once');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('acceptance: a generated .pnpm-store/ in a linked worktree no longer counts as uncommitted', () => {
  // This is the issue #20 reproduction in miniature: a forked worktree that materializes
  // a .pnpm-store/ must read as CLEAN to `git status --porcelain` once the shared exclude
  // has the pattern — which is exactly what the Engine's hasUncommittedChanges runs.
  const { root, repo } = freshRoot();
  try {
    git(['init', '-q'], repo);
    git(['config', 'user.email', 't@t.t'], repo);
    git(['config', 'user.name', 't'], repo);
    writeFileSync(join(repo, 'README.md'), 'x\n');
    git(['add', 'README.md'], repo);
    git(['commit', '-qm', 'init'], repo);

    // BEFORE the fix: an untracked .pnpm-store/ shows up as an uncommitted change.
    const wtBefore = join(root, 'wt-before');
    git(['worktree', 'add', '-q', wtBefore, '-b', 'before'], repo);
    mkdirSync(join(wtBefore, '.pnpm-store'));
    writeFileSync(join(wtBefore, '.pnpm-store', 'blob'), 'x');
    const dirty = git(['status', '--porcelain'], wtBefore);
    assert.equal(dirty.trim(), '?? .pnpm-store/', 'precondition: store dir is untracked');

    // Apply the fix to the shared exclude, then fork a fresh worktree and rematerialize.
    ensureWorktreeExclude(repo, ['.pnpm-store/']);
    const wtAfter = join(root, 'wt-after');
    git(['worktree', 'add', '-q', wtAfter, '-b', 'after'], repo);
    mkdirSync(join(wtAfter, '.pnpm-store'));
    writeFileSync(join(wtAfter, '.pnpm-store', 'blob'), 'x');
    const clean = git(['status', '--porcelain'], wtAfter);
    assert.equal(clean.trim(), '', 'generated .pnpm-store/ must be ignored post-fix');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('acceptance: a genuinely uncommitted TRACKED change still shows after the fix', () => {
  // The second acceptance criterion — the fix must not silence real left-behind work.
  const { root, repo } = freshRoot();
  try {
    git(['init', '-q'], repo);
    git(['config', 'user.email', 't@t.t'], repo);
    git(['config', 'user.name', 't'], repo);
    writeFileSync(join(repo, 'README.md'), 'x\n');
    git(['add', 'README.md'], repo);
    git(['commit', '-qm', 'init'], repo);

    ensureWorktreeExclude(repo, ['.pnpm-store/']);
    const wtReal = join(root, 'wt-real');
    git(['worktree', 'add', '-q', wtReal, '-b', 'real'], repo);
    // A tracked file left modified — the kind of change that SHOULD still warn.
    writeFileSync(join(wtReal, 'README.md'), 'changed\n');
    const out = git(['status', '--porcelain'], wtReal);
    // porcelain v1 is `XY <file>`; an unstaged modification is ` M`, trimmed to `M`.
    assert.equal(out.trim(), 'M README.md', 'tracked change must still be reported');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ensureWorktreeExclude is a no-op when the pattern list is empty', () => {
  const repo = mkdtempSync(join(tmpdir(), 'wt-exc-'));
  try {
    git(['init', '-q'], repo);
    git(['config', 'user.email', 't@t.t'], repo);
    git(['config', 'user.name', 't'], repo);
    writeFileSync(join(repo, 'README.md'), 'x\n');
    git(['add', 'README.md'], repo);
    git(['commit', '-qm', 'init'], repo);
    const before = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    ensureWorktreeExclude(repo, []);
    const after = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    assert.equal(after, before);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

finish();
