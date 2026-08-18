// Tests for the Draft-MR title/description renderer.
//
// Covers the pure surface main.ts consumes at publish time: the issue-closure
// decision (issue #27 — close on the default branch, say why not on any other
// base) and its place in the assembled description. Pure: no network, no CLI,
// no process.env.
// Run: npx tsx .sandcastle/mr-body.test.ts
import assert from 'node:assert/strict';
import {
  decideIssueClosure,
  buildMrDescription,
  type MrBodyInput,
} from './mr-body.ts';
import { test, finish } from './test-harness.ts';

// The host-recognized closing keywords, a CLOSED list (close/closes/closed,
// fix/fixes/fixed, resolve/resolves/resolved) with no translatable equivalent —
// the fact issue #27 turns into the "never translate the keyword" rule. A French
// « Ferme #5 » creates the cross-link but closes nothing.
const KEYWORDS = [
  'close', 'closes', 'closed',
  'fix', 'fixes', 'fixed',
  'resolve', 'resolves', 'resolved',
];

/** Every keyword of the closed list that opens a line followed by an issue ref. */
const keywordsIn = (text: string): string[] =>
  KEYWORDS.filter((keyword) => new RegExp(`^${keyword}\\s+#\\d+`, 'im').test(text));

// --- decideIssueClosure ----------------------------------------------------

test('base = default branch → the MR closes its issue, with a recognized keyword', () => {
  const d = decideIssueClosure('main', 'main', 27);
  assert.equal(d.closes, true);
  assert.match(d.line, /^Closes #27\b/);
  assert.deepEqual(keywordsIn(d.line), ['closes']);
});

test('base ≠ default (staging) → no closure; the note names the base, the issue, the default branch and who owns closure', () => {
  const d = decideIssueClosure('staging/v1', 'main', 17);
  assert.equal(d.closes, false);
  assert.ok(d.line.includes('`staging/v1`'), 'names the targeted base');
  assert.ok(d.line.includes('#17'), 'names the issue');
  assert.ok(d.line.includes('`main`'), 'names the default branch');
  assert.ok(d.line.includes('`staging/v1 → main`'), 'says closure falls to the base→default MR');
  assert.ok(d.line.includes('à la main'), 'says closure can be done by hand');
});

test('a stacked base (chained stage) is not the default branch either → no closure', () => {
  const d = decideIssueClosure('sandcastle/issue-26-r3', 'main', 27);
  assert.equal(d.closes, false);
  assert.ok(d.line.includes('`sandcastle/issue-26-r3`'));
  assert.ok(d.line.includes('#27'));
});

test('the keyword is never translated — the note carries none of the closed list', () => {
  const closing = decideIssueClosure('main', 'main', 27).line;
  const note = decideIssueClosure('staging/v1', 'main', 27).line;
  assert.deepEqual(keywordsIn(closing), ['closes']);
  assert.deepEqual(keywordsIn(note), []);
});

// --- buildMrDescription: the closure line in the assembled body -------------

const ISSUE_27 = {
  number: 27,
  title: 'Le corps de MR dit s’il ferme l’issue, et pourquoi il ne la ferme pas',
  url: 'https://github.com/softnextapp/software-factory/issues/27',
  labels: ['enhancement', 'ready-for-agent'],
};

/** A minimal valid MrBodyInput; every case overrides just what it exercises. */
const input = (over: Partial<MrBodyInput> = {}): MrBodyInput => ({
  issue: ISSUE_27,
  branch: 'sandcastle/issue-27-mr-body-closure-r1',
  base: 'main',
  defaultBranch: 'main',
  summary: null,
  review: { reviewed: false },
  commits: [{ sha: 'a1b2c3d', subject: 'feat(chain): add the closure decision (#27)' }],
  diffstat: {
    files: [{ path: '.sandcastle/mr-body.ts', added: 48, removed: 1 }],
    omitted: 0,
    insertions: 48,
    deletions: 1,
  },
  run: {
    profile: 'split',
    implementerModel: 'glm-5.2[1m]',
    reviewerModel: 'claude-opus-5',
    round: 1,
  },
  ...over,
});

test('a body targeting the default branch carries the closure keyword right under the header', () => {
  const body = buildMrDescription(input());
  // The keyword line must be there verbatim — it is what the host parses at merge.
  assert.ok(body.includes(decideIssueClosure('main', 'main', 27).line));
  // High in the body, directly after the identity table, so the reviewer reads
  // "what happens to the issue" before anything authored.
  assert.ok(body.indexOf('Closes #27') < body.indexOf('## Comment tester'));
});

test('a body targeting another base carries the why-not note and NO closing keyword anywhere', () => {
  const body = buildMrDescription(input({ base: 'staging/v1' }));
  assert.ok(body.includes(decideIssueClosure('staging/v1', 'main', 27).line));
  assert.deepEqual(keywordsIn(body), []);
});

test('the closure line is host-derived: it renders even with no agent summary at all', () => {
  const body = buildMrDescription(input({ base: 'staging/v1', summary: null }));
  assert.ok(body.includes('elle ne fermera **pas** #27'));
});

test('on a stacked base the closure note sits right after the header, before the stack note', () => {
  const body = buildMrDescription(input({ base: 'sandcastle/issue-26-r3' }));
  const closureAt = body.indexOf('**Fermeture de l’issue**');
  const stackAt = body.indexOf('MR empilée');
  assert.ok(closureAt !== -1, 'closure note present');
  assert.ok(stackAt !== -1, 'stack note present');
  assert.ok(closureAt < stackAt, 'closure read before the merge-order advice');
});

finish();
